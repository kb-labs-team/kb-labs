package cmd

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// case: S-179.18, S-179.38
func TestBuiltBinaryReportsFailureRetriesAndCachedRecovery(t *testing.T) {
	root := t.TempDir()
	writeRunFixture(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	writeRunFixture(t, filepath.Join(root, "packages", "core", "package.json"), `{"name":"@fixture/core"}`)
	writeRunFixture(t, filepath.Join(root, "packages", "middle", "package.json"), `{"name":"@fixture/middle","dependencies":{"@fixture/core":"workspace:*"}}`)
	writeRunFixture(t, filepath.Join(root, "packages", "app", "package.json"), `{"name":"@fixture/app","dependencies":{"@fixture/middle":"workspace:*"}}`)
	config := "workspace:\n" +
		"  categories:\n" +
		"    core:\n" +
		"      match: [\"packages/core\"]\n" +
		"      preset: node-lib\n" +
		"    libraries:\n" +
		"      match: [\"packages/middle\", \"packages/app\"]\n" +
		"      preset: node-lib\n" +
		"tasks:\n" +
		"  build:\n" +
		"    - categories: [core]\n" +
		"      command: 'sh -c \"echo run >> ../runs.log; test -f ../dependency.ready\"'\n" +
		"      outputs: [\"dist/**\"]\n" +
		"    - categories: [libraries]\n" +
		"      command: 'mkdir -p dist && echo built > dist/output.txt'\n" +
		"      deps: [\"^build\"]\n" +
		"      inputs: [\"^dist/**\"]\n" +
		"      outputs: [\"dist/**\"]\n"
	writeRunFixture(t, filepath.Join(root, "devkit.yaml"), config)

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate command test source")
	}
	moduleRoot := filepath.Dir(filepath.Dir(source))
	binary := filepath.Join(t.TempDir(), "kb-devkit")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\n%s", err, output)
	}

	isolatedHome := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(isolatedHome, 0o755); err != nil {
		t.Fatalf("create isolated HOME: %v", err)
	}
	runsPath := filepath.Join(root, "packages", "runs.log")
	run := func(args ...string) (int, []byte, []byte) {
		t.Helper()
		command := exec.Command(binary, append([]string{"run", "build", "--packages", "@fixture/app"}, args...)...)
		command.Dir = root
		command.Env = append(os.Environ(), "HOME="+isolatedHome, "NO_COLOR=1", "TERM=dumb")
		stdout, err := command.Output()
		if err == nil {
			return 0, stdout, nil
		}
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode(), stdout, exit.Stderr
		}
		t.Fatalf("run built kb-devkit: %v", err)
		return -1, nil, nil
	}
	readRunCount := func() int {
		t.Helper()
		data, err := os.ReadFile(runsPath)
		if err != nil {
			t.Fatalf("read execution log: %v", err)
		}
		return strings.Count(string(data), "run\n")
	}
	assertCounts := func(summary struct {
		Scheduled   int `json:"scheduled"`
		Passed      int `json:"passed"`
		Cached      int `json:"cached"`
		Failed      int `json:"failed"`
		Blocked     int `json:"blocked"`
		NotAffected int `json:"notAffected"`
	}, total, passed, cached, failed, blocked, notAffected int) {
		t.Helper()
		if summary.Scheduled != total || summary.Passed != passed || summary.Cached != cached || summary.Failed != failed || summary.Blocked != blocked || summary.NotAffected != notAffected {
			t.Fatalf("summary = %+v, want total=%d passed=%d cached=%d failed=%d blocked=%d notAffected=%d", summary, total, passed, cached, failed, blocked, notAffected)
		}
		if summary.Passed+summary.Cached+summary.Failed+summary.Blocked != summary.Scheduled {
			t.Fatalf("summary counts do not partition total: %+v", summary)
		}
	}

	// The first human failure establishes the readable task name and summary.
	code, human, stderr := run()
	if code != 1 || !strings.Contains(string(human), "@fixture/core") ||
		!strings.Contains(string(human), "0 passed") || !strings.Contains(string(human), "0 cached") ||
		!strings.Contains(string(human), "1 failed") || !strings.Contains(string(human), "2 blocked") {
		t.Fatalf("first human failure: exit=%d stdout=%s stderr=%s", code, human, stderr)
	}
	if readRunCount() != 1 {
		t.Fatalf("first failure execution count = %d, want 1", readRunCount())
	}

	// An unchanged JSON retry must execute the failed task instead of replaying it.
	code, output, stderr := run("--json")
	if code != 1 || len(stderr) != 0 {
		t.Fatalf("second JSON failure: exit=%d stdout=%s stderr=%s", code, output, stderr)
	}
	var failure struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string         `json:"code"`
			Hint    string         `json:"hint"`
			Details map[string]any `json:"details"`
		} `json:"error"`
		Data struct {
			Results []struct {
				Package string `json:"package"`
				Cached  bool   `json:"cached"`
				OK      bool   `json:"ok"`
				LogPath string `json:"logPath"`
			} `json:"results"`
			Summary struct {
				Scheduled   int `json:"scheduled"`
				Passed      int `json:"passed"`
				Cached      int `json:"cached"`
				Failed      int `json:"failed"`
				Blocked     int `json:"blocked"`
				NotAffected int `json:"notAffected"`
			} `json:"summary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(output, &failure); err != nil {
		t.Fatalf("decode failed-run JSON %q: %v", output, err)
	}
	if failure.OK || failure.Error.Code != "KB_DEVKIT_TASK_FAILED" || len(failure.Data.Results) != 1 ||
		failure.Data.Results[0].Package != "@fixture/core" || failure.Data.Results[0].Cached || failure.Data.Results[0].OK {
		t.Fatalf("second failed-run JSON = %+v", failure)
	}
	failed := failure.Data.Results[0]
	expected := renderCatalogEnvelope(t, "KB_DEVKIT_TASK_FAILED", map[string]any{
		"package": failed.Package, "task": "build", "logPath": failed.LogPath,
	})
	if failed.LogPath == "" || failure.Error.Details["package"] != failed.Package ||
		failure.Error.Details["task"] != "build" || failure.Error.Details["logPath"] != failed.LogPath ||
		failure.Error.Code != "KB_DEVKIT_TASK_FAILED" || failure.Error.Hint != expected.Hint {
		t.Fatalf("task failure diagnosis = %+v, logPath=%q", failure.Error, failed.LogPath)
	}
	if log, err := exec.Command("cat", failed.LogPath).Output(); err != nil || !strings.Contains(string(log), "command exited with code 1") {
		t.Fatalf("read failed task log with its recovery action at %q = %q, error = %v", failed.LogPath, log, err)
	}
	assertCounts(failure.Data.Summary, 3, 0, 0, 1, 2, 0)
	if readRunCount() != 2 {
		t.Fatalf("unchanged failure execution count = %d, want 2", readRunCount())
	}

	if err := os.WriteFile(filepath.Join(root, "packages", "dependency.ready"), nil, 0o644); err != nil {
		t.Fatalf("create dependency artifact: %v", err)
	}
	code, human, stderr = run()
	if code != 0 || !strings.Contains(string(human), "3 passed") || !strings.Contains(string(human), "0 cached") ||
		!strings.Contains(string(human), "0 failed") || !strings.Contains(string(human), "0 blocked") {
		t.Fatalf("recovered human run: exit=%d stdout=%s stderr=%s", code, human, stderr)
	}
	code, output, stderr = run("--json")
	if code != 0 || len(stderr) != 0 {
		t.Fatalf("cached JSON success: exit=%d stdout=%s stderr=%s", code, output, stderr)
	}
	var success struct {
		OK   bool `json:"ok"`
		Data struct {
			Results []struct {
				Cached bool `json:"cached"`
			} `json:"results"`
			Summary struct {
				Scheduled   int `json:"scheduled"`
				Passed      int `json:"passed"`
				Cached      int `json:"cached"`
				Failed      int `json:"failed"`
				Blocked     int `json:"blocked"`
				NotAffected int `json:"notAffected"`
			} `json:"summary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(output, &success); err != nil {
		t.Fatalf("decode successful-run JSON %q: %v", output, err)
	}
	if !success.OK || len(success.Data.Results) != 3 {
		t.Fatalf("cached successful-run JSON = %+v", success)
	}
	for _, result := range success.Data.Results {
		if !result.Cached {
			t.Fatalf("successful task was not cached in final run: %+v", success.Data.Results)
		}
	}
	assertCounts(success.Data.Summary, 3, 0, 3, 0, 0, 0)
}

