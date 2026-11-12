package cmd

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

type runEnvelope struct {
	OK   bool `json:"ok"`
	Data struct {
		Summary struct {
			Scheduled int `json:"scheduled"`
			Passed    int `json:"passed"`
			Cached    int `json:"cached"`
			Failed    int `json:"failed"`
		} `json:"summary"`
		SkippedBuilds []string `json:"skippedBuilds"`
	} `json:"data"`
}

func buildDevkitBinary(t *testing.T, flags ...string) string {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate command test source")
	}
	binary := filepath.Join(t.TempDir(), "kb-devkit")
	build := exec.Command("go", append(append([]string{"build"}, flags...), "-o", binary, ".")...)
	build.Dir = filepath.Dir(filepath.Dir(source))
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\n%s", err, output)
	}
	return binary
}

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	command.Dir = dir
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}

// sharedCacheFixture is a committed repository with four independent packages,
// whose build command appends to a log outside every worktree.
func sharedCacheFixture(t *testing.T) (main, runsLog string) {
	t.Helper()
	base := t.TempDir()
	main = filepath.Join(base, "main")
	runsLog = filepath.Join(base, "runs.log")
	writeRunFixture(t, filepath.Join(main, "package.json"), `{"workspaces":["packages/*"]}`)
	names := []string{"a", "b", "c", "d"}
	for _, name := range names {
		writeRunFixture(t, filepath.Join(main, "packages", name, "package.json"), `{"name":"@fixture/`+name+`"}`)
		writeRunFixture(t, filepath.Join(main, "packages", name, "src", "index.ts"), "export const "+name+" = 1\n")
	}
	writeRunFixture(t, filepath.Join(main, "devkit.yaml"), "workspace:\n"+
		"  categories:\n"+
		"    libraries:\n"+
		"      match: [\"packages/*\"]\n"+
		"      preset: node-lib\n"+
		"tasks:\n"+
		"  build:\n"+
		"    - categories: [libraries]\n"+
		"      command: 'sh -c \"echo run >> "+runsLog+"; mkdir -p dist && cp src/index.ts dist/index.js && sleep 1\"'\n"+
		"      inputs: [\"src/**\", \"package.json\"]\n"+
		"      outputs: [\"dist/**\"]\n")
	gitCmd(t, main, "init", "-q")
	gitCmd(t, main, "add", "--all")
	gitCmd(t, main, "commit", "-q", "-m", "fixture")
	return main, runsLog
}

func runDevkit(t *testing.T, binary, dir string, home string, args ...string) (int, []byte, []byte) {
	t.Helper()
	command := exec.Command(binary, args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "HOME="+home, "NO_COLOR=1", "TERM=dumb")
	stdout, err := command.Output()
	if err == nil {
		return 0, stdout, nil
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode(), stdout, exit.Stderr
	}
	t.Fatalf("run kb-devkit: %v", err)
	return -1, nil, nil
}

func decodeRun(t *testing.T, stdout []byte) runEnvelope {
	t.Helper()
	var envelope runEnvelope
	if err := json.Unmarshal(stdout, &envelope); err != nil {
		t.Fatalf("decode run JSON %q: %v", stdout, err)
	}
	return envelope
}

func countRuns(t *testing.T, runsLog string) int {
	t.Helper()
	data, err := os.ReadFile(runsLog)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "run\n")
}

