package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/config"
)

// hermeticFixture is a one-package workspace whose build command writes the
// given shell script's output into dist/.
func hermeticFixture(t *testing.T, root string, build config.TaskVariant) (*config.DevkitConfig, string) {
	t.Helper()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	writePkg(t, pkgDir, `{"name":"@kb/app"}`)
	writeEngineFile(t, filepath.Join(pkgDir, "src", "index.ts"), "export const v = 1\n")
	// Build outputs and devkit's own state are untracked in a real repository;
	// without this, mustWorkspace's `git add --all` would make them inputs.
	writeEngineFile(t, filepath.Join(root, ".gitignore"), "dist/\n.kb/\n")
	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	if build.Inputs == nil {
		build.Inputs = []string{"src/**", "package.json"}
	}
	cfg.Tasks = map[string]config.TaskConfig{"build": {build}}
	return cfg, pkgDir
}

func runBuild(t *testing.T, root string, cfg *config.DevkitConfig) RunResult {
	t.Helper()
	ws := mustWorkspace(t, root, cfg)
	result, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: filepath.Join(root, ".kb", "devkit")})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return result
}

// case: S-179.51
func TestTaskEnvironmentIsAllowListedAndHashed(t *testing.T) {
	root := t.TempDir()
	cfg, pkgDir := hermeticFixture(t, root, config.TaskVariant{
		Command: `sh seen.sh`,
		Env:     []string{"KB_ALLOWED"},
		Outputs: []string{"dist/**"},
	})
	writeEngineFile(t, filepath.Join(pkgDir, "seen.sh"), "mkdir -p dist\nprintf '%s|%s' \"$KB_ALLOWED\" \"$KB_OTHER\" > dist/seen.txt\n")
	t.Setenv("KB_ALLOWED", "one")
	t.Setenv("KB_OTHER", "secret")

	if first := runBuild(t, root, cfg); !first.OK || first.Results[0].Cached {
		t.Fatalf("first build = %+v, want a fresh success", first)
	}
	seen, err := os.ReadFile(filepath.Join(pkgDir, "dist", "seen.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(seen) != "one|" {
		t.Fatalf("command saw %q; want the allow-listed variable and nothing else from the host", seen)
	}

	t.Setenv("KB_OTHER", "changed")
	if second := runBuild(t, root, cfg); !second.Results[0].Cached {
		t.Fatalf("changing a variable outside the allow-list missed the cache: %+v", second.Results[0])
	}
	t.Setenv("KB_ALLOWED", "two")
	third := runBuild(t, root, cfg)
	if !third.OK || third.Results[0].Cached {
		t.Fatalf("changing an allow-listed variable must miss; got %+v", third.Results[0])
	}
	seen, _ = os.ReadFile(filepath.Join(pkgDir, "dist", "seen.txt"))
	if string(seen) != "two|" {
		t.Fatalf("rebuild saw %q, want two|", seen)
	}
}

// case: S-179.51
func TestTaskEnvironmentAlwaysPassesToolchainVariables(t *testing.T) {
	t.Setenv("KB_NOT_PASSED", "x")
	t.Setenv("CI", "true")
	env := taskEnvironment(TaskDef{Env: []string{"KB_DECLARED"}})
	got := map[string]bool{}
	for _, kv := range env.run {
		got[strings.SplitN(kv, "=", 2)[0]] = true
	}
	for _, name := range alwaysPassedEnv {
		if _, present := os.LookupEnv(name); present && !got[name] {
			t.Errorf("%s is set on the host but not passed to the task", name)
		}
	}
	if got["KB_NOT_PASSED"] || got["CI"] {
		t.Errorf("undeclared host variables leaked into the task env: %v", env.run)
	}
	for _, kv := range env.hashed {
		name := strings.SplitN(kv, "=", 2)[0]
		for _, always := range alwaysPassedEnv {
			if name == always {
				t.Errorf("%s is machine-specific toolchain state and must not enter the key", name)
			}
		}
	}
}

// case: S-179.52
func TestStoreOutputsFailureFailsTaskAndWritesNoManifest(t *testing.T) {
	root := t.TempDir()
	cfg, _ := hermeticFixture(t, root, config.TaskVariant{
		Command: `sh -c "mkdir -p dist && printf out > dist/a.js"`,
		Outputs: []string{"dist/**"},
	})
	ws := mustWorkspace(t, root, cfg)
	shared, err := cache.SharedRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cache.NewLocalStore(shared); err != nil {
		t.Fatal(err)
	}
	objects := filepath.Join(shared, "objects")
	if err := os.Chmod(objects, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(objects, 0o755) })
	if probe, err := os.CreateTemp(objects, "probe-"); err == nil {
		probe.Close()
		t.Skip("store dir is writable despite chmod (running as root?)")
	}

	result, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: filepath.Join(root, ".kb", "devkit")})
	if err != nil {
		t.Fatal(err)
	}
	if result.OK || result.Results[0].OK {
		t.Fatalf("a task whose outputs could not be stored reported success: %+v", result.Results[0])
	}
	if manifests := manifestFiles(t, shared); len(manifests) != 0 {
		t.Fatalf("hollow manifest written: %v", manifests)
	}
}