// case: S-179.23, S-261.6
func TestRunSummaryPartitionsScheduledTasksAndCountsBlockedDependents(t *testing.T) {
	root := t.TempDir()
	writeRunFixture(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	writeRunFixture(t, filepath.Join(root, "packages", "core", "package.json"), `{"name":"@fixture/core"}`)
	writeRunFixture(t, filepath.Join(root, "packages", "middle", "package.json"), `{"name":"@fixture/middle","dependencies":{"@fixture/core":"workspace:*"}}`)
	writeRunFixture(t, filepath.Join(root, "packages", "app", "package.json"), `{"name":"@fixture/app","dependencies":{"@fixture/middle":"workspace:*"}}`)
	writeRunFixture(t, filepath.Join(root, "devkit.yaml"), "workspace:\n"+
		"  categories:\n"+
		"    core:\n"+
		"      match: [\"packages/core\"]\n"+
		"      preset: node-lib\n"+
		"    libraries:\n"+
		"      match: [\"packages/middle\", \"packages/app\"]\n"+
		"      preset: node-lib\n"+
		"tasks:\n"+
		"  build:\n"+
		"    - categories: [core]\n"+
		"      command: 'false'\n"+
		"    - categories: [libraries]\n"+
		"      command: 'true'\n"+
		"      deps: [\"^build\"]\n")

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate command test source")
	}
	moduleRoot := filepath.Dir(filepath.Dir(source))
	tool := filepath.Join(t.TempDir(), "kb-devkit")
	build := exec.Command("go", "build", "-o", tool, ".")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\n%s", err, output)
	}
	humanCommand := exec.Command(tool, "run", "build")
	humanCommand.Dir = root
	humanCommand.Env = append(os.Environ(), "HOME="+filepath.Join(t.TempDir(), "home"), "NO_COLOR=1", "TERM=dumb")
	humanOutput, humanErr := humanCommand.Output()
	humanExit, humanFailed := humanErr.(*exec.ExitError)
	if !humanFailed || humanExit.ExitCode() != 1 || !strings.Contains(string(humanOutput), "3 scheduled") ||
		!strings.Contains(string(humanOutput), "1 failed") || !strings.Contains(string(humanOutput), "2 blocked") ||
		!strings.Contains(string(humanOutput), "@fixture/middle:build blocked-by @fixture/core:build") ||
		!strings.Contains(string(humanOutput), "@fixture/app:build blocked-by @fixture/core:build") {
		var humanStderr []byte
		if humanExit != nil {
			humanStderr = humanExit.Stderr
		}
		t.Fatalf("human failed run: exit=%v stdout=%s stderr=%s", humanErr, humanOutput, humanStderr)
	}
	command := exec.Command(tool, "run", "build", "--json")
	command.Dir = root
	command.Env = append(os.Environ(), "HOME="+filepath.Join(t.TempDir(), "home"))
	output, err := command.Output()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("failed built run exit = %v; stdout=%s", err, output)
	}
	var payload struct {
		Error struct {
		} `json:"error"`
		Data struct {
			Summary struct {
				Scheduled    int `json:"scheduled"`
				Passed       int `json:"passed"`
				Cached       int `json:"cached"`
				Failed       int `json:"failed"`
				Blocked      int `json:"blocked"`
				NotAffected  int `json:"notAffected"`
				BlockedTasks []struct {
					Package          string `json:"package"`
					Task             string `json:"task"`
					BlockedByPackage string `json:"blockedByPackage"`
					BlockedByTask    string `json:"blockedByTask"`
				} `json:"blockedTasks"`
			} `json:"summary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		t.Fatalf("decode failed-run JSON %q: %v", output, err)
	}
	summary := payload.Data.Summary
	if summary.Scheduled != 3 || summary.Passed != 0 || summary.Cached != 0 || summary.Failed != 1 || summary.Blocked != 2 || summary.NotAffected != 0 {
		t.Fatalf("failed-run summary = %#v, want scheduled=3 failed=1 blocked=2", summary)
	}
	if summary.Passed+summary.Cached+summary.Failed+summary.Blocked != summary.Scheduled {
		t.Fatalf("summary does not partition scheduled tasks: %#v", summary)
	}
	if len(summary.BlockedTasks) != 2 || summary.BlockedTasks[0].BlockedByPackage != "@fixture/core" ||
		summary.BlockedTasks[0].BlockedByTask != "build" {
		t.Fatalf("blocked task details = %+v, want two tasks blocked by @fixture/core:build", summary.BlockedTasks)
	}
}

// case: S-179.20, S-179.21, S-179.22
func TestBuiltBinaryRunsUnfilteredBuildAcrossWorkspace(t *testing.T) {
	root := t.TempDir()
	writeRunFixture(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	writeRunFixture(t, filepath.Join(root, "packages", "one", "package.json"), `{"name":"@fixture/one"}`)
	writeRunFixture(t, filepath.Join(root, "packages", "two", "package.json"), `{"name":"@fixture/two"}`)
	writeRunFixture(t, filepath.Join(root, "devkit.yaml"), "workspace:\n"+
		"  categories:\n"+
		"    fixture:\n"+
		"      match: [\"packages/*\"]\n"+
		"tasks:\n"+
		"  build:\n"+
		"    - command: 'true'\n")
	writeRunFixture(t, filepath.Join(root, ".gitignore"), ".kb/\n")
	for _, args := range [][]string{
		{"init", "--quiet"},
		{"add", "--all"},
		{"-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"},
	} {
		git := exec.Command("git", args...)
		git.Dir = root
		if output, err := git.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
	}

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate command test source")
	}
	moduleRoot := filepath.Dir(filepath.Dir(source))
	binary := filepath.Join(t.TempDir(), "kb-devkit")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\n%s", err, output)
	}

	isolatedHome := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(isolatedHome, 0o755); err != nil {
		t.Fatalf("create isolated HOME: %v", err)
	}
	command := exec.Command(binary, "run", "build", "--no-cache", "--json")
	command.Dir = root
	command.Env = append(os.Environ(), "HOME="+isolatedHome)
	output, err := command.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			t.Fatalf("built binary failed: %v\nstdout: %s\nstderr: %s", err, output, exit.Stderr)
		}
		t.Fatalf("run built binary: %v", err)
	}

	var payload struct {
		Data struct {
			Results []struct {
				Package string `json:"package"`
				OK      bool   `json:"ok"`
			} `json:"results"`
			Summary struct {
				Scheduled int `json:"scheduled"`
				Failed    int `json:"failed"`
			} `json:"summary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		t.Fatalf("decode built binary output %q: %v", output, err)
	}
	if payload.Data.Summary.Scheduled != 2 || payload.Data.Summary.Failed != 0 || len(payload.Data.Results) != 2 {
		t.Fatalf("unfiltered build summary/results = %+v, want two successful package results", payload.Data)
	}
	results := make(map[string]bool, len(payload.Data.Results))
	for _, result := range payload.Data.Results {
		results[result.Package] = result.OK
	}
	if len(results) != 2 || !results["@fixture/one"] || !results["@fixture/two"] {
		t.Fatalf("unfiltered build results = %+v, want successful @fixture/one and @fixture/two", payload.Data.Results)
	}

	noChanges := exec.Command(binary, "run", "build", "--affected", "--diff-only", "--json")
	noChanges.Dir = root
	noChanges.Env = append(os.Environ(), "HOME="+isolatedHome)
	noChangesOutput, err := noChanges.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			t.Fatalf("built binary --affected with empty change set: %v\nstdout: %s\nstderr: %s", err, noChangesOutput, exitErr.Stderr)
		}
		t.Fatalf("built binary --affected with empty change set: %v\n%s", err, noChangesOutput)
	}
	if !strings.Contains(string(noChangesOutput), "No affected or dirty packages") {
		t.Fatalf("empty affected result = %s, want documented no-op", noChangesOutput)
	}

	for _, input := range []struct {
		args    []string
		message string
		hint    string
	}{
		{
			args:    []string{"run", "build", "--packages", "@missing/package", "--json"},
			message: "No workspace packages match",
			hint:    "kb-devkit deps",
		},
		{
			args:    []string{"run", "missing-task", "--json"},
			message: "Task \"missing-task\" is not declared in devkit.yaml.",
			hint:    "kb-devkit run build",
		},
	} {
		command := exec.Command(binary, input.args...)
		command.Dir = root
		command.Env = append(os.Environ(), "HOME="+isolatedHome)
		output, err := command.Output()
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != 2 {
			t.Fatalf("built binary %v exit = %v; stdout=%s", input.args, err, output)
		}
		if strings.Contains(string(exit.Stderr), "stack") {
			t.Fatalf("built binary %v printed a stack: %s", input.args, exit.Stderr)
		}
		var failure struct {
			OK    bool `json:"ok"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Hint    string `json:"hint"`
			} `json:"error"`
		}
		if err := json.Unmarshal(output, &failure); err != nil {
			t.Fatalf("decode %v output %q: %v", input.args, output, err)
		}
		if failure.OK || failure.Error.Code != "KB_RUNTIME_INPUT_INVALID" ||
			!strings.Contains(failure.Error.Message, input.message) || !strings.Contains(failure.Error.Hint, input.hint) {
			t.Fatalf("built binary %v diagnosis = %+v, want catalogued actionable input error", input.args, failure)
		}
	}
}

func writeRunFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if filepath.Base(path) == "package.json" && strings.Contains(content, "\"workspaces\"") {
		command := exec.Command("git", "-C", filepath.Dir(path), "init", "--quiet")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("initialize run fixture repository: %v: %s", err, output)
		}
	}
	root := filepath.Dir(path)
	for {
		if _, err := os.Stat(filepath.Join(root, ".git")); err == nil {
			command := exec.Command("git", "-C", root, "add", "--all")
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("track run fixture files: %v: %s", err, output)
			}
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			break
		}
		root = parent
	}
}