// case: S-179.45
func TestSecondWorktreeReusesTheFirstWorktreesBuildOutputs(t *testing.T) {
	main, runsLog := sharedCacheFixture(t)
	second := filepath.Join(filepath.Dir(main), "second")
	gitCmd(t, main, "worktree", "add", "-q", second, "-b", "second")
	home := t.TempDir()
	// Worktrees routinely run differently built devkit binaries; the shared
	// store must not split on binary bytes.
	first := buildDevkitBinary(t)
	other := buildDevkitBinary(t, "-ldflags=-s -w")

	code, out, stderr := runDevkit(t, first, main, home, "run", "build", "--json")
	if code != 0 {
		t.Fatalf("first build: exit=%d stdout=%s stderr=%s", code, out, stderr)
	}
	if got := decodeRun(t, out); got.Data.Summary.Passed != 4 || got.Data.Summary.Cached != 0 {
		t.Fatalf("first build summary = %+v, want 4 executed", got.Data.Summary)
	}

	code, out, stderr = runDevkit(t, other, second, home, "run", "build", "--json")
	if code != 0 {
		t.Fatalf("second build: exit=%d stdout=%s stderr=%s", code, out, stderr)
	}
	got := decodeRun(t, out)
	if got.Data.Summary.Cached != 4 || got.Data.Summary.Scheduled != 4 {
		t.Fatalf("second worktree summary = %+v, want every task a cache hit", got.Data.Summary)
	}
	if runs := countRuns(t, runsLog); runs != 4 {
		t.Fatalf("build command ran %d times, want 4 (only the first worktree executes)", runs)
	}
	restored := filepath.Join(second, "packages", "a", "dist", "index.js")
	if data, err := os.ReadFile(restored); err != nil || string(data) != "export const a = 1\n" {
		t.Fatalf("restored output = %q, %v", data, err)
	}

	// The shared store lives with the repository; per-worktree state does not.
	if _, err := os.Stat(filepath.Join(main, ".git", "kb-devkit", "objects")); err != nil {
		t.Fatalf("shared store missing from the git common directory: %v", err)
	}
	for _, shared := range []string{"objects", "tasks"} {
		if _, err := os.Stat(filepath.Join(second, ".kb", "devkit", shared)); err == nil {
			t.Fatalf("worktree has its own %s store", shared)
		}
	}
	if _, err := os.Stat(filepath.Join(main, ".kb", "devkit", "state")); err != nil {
		t.Fatalf("the executing worktree's task state missing: %v", err)
	}

	// Rewriting restored files in a worktree never reaches the store.
	if err := os.WriteFile(restored, []byte("rewritten"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out, stderr = runDevkit(t, first, second, home, "doctor", "--verify-cache")
	if code != 0 || !strings.Contains(string(out), filepath.Join(main, ".git", "kb-devkit")) || !strings.Contains(string(out), "verified") {
		t.Fatalf("doctor --verify-cache: exit=%d stdout=%s stderr=%s", code, out, stderr)
	}
}

// case: S-179.46
func TestConcurrentBuildsInTwoWorktreesShareOneVerifiedStore(t *testing.T) {
	main, _ := sharedCacheFixture(t)
	var worktrees []string
	for _, name := range []string{"left", "right"} {
		dir := filepath.Join(filepath.Dir(main), name)
		gitCmd(t, main, "worktree", "add", "-q", dir, "-b", name)
		worktrees = append(worktrees, dir)
	}
	binary := buildDevkitBinary(t)
	home := t.TempDir()

	var wg sync.WaitGroup
	type outcome struct {
		code   int
		stdout []byte
		stderr []byte
	}
	outcomes := make([]outcome, len(worktrees))
	for index, dir := range worktrees {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, out, stderr := runDevkit(t, binary, dir, home, "run", "build", "--json", "--no-cache")
			outcomes[index] = outcome{code, out, stderr}
		}()
	}
	wg.Wait()
	for index, got := range outcomes {
		if got.code != 0 {
			t.Fatalf("worktree %s: exit=%d stdout=%s stderr=%s", worktrees[index], got.code, got.stdout, got.stderr)
		}
	}
	code, out, stderr := runDevkit(t, binary, main, home, "doctor", "--verify-cache")
	if code != 0 || !strings.Contains(string(out), "verified") {
		t.Fatalf("store does not verify after concurrent builds: exit=%d stdout=%s stderr=%s", code, out, stderr)
	}
}

// case: S-179.48
func TestPlainBuildSkipsProductAppsAndSaysSo(t *testing.T) {
	main, _ := sharedCacheFixture(t)
	config, err := os.ReadFile(filepath.Join(main, "devkit.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	writeRunFixture(t, filepath.Join(main, "devkit.yaml"), strings.Replace(string(config), "      match: [\"packages/*\"]\n      preset: node-lib\n",
		"      match: [\"packages/a\", \"packages/b\", \"packages/c\"]\n      preset: node-lib\n    site:\n      match: [\"packages/d\"]\n      preset: node-lib\n      defaultBuild: false\n", 1)+"")
	// `site` must also build: it shares the library task.
	writeRunFixture(t, filepath.Join(main, "devkit.yaml"), strings.Replace(mustRead(t, filepath.Join(main, "devkit.yaml")), "categories: [libraries]", "categories: [libraries, site]", 1))
	gitCmd(t, main, "commit", "-q", "-am", "product app")
	binary := buildDevkitBinary(t)
	home := t.TempDir()

	code, out, stderr := runDevkit(t, binary, main, home, "run", "build", "--json")
	if code != 0 {
		t.Fatalf("plain build: exit=%d stdout=%s stderr=%s", code, out, stderr)
	}
	got := decodeRun(t, out)
	if got.Data.Summary.Scheduled != 3 || len(got.Data.SkippedBuilds) != 1 || got.Data.SkippedBuilds[0] != "@fixture/d" {
		t.Fatalf("plain build scheduled %d, skipped %v; want 3 libraries built and @fixture/d reported", got.Data.Summary.Scheduled, got.Data.SkippedBuilds)
	}
	code, human, stderr := runDevkit(t, binary, main, home, "run", "build")
	if code != 0 || !strings.Contains(string(human)+string(stderr), "skipped build of 1 product app packages") ||
		!strings.Contains(string(human)+string(stderr), "kb-devkit run build --packages @fixture/d") {
		t.Fatalf("human output does not say what was skipped: exit=%d stdout=%s stderr=%s", code, human, stderr)
	}
	code, out, stderr = runDevkit(t, binary, main, home, "run", "build", "--packages", "@fixture/d", "--json")
	if code != 0 {
		t.Fatalf("targeted build: exit=%d stdout=%s stderr=%s", code, out, stderr)
	}
	if got := decodeRun(t, out); got.Data.Summary.Scheduled != 1 || len(got.Data.SkippedBuilds) != 0 {
		t.Fatalf("targeted build = %+v", got.Data)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