// case: S-179.52
func TestTaskDeclaringOutputsThatMatchNothingFails(t *testing.T) {
	root := t.TempDir()
	cfg, _ := hermeticFixture(t, root, config.TaskVariant{
		Command: `true`,
		Outputs: []string{"dist/**"},
	})
	result := runBuild(t, root, cfg)
	if result.OK || result.Results[0].OK {
		t.Fatalf("a task declaring outputs that matched no file succeeded: %+v", result.Results[0])
	}
	if !strings.Contains(result.Results[0].Error, "dist/**") {
		t.Errorf("error %q does not name the pattern that matched nothing", result.Results[0].Error)
	}
	shared, _ := cache.SharedRoot(root)
	if manifests := manifestFiles(t, shared); len(manifests) != 0 {
		t.Fatalf("hollow manifest written: %v", manifests)
	}
}

// case: S-179.52
func TestManifestWithoutOutputsIsNotAHitForATaskThatDeclaresOutputs(t *testing.T) {
	root := t.TempDir()
	cfg, pkgDir := hermeticFixture(t, root, config.TaskVariant{
		Command: `sh -c "mkdir -p dist && printf out > dist/a.js"`,
		Outputs: []string{"dist/**"},
	})
	if first := runBuild(t, root, cfg); !first.OK {
		t.Fatalf("first build failed: %+v", first.Results[0])
	}
	shared, _ := cache.SharedRoot(root)
	for _, path := range manifestFiles(t, shared) {
		if err := os.WriteFile(path, []byte(`{"inputHash":"x","exitCode":0,"elapsed":"0s","outputs":[]}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.RemoveAll(filepath.Join(pkgDir, "dist")); err != nil {
		t.Fatal(err)
	}
	second := runBuild(t, root, cfg)
	if second.Results[0].Cached {
		t.Fatalf("an empty-output manifest was replayed as a hit: %+v", second.Results[0])
	}
	if _, err := os.Stat(filepath.Join(pkgDir, "dist", "a.js")); err != nil {
		t.Fatalf("dist was not rebuilt: %v", err)
	}
}

// case: S-179.53
func TestRestoreLeavesExactlyTheManifestFiles(t *testing.T) {
	root := t.TempDir()
	cfg, pkgDir := hermeticFixture(t, root, config.TaskVariant{
		Command: `sh -c "mkdir -p dist/sub && printf bin > dist/run.sh && chmod 755 dist/run.sh && printf lib > dist/sub/lib.js"`,
		Outputs: []string{"dist/**"},
	})
	if first := runBuild(t, root, cfg); !first.OK {
		t.Fatalf("first build failed: %+v", first.Results[0])
	}
	writeEngineFile(t, filepath.Join(pkgDir, "dist", "stale-from-older-build.js"), "old")
	writeEngineFile(t, filepath.Join(pkgDir, "dist", "sub", "stale.js"), "old")
	if err := os.Remove(filepath.Join(pkgDir, "dist", "run.sh")); err != nil {
		t.Fatal(err)
	}

	second := runBuild(t, root, cfg)
	if !second.Results[0].Cached {
		t.Fatalf("second build = %+v, want a cache hit", second.Results[0])
	}
	var files []string
	_ = filepath.WalkDir(filepath.Join(pkgDir, "dist"), func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(pkgDir, path)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(files)
	if got, want := strings.Join(files, ","), "dist/run.sh,dist/sub/lib.js"; got != want {
		t.Fatalf("after restore dist holds %s; want exactly %s", got, want)
	}
	info, err := os.Stat(filepath.Join(pkgDir, "dist", "run.sh"))
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("restored executable mode = %v (%v), want 0755", info, err)
	}
}

// case: S-179.54
func TestTaskAndOutputHashesAreIdenticalInTwoCheckoutPaths(t *testing.T) {
	type snapshot struct {
		keys    map[string]map[string]string
		outputs map[string]string
	}
	build := func(root string) snapshot {
		cfg, pkgDir := hermeticFixture(t, root, config.TaskVariant{
			Command: `sh -c "mkdir -p dist && printf 'built from %s\n' src/index.ts > dist/index.js && printf bin > dist/run.sh && chmod 755 dist/run.sh"`,
			Inputs:  []string{"src/**", "package.json", "^dist/**"},
			Outputs: []string{"dist/**"},
		})
		writeWorkspaceRoot(t, root, []string{"packages/*"})
		libDir := filepath.Join(root, "packages", "lib")
		writePkg(t, libDir, `{"name":"@kb/lib"}`)
		writePkg(t, pkgDir, `{"name":"@kb/app","dependencies":{"@kb/lib":"workspace:*"}}`)
		writeEngineFile(t, filepath.Join(libDir, "src", "index.ts"), "export const lib = 1\n")
		if result := runBuild(t, root, cfg); !result.OK {
			t.Fatalf("build in %s failed: %+v", root, result)
		}
		ws := mustWorkspace(t, root, cfg)
		snap := snapshot{keys: propertyTaskKeys(t, ws, []TaskDef{*ResolveTaskDef(cfg, "build", "")}), outputs: map[string]string{}}
		for _, pkg := range []string{"lib", "app"} {
			dist := filepath.Join(root, "packages", pkg, "dist")
			_ = filepath.WalkDir(dist, func(path string, d os.DirEntry, err error) error {
				if err == nil && !d.IsDir() {
					data, _ := os.ReadFile(path)
					sum := sha256.Sum256(data)
					rel, _ := filepath.Rel(root, path)
					snap.outputs[filepath.ToSlash(rel)] = hex.EncodeToString(sum[:])
				}
				return nil
			})
		}
		return snap
	}
	first := build(filepath.Join(t.TempDir(), "checkout-one"))
	second := build(filepath.Join(t.TempDir(), "a", "deeper", "checkout-two"))
	if len(first.outputs) == 0 || len(first.keys) == 0 {
		t.Fatalf("nothing was built or hashed: %+v", first)
	}
	for pkg, tasks := range first.keys {
		for task, key := range tasks {
			if second.keys[pkg][task] != key {
				t.Errorf("task key %s:%s differs between checkout paths", pkg, task)
			}
		}
	}
	for path, sum := range first.outputs {
		if second.outputs[path] != sum {
			t.Errorf("output %s differs between checkout paths", path)
		}
	}
}

func manifestFiles(t *testing.T, sharedRoot string) []string {
	t.Helper()
	var found []string
	_ = filepath.WalkDir(filepath.Join(sharedRoot, "tasks"), func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".json") {
			found = append(found, path)
		}
		return nil
	})
	return found
}

// A guard, not a red test: the key of every entry already contains
// cache.FormatVersion (executor.go taskFingerprint, cache.RuntimeFingerprint),
// so an entry written by an older format is unreachable by construction and
// breaking this rail would not turn this test red. What fails when the key shape
// changes without a bump is TestInputHashIsPinnedPerCacheFormatVersion; this
// test pins the other half: a leftover older entry on disk is ignored without error.
// case: S-179.56
func TestEntriesFromAnOlderFormatMissWithoutError(t *testing.T) {
	root := t.TempDir()
	cfg, pkgDir := hermeticFixture(t, root, config.TaskVariant{
		Command: `sh -c "mkdir -p dist && printf out > dist/a.js"`,
		Outputs: []string{"dist/**"},
	})
	shared, err := cache.SharedRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(shared, "tasks", "kb__app", "build")
	writeEngineFile(t, filepath.Join(legacy, "0000000000000000000000000000000000000000000000000000000000000000.json"),
		`{"inputHash":"0000","exitCode":0,"elapsed":"1s","outputs":[{"path":"dist/a.js","object":"deadbeef"}]}`)
	result := runBuild(t, root, cfg)
	if !result.OK || result.Results[0].Cached {
		t.Fatalf("an entry from an older format must miss and rebuild: %+v", result.Results[0])
	}
	if _, err := os.Stat(filepath.Join(pkgDir, "dist", "a.js")); err != nil {
		t.Fatal(err)
	}
}
