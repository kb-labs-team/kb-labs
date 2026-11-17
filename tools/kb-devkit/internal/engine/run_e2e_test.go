package engine

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/devkit/internal/testdeadline"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestRunCacheValidityFollowsWorkspaceOwnership(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	aDir := filepath.Join(root, "packages", "a")
	bDir := filepath.Join(root, "packages", "b")
	appDir := filepath.Join(root, "packages", "app")
	writePkg(t, aDir, `{"name":"@fixture/a","files":["src"]}`)
	writePkg(t, bDir, `{"name":"@fixture/b"}`)
	writePkg(t, appDir, `{"name":"@fixture/app","dependencies":{"@fixture/a":"workspace:*"}}`)
	writeEngineFile(t, filepath.Join(aDir, "src", "index.ts"), "export const value = 1\n")
	writeEngineFile(t, filepath.Join(bDir, "src", "index.ts"), "export const value = 1\n")
	writeEngineFile(t, filepath.Join(appDir, "src", "index.ts"), "export const app = true\n")
	writeEngineFile(t, filepath.Join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
	writeEngineFile(t, filepath.Join(root, "services", "tsconfig.base.json"), `{"compilerOptions":{"strict":true}}`)
	writeEngineFile(t, filepath.Join(root, "services", "vitest.config.ts"), "export default { test: { timeout: 1000 } }\n")
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	if output, err := exec.Command("git", "-C", root, "add", "--all").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, output)
	}

	cfg := testConfig([]config.NamedCategory{
		{Name: "a", Category: config.CategoryConfig{Match: []string{"packages/a"}, Preset: "node-lib"}},
		{Name: "b", Category: config.CategoryConfig{Match: []string{"packages/b"}, Preset: "node-lib"}},
		{Name: "app", Category: config.CategoryConfig{Match: []string{"packages/app"}, Preset: "node-lib"}},
	})
	// The test task reads ^dist from workspace dependencies, so declare the producer.
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: `sh -c "mkdir -p dist && printf ok > dist/out.txt"`, Inputs: []string{"src/**", "package.json", "^dist/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}}},
		"test":  {{Command: `sh -c "mkdir -p dist && printf ok > dist/out.txt"`, Inputs: []string{"src/**", "package.json", "^dist/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func() RunResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Tasks: []string{"build", "test"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		return result
	}
	assertCacheState := func(result RunResult, expected map[string]bool) {
		t.Helper()
		for _, task := range result.Results {
			if task.Cached != expected[task.Package] {
				t.Errorf("%s:%s cached=%t; want %t", task.Package, task.Task, task.Cached, expected[task.Package])
			}
		}
	}

	first := run()
	assertCacheState(first, map[string]bool{"@fixture/a": false, "@fixture/b": false, "@fixture/app": false})
	assertCacheState(run(), map[string]bool{"@fixture/a": true, "@fixture/b": true, "@fixture/app": true})
	writeEngineFile(t, filepath.Join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n# tracked lock change\n")
	assertCacheState(run(), map[string]bool{"@fixture/a": false, "@fixture/b": false, "@fixture/app": false})
	assertCacheState(run(), map[string]bool{"@fixture/a": true, "@fixture/b": true, "@fixture/app": true})
	writeEngineFile(t, filepath.Join(root, "services", "tsconfig.base.json"), `{"compilerOptions":{"strict":false}}`)
	assertCacheState(run(), map[string]bool{"@fixture/a": false, "@fixture/b": false, "@fixture/app": false})
	assertCacheState(run(), map[string]bool{"@fixture/a": true, "@fixture/b": true, "@fixture/app": true})
	writeEngineFile(t, filepath.Join(root, "services", "vitest.config.ts"), "export default { test: { timeout: 2000 } }\n")
	assertCacheState(run(), map[string]bool{"@fixture/a": false, "@fixture/b": false, "@fixture/app": false})
	assertCacheState(run(), map[string]bool{"@fixture/a": true, "@fixture/b": true, "@fixture/app": true})
	writeEngineFile(t, filepath.Join(aDir, "src", "index.ts"), "export const value = 2\n")
	assertCacheState(run(), map[string]bool{"@fixture/a": false, "@fixture/b": true, "@fixture/app": false})
	writeEngineFile(t, filepath.Join(aDir, "README.md"), "untracked file outside declared build inputs\n")
	assertCacheState(run(), map[string]bool{"@fixture/a": true, "@fixture/b": true, "@fixture/app": true})
}

// case: S-298.1, S-298.2, S-298.3
func TestRunCacheTracksDeclaredUntrackedInputsAndIgnoresOutputs(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	writePkg(t, pkgDir, `{"name":"@fixture/app"}`)
	writeEngineFile(t, filepath.Join(pkgDir, "src", "known.ts"), "export const known = true\n")
	writeEngineFile(t, filepath.Join(pkgDir, "generate.js"), `const fs = require("node:fs");
const sources = fs.readdirSync("src").filter((name) => name.endsWith(".ts") && name !== "generated.ts").sort();
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/generated.txt", sources.join("\\n"));
`)
	writeEngineFile(t, filepath.Join(pkgDir, "build.js"), `const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/output.txt", fs.readFileSync("dist/generated.txt", "utf8"));
`)
	writeEngineFile(t, filepath.Join(root, ".gitignore"), "packages/app/dist/generated.txt\npackages/app/src/ignored.ts\n")
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}

	cfg := testConfig([]config.NamedCategory{{Name: "apps", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}}})
	cfg.Tasks = map[string]config.TaskConfig{
		"generate": {{Command: "node generate.js", Inputs: []string{"src/**"}, Outputs: []string{"dist/generated.txt"}}},
		"build":    {{Command: "node build.js", Inputs: []string{"dist/generated.txt"}, Outputs: []string{"dist/output.txt"}, Deps: []string{"generate"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func() map[string]TaskResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !result.OK || len(result.Results) != 2 {
			t.Fatalf("Run result = %+v, want successful generate and build tasks", result)
		}
		byTask := make(map[string]TaskResult, len(result.Results))
		for _, task := range result.Results {
			byTask[task.Task] = task
		}
		return byTask
	}
	assertGenerated := func(want string) {
		t.Helper()
		generated, err := os.ReadFile(filepath.Join(pkgDir, "dist", "generated.txt"))
		if err != nil {
			t.Fatalf("read generated output: %v", err)
		}
		if string(generated) != want {
			t.Fatalf("generated output = %q, want %q", generated, want)
		}
	}

	if result := run(); result["generate"].Cached || result["build"].Cached {
		t.Fatal("first build was cached; want generate and build execution")
	}
	assertGenerated("known.ts")
	if result := run(); !result["generate"].Cached || !result["build"].Cached {
		t.Fatalf("second build cache state generate=%t build=%t, want both hits", result["generate"].Cached, result["build"].Cached)
	}
	if err := os.Remove(filepath.Join(pkgDir, "dist", "generated.txt")); err != nil {
		t.Fatalf("remove ignored generated output: %v", err)
	}
	if result := run(); !result["generate"].Cached || !result["build"].Cached {
		t.Fatalf("build after removing ignored output cached=%t/%t, want both hits", result["generate"].Cached, result["build"].Cached)
	}
	writeEngineFile(t, filepath.Join(pkgDir, "src", "new.ts"), "export const added = true\n")
	if result := run(); result["generate"].Cached || result["build"].Cached {
		t.Fatalf("build after adding a nonignored declared input cached=%t/%t; want both tasks to execute", result["generate"].Cached, result["build"].Cached)
	}
	assertGenerated("known.ts\\nnew.ts")
	if result := run(); !result["generate"].Cached || !result["build"].Cached {
		t.Fatalf("build after successful new-input run cached=%t/%t, want both hits", result["generate"].Cached, result["build"].Cached)
	}
	writeEngineFile(t, filepath.Join(pkgDir, "src", "ignored.ts"), "export const ignored = true\n")
	if result := run(); result["generate"].Cached || result["build"].Cached {
		t.Fatalf("build after adding ignored declared input cached=%t/%t; want both tasks to execute", result["generate"].Cached, result["build"].Cached)
	}
	assertGenerated("ignored.ts\\nknown.ts\\nnew.ts")
	writeEngineFile(t, filepath.Join(pkgDir, "README.md"), "outside declared inputs\n")
	if result := run(); !result["generate"].Cached || !result["build"].Cached {
		t.Fatalf("build after adding untracked file outside inputs cached=%t/%t, want both hits", result["generate"].Cached, result["build"].Cached)
	}
}

// case: S-298.4
func TestDependentBuildCacheInvalidatesWhenUpstreamGetsUntrackedInput(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	aDir := filepath.Join(root, "packages", "a")
	bDir := filepath.Join(root, "packages", "b")
	writePkg(t, aDir, `{"name":"@fixture/a"}`)
	writePkg(t, bDir, `{"name":"@fixture/b","dependencies":{"@fixture/a":"workspace:*"}}`)
	for _, dir := range []string{aDir, bDir} {
		writeEngineFile(t, filepath.Join(dir, "src", "known.ts"), "export const known = true\n")
		writeEngineFile(t, filepath.Join(dir, "build.js"), `const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.mkdirSync("dist", { recursive: true });
if (pkg.name === "@fixture/a") {
  fs.writeFileSync("dist/output.txt", "built");
} else {
  const sources = fs.readdirSync("../a/src").filter((name) => name.endsWith(".ts")).sort();
  fs.writeFileSync("dist/output.txt", sources.join("\\n"));
}
`)
	}
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	cfg := testConfig([]config.NamedCategory{{Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}}})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: "node build.js", Inputs: []string{"src/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func() map[string]TaskResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Packages: []workspace.Package{ws.Packages[1]}, Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
		if err != nil || !result.OK {
			t.Fatalf("Run = %+v, error = %#v", result, err)
		}
		byPackage := make(map[string]TaskResult, len(result.Results))
		for _, task := range result.Results {
			byPackage[task.Package] = task
		}
		return byPackage
	}
	assertOutput := func(pkgDir, want string) {
		t.Helper()
		output, err := os.ReadFile(filepath.Join(pkgDir, "dist", "output.txt"))
		if err != nil {
			t.Fatalf("read %s output: %v", pkgDir, err)
		}
		if string(output) != want {
			t.Fatalf("%s output = %q, want %q", pkgDir, output, want)
		}
	}

	first := run()
	if first["@fixture/a"].Cached || first["@fixture/b"].Cached {
		t.Fatalf("first build cache state = A:%t B:%t, want both fresh", first["@fixture/a"].Cached, first["@fixture/b"].Cached)
	}
	assertOutput(bDir, "known.ts")
	second := run()
	if !second["@fixture/a"].Cached || !second["@fixture/b"].Cached {
		t.Fatalf("second build cache state = A:%t B:%t, want both cached", second["@fixture/a"].Cached, second["@fixture/b"].Cached)
	}
	writeEngineFile(t, filepath.Join(aDir, "src", "new.ts"), "export const added = true\n")
	affected, err := AffectedRunPackages(ws, cfg, []string{"build"}, cacheRoot, false)
	if err != nil {
		t.Fatalf("AffectedRunPackages after upstream source add: %v", err)
	}
	gotAffected := packageNames(affected)
	sort.Strings(gotAffected)
	if strings.Join(gotAffected, "\x00") != "@fixture/a\x00@fixture/b" {
		t.Fatalf("affected packages = %v, want both source owner and dependent", gotAffected)
	}
	third := run()
	if third["@fixture/a"].Cached || third["@fixture/b"].Cached {
		t.Fatalf("build after upstream input cache state = A:%t B:%t, want both fresh", third["@fixture/a"].Cached, third["@fixture/b"].Cached)
	}
	assertOutput(bDir, "known.ts\\nnew.ts")
}

// case: S-298.5
func TestUncacheablePrerequisiteDisablesDependentCache(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	writePkg(t, pkgDir, `{"name":"@fixture/app"}`)
	writeEngineFile(t, filepath.Join(pkgDir, "src", "input.ts"), "export const input = true\n")
	writeEngineFile(t, filepath.Join(pkgDir, "prepare.js"), `const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/prepared.txt", "prepared");
`)
	writeEngineFile(t, filepath.Join(pkgDir, "build.js"), `const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/output.txt", fs.readFileSync("dist/prepared.txt", "utf8"));
`)
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	cfg := testConfig([]config.NamedCategory{{Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}}})
	cfg.Tasks = map[string]config.TaskConfig{
		"prepare": {{Command: "node prepare.js", Inputs: []string{"src/**"}}},
		"build":   {{Command: "node build.js", Inputs: []string{"dist/prepared.txt"}, Outputs: []string{"dist/output.txt"}, Deps: []string{"prepare"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func() map[string]TaskResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
		if err != nil || !result.OK {
			t.Fatalf("Run = %+v, error = %v", result, err)
		}
		byTask := make(map[string]TaskResult, len(result.Results))
		for _, task := range result.Results {
			byTask[task.Task] = task
		}
		return byTask
	}
	for iteration := 1; iteration <= 2; iteration++ {
		results := run()
		if results["prepare"].Cached || results["build"].Cached {
			t.Fatalf("iteration %d cache state prepare=%t build=%t, want both tasks to execute without declared prerequisite outputs", iteration, results["prepare"].Cached, results["build"].Cached)
		}
	}
}

// case: S-298.7
func TestAffectedRunInvalidatesDeepTaskDependencyChainFromUntrackedSource(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	names := []string{"raw", "generate", "bundle", "test"}
	packages := make(map[string]string, len(names))
	for i, name := range names {
		dir := filepath.Join(root, "packages", name)
		packages[name] = dir
		manifest := `{"name":"@fixture/` + name + `"}`
		if i > 0 {
			manifest = `{"name":"@fixture/` + name + `","dependencies":{"@fixture/` + names[i-1] + `":"workspace:*"}}`
		}
		writePkg(t, dir, manifest)
	}
	writeEngineFile(t, filepath.Join(packages["raw"], "src", "first.txt"), "first\n")
	cfg := testConfig([]config.NamedCategory{
		{Name: "raw", Category: config.CategoryConfig{Match: []string{"packages/raw"}, Preset: "node-lib"}},
		{Name: "generate", Category: config.CategoryConfig{Match: []string{"packages/generate"}, Preset: "node-lib"}},
		{Name: "bundle", Category: config.CategoryConfig{Match: []string{"packages/bundle"}, Preset: "node-lib"}},
		{Name: "test", Category: config.CategoryConfig{Match: []string{"packages/test"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"raw":      {{Categories: []string{"raw"}, Command: `sh -c "mkdir -p dist && cat src/*.txt > dist/raw.txt"`, Inputs: []string{"src/**"}, Outputs: []string{"dist/**"}}},
		"generate": {{Categories: []string{"generate"}, Command: `sh -c "mkdir -p dist && cat ../raw/dist/raw.txt > dist/generated.txt"`, Inputs: []string{"^dist/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^raw"}}},
		"bundle":   {{Categories: []string{"bundle"}, Command: `sh -c "mkdir -p dist && cat ../generate/dist/generated.txt > dist/bundle.txt"`, Inputs: []string{"^dist/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^generate"}}},
		"test":     {{Categories: []string{"test"}, Command: `sh -c "mkdir -p dist && cat ../bundle/dist/bundle.txt > dist/test.txt"`, Inputs: []string{"^dist/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^bundle"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	var testPackage workspace.Package
	for _, pkg := range ws.Packages {
		if pkg.Name == "@fixture/test" {
			testPackage = pkg
		}
	}
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func(selected []workspace.Package, affected bool) RunResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Packages: selected, Tasks: []string{"raw", "generate", "bundle", "test"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1, Affected: affected})
		if err != nil || !result.OK {
			if accounting, ok := err.(*RunAccountingError); ok {
				t.Fatalf("Run accounting error: unaccounted=%+v", accounting.UnaccountedTasks)
			}
			t.Fatalf("Run = %+v, error = %v", result, err)
		}
		return result
	}
	initial := run([]workspace.Package{testPackage}, false)
	if len(initial.Results) != 4 {
		t.Fatalf("initial task results = %d, want raw→generate→bundle→test chain", len(initial.Results))
	}
	writeEngineFile(t, filepath.Join(packages["raw"], "src", "second.txt"), "second\n")
	affected, err := AffectedRunPackages(ws, cfg, []string{"test"}, cacheRoot, false)
	if err != nil {
		t.Fatalf("AffectedRunPackages: %v", err)
	}
	gotAffected := packageNames(affected)
	sort.Strings(gotAffected)
	if strings.Join(gotAffected, "\x00") != "@fixture/bundle\x00@fixture/generate\x00@fixture/raw\x00@fixture/test" {
		t.Fatalf("affected packages = %v, want every package in the raw-to-test prerequisite chain", gotAffected)
	}
	result := run(affected, true)
	if len(result.Results) != 4 {
		t.Fatalf("affected task results = %d, want all four prerequisite tasks", len(result.Results))
	}
	for _, task := range result.Results {
		if task.Cached {
			t.Errorf("%s:%s unexpectedly restored stale output", task.Package, task.Task)
		}
	}
	output, err := os.ReadFile(filepath.Join(packages["test"], "dist", "test.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "first\nsecond\n" {
		t.Fatalf("final affected output = %q, want both raw source files", output)
	}
}

// case: S-298.8
func TestSourceOnlyDependencyInvalidatesDirectReader(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	aDir := filepath.Join(root, "packages", "a")
	bDir := filepath.Join(root, "packages", "b")
	writePkg(t, aDir, `{"name":"@fixture/a"}`)
	writePkg(t, bDir, `{"name":"@fixture/b","dependencies":{"@fixture/a":"workspace:*"}}`)
	writeEngineFile(t, filepath.Join(aDir, "src", "known.ts"), "known\n")
	writeEngineFile(t, filepath.Join(bDir, "consume.js"), `const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/sources.txt", fs.readdirSync("../a/src").filter((name) => name.endsWith(".ts")).sort().join("\\n"));
`)
	cfg := testConfig([]config.NamedCategory{
		{Name: "source", Category: config.CategoryConfig{Match: []string{"packages/a"}, Preset: "node-lib"}},
		{Name: "consumer", Category: config.CategoryConfig{Match: []string{"packages/b"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"generate": {{Categories: []string{"consumer"}, Command: "node consume.js", Outputs: []string{"dist/sources.txt"}, Deps: []string{"^generate"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	var bPackage workspace.Package
	for _, pkg := range ws.Packages {
		if pkg.Name == "@fixture/b" {
			bPackage = pkg
		}
	}
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func() TaskResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Packages: []workspace.Package{bPackage}, Tasks: []string{"generate"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
		if err != nil || !result.OK || len(result.Results) != 1 {
			t.Fatalf("Run = %+v, error = %v", result, err)
		}
		return result.Results[0]
	}
	if first := run(); first.Cached {
		t.Fatal("first source-only consume was cached")
	}
	if second := run(); !second.Cached {
		t.Fatal("unchanged source-only dependency did not hit cache")
	}
	writeEngineFile(t, filepath.Join(aDir, "src", "new.ts"), "new\n")
	if third := run(); third.Cached {
		t.Fatal("new untracked source in source-only dependency restored stale cache")
	}
	output, err := os.ReadFile(filepath.Join(bDir, "dist", "sources.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "known.ts\\nnew.ts" {
		t.Fatalf("consumed source list = %q, want both files", output)
	}
}

func TestSourceOnlyAggregateDigestExcludesNestedPackageOwnership(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*", "packages/*/*"})
	groupDir := filepath.Join(root, "packages", "group")
	childDir := filepath.Join(groupDir, "child")
	consumerDir := filepath.Join(root, "packages", "consumer")
	writePkg(t, groupDir, `{"name":"@fixture/group"}`)
	writePkg(t, childDir, `{"name":"@fixture/group-child"}`)
	writePkg(t, consumerDir, `{"name":"@fixture/consumer","dependencies":{"@fixture/group":"workspace:*"}}`)
	cfg := testConfig([]config.NamedCategory{
		{Name: "group", Category: config.CategoryConfig{Match: []string{"packages/group"}, Preset: "node-lib"}},
		{Name: "child", Category: config.CategoryConfig{Match: []string{"packages/group/child"}, Preset: "node-lib"}},
		{Name: "consumer", Category: config.CategoryConfig{Match: []string{"packages/consumer"}, Preset: "node-lib"}},
	})
	ws := mustWorkspace(t, root, cfg)
	digest := func() string {
		t.Helper()
		_, _, dependencies, _, err := workspaceInputDigests(ws, cfg)
		if err != nil {
			t.Fatal(err)
		}
		return dependencies["@fixture/consumer"]
	}
	before := digest()
	writeEngineFile(t, filepath.Join(childDir, "src", "child.ts"), "child source\n")
	afterChildChange := digest()
	if before != afterChildChange {
		t.Fatal("untracked child package source changed aggregate source-only dependency digest")
	}
	writeEngineFile(t, filepath.Join(groupDir, "src", "group.ts"), "group source\n")
	afterGroupChange := digest()
	if afterChildChange == afterGroupChange {
		t.Fatal("aggregate package's own untracked source did not change dependency digest")
	}
}

// case: S-298.9
func TestAffectedRunPropagatesDirtySamePackagePrerequisites(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	writePkg(t, pkgDir, `{"name":"@fixture/app"}`)
	writeEngineFile(t, filepath.Join(pkgDir, "src", "first.txt"), "first\n")
	cfg := testConfig([]config.NamedCategory{{Name: "app", Category: config.CategoryConfig{Match: []string{"packages/app"}, Preset: "node-lib"}}})
	cfg.Tasks = map[string]config.TaskConfig{
		"raw":      {{Categories: []string{"app"}, Command: `sh -c "mkdir -p dist && cat src/*.txt > dist/raw.txt"`, Inputs: []string{"src/**"}, Outputs: []string{"dist/raw.txt"}}},
		"generate": {{Categories: []string{"app"}, Command: `sh -c "mkdir -p dist && cat dist/raw.txt > dist/generated.txt"`, Inputs: []string{"dist/raw.txt"}, Outputs: []string{"dist/generated.txt"}, Deps: []string{"raw"}}},
		"test":     {{Categories: []string{"app"}, Command: `sh -c "mkdir -p dist && cat dist/generated.txt > dist/test.txt"`, Inputs: []string{"dist/generated.txt"}, Outputs: []string{"dist/test.txt"}, Deps: []string{"generate"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	run := func(packages []workspace.Package, affected bool) RunResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Packages: packages, Tasks: []string{"test"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1, Affected: affected})
		if err != nil || !result.OK {
			t.Fatalf("Run = %+v, error = %v", result, err)
		}
		return result
	}
	initial := run(ws.Packages, false)
	if len(initial.Results) != 3 {
		t.Fatalf("initial tasks = %d, want raw, generate, and test", len(initial.Results))
	}
	writeEngineFile(t, filepath.Join(pkgDir, "src", "second.txt"), "second\n")
	affected, err := AffectedRunPackages(ws, cfg, []string{"test"}, cacheRoot, false)
	if err != nil {
		t.Fatalf("AffectedRunPackages after source add: %v", err)
	}
	if len(affected) != 1 || affected[0].Name != "@fixture/app" {
		t.Fatalf("affected packages = %v, want app from dirty task predecessor", packageNames(affected))
	}
	updated := run(affected, true)
	if len(updated.Results) != 3 {
		t.Fatalf("affected tasks = %d, want all three DAG nodes", len(updated.Results))
	}
	for _, task := range updated.Results {
		if task.Cached {
			t.Errorf("%s:%s unexpectedly cached after upstream source changed", task.Package, task.Task)
		}
	}
	output, err := os.ReadFile(filepath.Join(pkgDir, "dist", "test.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "first\nsecond\n" {
		t.Fatalf("same-package final output = %q, want both raw source files", output)
	}
}

func TestAffectedSelectionAndTaskKeysShareTrackedFileOwnership(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	packages := []struct {
		name string
		json string
	}{
		{"base", `{"name":"@fixture/base"}`},
		{"middle", `{"name":"@fixture/middle","dependencies":{"@fixture/base":"workspace:*"}}`},
		{"app", `{"name":"@fixture/app","dependencies":{"@fixture/middle":"workspace:*"}}`},
		{"island", `{"name":"@fixture/island"}`},
		{"clikit", `{"name":"@fixture/clikit"}`},
		{"runner", `{"name":"@fixture/runner"}`},
	}
	for _, pkg := range packages {
		dir := filepath.Join(root, "packages", pkg.name)
		writePkg(t, dir, pkg.json)
		writeEngineFile(t, filepath.Join(dir, "src", "entry.go"), "package main\n")
	}
	writeEngineFile(t, filepath.Join(root, "packages", "app", "tests", "outside-glob.test.ts"), "expect(true).toBe(true)\n")
	writeEngineFile(t, filepath.Join(root, "packages", "runner", "go.mod"), "module fixture/runner\n\ngo 1.22\n\nrequire fixture/clikit v0.0.0\nreplace fixture/clikit => ../clikit\n")
	writeEngineFile(t, filepath.Join(root, "packages", "runner", "main.go"), "package main\n")
	writeEngineFile(t, filepath.Join(root, "packages", "clikit", "go.mod"), "module fixture/clikit\n\ngo 1.22\n")
	writeEngineFile(t, filepath.Join(root, "packages", "clikit", "kit.go"), "package clikit\n")
	writeEngineFile(t, filepath.Join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
	writeEngineFile(t, filepath.Join(root, "tsconfig.base.json"), `{"compilerOptions":{"strict":true}}`)
	writeEngineFile(t, filepath.Join(root, "vitest.config.ts"), "export default { test: {} }\n")
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	if output, err := exec.Command("git", "-C", root, "add", "--all").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, output)
	}

	config := testConfig([]config.NamedCategory{{Name: "all", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}}})
	ws := mustWorkspace(t, root, config)
	tasks := []TaskDef{
		{Name: "build", Command: "build", Inputs: []string{"src/**", "package.json", "^dist/**"}, Cache: true},
		{Name: "test", Command: "test", Inputs: []string{"src/**", "test/**", "__tests__/**", "package.json", "^dist/**"}, Cache: true},
	}
	baseline := propertyTaskKeys(t, ws, tasks)
	unownedFiles, ownedFiles, _, err := ws.TrackedFileOwnership()
	if err != nil {
		t.Fatal(err)
	}
	tracked := make([]string, 0)
	for _, files := range ownedFiles {
		tracked = append(tracked, files...)
	}
	tracked = append(tracked, unownedFiles...)
	sort.Strings(tracked)
	for _, file := range tracked {
		original, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read tracked fixture %s: %v", file, err)
		}
		originalInfo, err := os.Stat(file)
		if err != nil {
			t.Fatalf("stat tracked fixture %s: %v", file, err)
		}
		if err := os.WriteFile(file, append(append([]byte(nil), original...), '\n'), 0o644); err != nil {
			t.Fatalf("mutate tracked fixture %s: %v", file, err)
		}
		selection, err := selectAffectedPackages(ws, []string{file}, nil)
		if err != nil {
			t.Fatalf("select for %s: %v", file, err)
		}
		changed := propertyTaskKeys(t, ws, tasks)
		changedPackages := make(map[string]bool)
		for name, taskKeys := range baseline {
			for task, before := range taskKeys {
				if before != changed[name][task] {
					changedPackages[name] = true
				}
			}
		}
		for _, selected := range selection.Packages {
			for _, task := range tasks {
				if baseline[selected.Name][task.Name] == changed[selected.Name][task.Name] {
					t.Errorf("tracked file %s selected %s but left its %s task key unchanged", file, selected.Name, task.Name)
				}
			}
		}
		selectedNames := make(map[string]bool)
		for _, selected := range selection.Packages {
			selectedNames[selected.Name] = true
		}
		for name := range baseline {
			if !selectedNames[name] && changedPackages[name] {
				t.Errorf("tracked file %s changed unrelated package %s task keys", file, name)
			}
		}
		if err := os.WriteFile(file, original, 0o644); err != nil {
			t.Fatalf("restore tracked fixture %s: %v", file, err)
		}
		neutralTime := originalInfo.ModTime().Add(time.Second)
		if err := os.Chtimes(file, neutralTime, neutralTime); err != nil {
			t.Fatalf("change metadata on restored tracked fixture %s: %v", file, err)
		}
		restored := propertyTaskKeys(t, ws, tasks)
		for name, taskKeys := range baseline {
			for task, before := range taskKeys {
				if restored[name][task] != before {
					t.Errorf("tracked file %s has unchanged content but changed metadata; %s:%s key changed", file, name, task)
				}
			}
		}
	}

	modeOnlyPath := filepath.Join(root, "packages", "app", "tests", "outside-glob.test.ts")
	modeOnlyContents, err := os.ReadFile(modeOnlyPath)
	if err != nil {
		t.Fatalf("read mode-only fixture %s: %v", modeOnlyPath, err)
	}
	runGitCommand(t, root, "update-index", "--chmod=+x", "packages/app/tests/outside-glob.test.ts")
	modeChanged := propertyTaskKeys(t, ws, tasks)
	if after, err := os.ReadFile(modeOnlyPath); err != nil || string(after) != string(modeOnlyContents) {
		t.Fatalf("mode-only fixture content changed: got %q, err %v", after, err)
	}
	selection, err := selectAffectedPackages(ws, []string{modeOnlyPath}, nil)
	if err != nil {
		t.Fatalf("select mode-only change: %v", err)
	}
	for _, selected := range selection.Packages {
		for _, task := range tasks {
			if baseline[selected.Name][task.Name] == modeChanged[selected.Name][task.Name] {
				t.Errorf("tracked mode change for %s selected %s but left its %s task key unchanged", modeOnlyPath, selected.Name, task.Name)
			}
		}
	}
	if baseline["@fixture/island"]["build"] != modeChanged["@fixture/island"]["build"] || baseline["@fixture/island"]["test"] != modeChanged["@fixture/island"]["test"] {
		t.Errorf("tracked mode change for %s changed unrelated package keys", modeOnlyPath)
	}
	runGitCommand(t, root, "update-index", "--chmod=-x", "packages/app/tests/outside-glob.test.ts")
	modeRestored := propertyTaskKeys(t, ws, tasks)
	for name, taskKeys := range baseline {
		for task, before := range taskKeys {
			if modeRestored[name][task] != before {
				t.Errorf("tracked mode for %s was restored but %s:%s key did not return to baseline", modeOnlyPath, name, task)
			}
		}
	}
}

func propertyTaskKeys(t *testing.T, ws *workspace.Workspace, tasks []TaskDef) map[string]map[string]string {
	t.Helper()
	global, owned, dependencies, trackedMetadata, err := workspaceInputDigests(ws, nil)
	if err != nil {
		t.Fatal(err)
	}
	pkgByName := make(map[string]workspace.Package, len(ws.Packages))
	for _, pkg := range ws.Packages {
		pkgByName[pkg.Name] = pkg
	}
	keys := make(map[string]map[string]string, len(ws.Packages))
	for _, pkg := range ws.Packages {
		depNames, err := WorkspaceDeps(pkg.Dir, pkgByName)
		if err != nil {
			t.Fatal(err)
		}
		depDirs := make([]string, 0, len(depNames))
		for _, name := range depNames {
			depDirs = append(depDirs, pkgByName[name].Dir)
		}
		keys[pkg.Name] = make(map[string]string, len(tasks))
		for _, task := range tasks {
			key, err := hashTaskInputs(pkg, task, depDirs, "fixture-toolchain", global, owned[pkg.Name], dependencies[pkg.Name], taskInputContext{trackedMetadata: trackedMetadata})
			if err != nil {
				t.Fatalf("hash %s:%s: %v", pkg.Name, task.Name, err)
			}
			keys[pkg.Name][task.Name] = key
		}
	}
	return keys
}

func TestRunE2ECachesAndRestoresOutputs(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app"}`)
	writeEngineFile(t, filepath.Join(root, "packages", "app", "input.txt"), "hello\n")

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {
			{
				Command: `sh -c "mkdir -p dist && cp input.txt dist/output.txt"`,
				Inputs:  []string{"input.txt"},
				Outputs: []string{"dist/**"},
			},
		},
	}

	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")

	first, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build"},
		WSRoot:    root,
		CacheRoot: cacheRoot,
	})
	if err != nil {
		t.Fatalf("first Run error: %v", err)
	}
	if !first.OK || len(first.Results) != 1 || first.Results[0].Cached {
		t.Fatalf("unexpected first result: %+v", first)
	}

	outputPath := filepath.Join(root, "packages", "app", "dist", "output.txt")
	if _, err := os.Stat(outputPath); err != nil {
		t.Fatalf("expected output after first run: %v", err)
	}
	if err := os.Remove(outputPath); err != nil {
		t.Fatalf("remove output: %v", err)
	}

	second, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build"},
		WSRoot:    root,
		CacheRoot: cacheRoot,
	})
	if err != nil {
		t.Fatalf("second Run error: %v", err)
	}
	if !second.OK || len(second.Results) != 1 || !second.Results[0].Cached {
		t.Fatalf("unexpected second result: %+v", second)
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read restored output: %v", err)
	}
	if string(data) != "hello\n" {
		t.Fatalf("restored output = %q, want %q", data, "hello\n")
	}

	summary, err := second.Summary()
	if err != nil {
		t.Fatalf("second run summary: %v", err)
	}
	if summary.Scheduled != 1 || summary.Cached != 1 || summary.Passed != 0 || summary.Failed != 0 || summary.Blocked != 0 || summary.NotAffected != 0 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
}

// case: S-179.45
func TestArchivedSharedCASRestoresOutputsInCleanCheckout(t *testing.T) {
	prepare := func(root string) {
		t.Helper()
		writeWorkspaceRoot(t, root, []string{"packages/*"})
		pkgDir := filepath.Join(root, "packages", "app")
		writePkg(t, pkgDir, `{"name":"@fixture/app"}`)
		writeEngineFile(t, filepath.Join(pkgDir, "src", "index.ts"), "export const value = 1\n")
		initGitRepo(t, root)
		gitCommitAll(t, root, "fixture")
	}
	newConfig := func() *config.DevkitConfig {
		cfg := testConfig([]config.NamedCategory{{
			Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"},
		}})
		cfg.Tasks = map[string]config.TaskConfig{
			"build": {{
				Command: `sh -c "mkdir -p dist && printf restored > dist/output.txt && touch build-ran"`,
				Inputs:  []string{"package.json", "src/**"},
				Outputs: []string{"dist/**"},
			}},
		}
		return cfg
	}

	producerRoot := t.TempDir()
	prepare(producerRoot)
	producerCfg := newConfig()
	producerWS := mustWorkspace(t, producerRoot, producerCfg)
	first, err := Run(producerWS, producerCfg, RunOptions{
		Tasks: []string{"build"}, WSRoot: producerRoot, CacheRoot: filepath.Join(producerRoot, ".kb", "devkit"),
	})
	if err != nil || !first.OK || len(first.Results) != 1 || first.Results[0].Cached {
		t.Fatalf("first workspace build = %+v, err=%v; want a fresh successful execution", first, err)
	}

	producerStore, err := cache.SharedRoot(producerRoot)
	if err != nil {
		t.Fatalf("resolve producer SharedRoot: %v", err)
	}
	commonDir, err := exec.Command("git", "-C", producerRoot, "rev-parse", "--git-common-dir").Output()
	if err != nil {
		t.Fatalf("resolve producer git common directory: %v", err)
	}
	commonPath := strings.TrimSpace(string(commonDir))
	if !filepath.IsAbs(commonPath) {
		commonPath = filepath.Join(producerRoot, commonPath)
	}
	wantStore, err := filepath.EvalSymlinks(filepath.Join(commonPath, cache.SharedDirName))
	if err != nil {
		t.Fatalf("resolve expected CAS path: %v", err)
	}
	if got, err := filepath.EvalSymlinks(producerStore); err != nil || got != wantStore {
		t.Fatalf("producer SharedRoot = %s, err=%v; want git common-dir CAS %s", producerStore, err, wantStore)
	}

	archive := filepath.Join(t.TempDir(), "kb-devkit-cas.tar.gz")
	createArchive := exec.Command("tar", "-czf", archive, "-C", producerStore, ".")
	if output, err := createArchive.CombinedOutput(); err != nil {
		t.Fatalf("archive only the SharedRoot CAS: %v: %s", err, output)
	}

	consumerRoot := t.TempDir()
	prepare(consumerRoot)
	consumerCfg := newConfig()
	consumerWS := mustWorkspace(t, consumerRoot, consumerCfg)
	consumerStore, err := cache.SharedRoot(consumerRoot)
	if err != nil {
		t.Fatalf("resolve consumer SharedRoot: %v", err)
	}
	if _, err := os.Stat(filepath.Join(consumerRoot, ".kb", "devkit")); !os.IsNotExist(err) {
		t.Fatalf("clean consumer unexpectedly has worktree state before restore: err=%v", err)
	}
	if err := os.MkdirAll(consumerStore, 0o755); err != nil {
		t.Fatal(err)
	}
	restoreArchive := exec.Command("tar", "-xzf", archive, "-C", consumerStore)
	if output, err := restoreArchive.CombinedOutput(); err != nil {
		t.Fatalf("restore SharedRoot CAS archive: %v: %s", err, output)
	}

	second, err := Run(consumerWS, consumerCfg, RunOptions{
		Tasks: []string{"build"}, WSRoot: consumerRoot, CacheRoot: filepath.Join(consumerRoot, ".kb", "devkit"),
	})
	if err != nil || !second.OK || len(second.Results) != 1 || !second.Results[0].Cached {
		t.Fatalf("build after CAS archive restore = %+v, err=%v; want a cache hit", second, err)
	}
	if _, err := os.Stat(filepath.Join(consumerRoot, "packages", "app", "build-ran")); !os.IsNotExist(err) {
		t.Fatalf("cache hit executed the build command: err=%v", err)
	}
	output, err := os.ReadFile(filepath.Join(consumerRoot, "packages", "app", "dist", "output.txt"))
	if err != nil || string(output) != "restored" {
		t.Fatalf("restored dist output = %q, err=%v; want cached output", output, err)
	}
}

// case: S-179.42
func TestRunSummaryRejectsScheduledTasksLeftAfterDependencyTraversal(t *testing.T) {
	result := RunResult{
		scheduledTasks: []TaskIdentity{{Package: "@fixture/app", Task: "build"}, {Package: "@fixture/lib", Task: "build"}},
		Results:        []TaskResult{{Package: "@fixture/app", Task: "build", OK: true}},
	}
	_, err := result.Summary()
	if err == nil {
		t.Fatal("Summary accepted a scheduled task without a terminal outcome")
	}
	var accountingErr *RunAccountingError
	if !errors.As(err, &accountingErr) || len(accountingErr.UnaccountedTasks) == 0 {
		t.Fatalf("Summary error = %T %v, want unaccounted scheduled tasks", err, err)
	}
}

// case: S-179.42
func TestRunReportsDependencyCycleBeforeExecutingTasks(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "a"), `{"name":"@fixture/a","dependencies":{"@fixture/b":"workspace:*"}}`)
	writePkg(t, filepath.Join(root, "packages", "b"), `{"name":"@fixture/b","devDependencies":{"@fixture/c":"workspace:*"}}`)
	writePkg(t, filepath.Join(root, "packages", "c"), `{"name":"@fixture/c","peerDependencies":{"@fixture/a":"workspace:*"}}`)
	writeEngineFile(t, filepath.Join(root, "packages", "a", "task.sh"), "touch ran\n")
	writeEngineFile(t, filepath.Join(root, "packages", "b", "task.sh"), "touch ran\n")
	writeEngineFile(t, filepath.Join(root, "packages", "c", "task.sh"), "touch ran\n")
	cfg := testConfig([]config.NamedCategory{
		{Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: "sh task.sh", Deps: []string{"^build"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	_, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build"},
		WSRoot:    root,
		CacheRoot: filepath.Join(root, ".kb", "devkit-cache"),
	})
	if err == nil {
		t.Fatal("Run succeeded with a workspace dependency cycle")
	}
	var cycleErr *TaskCycleError
	if !errors.As(err, &cycleErr) {
		t.Fatalf("Run error = %T %v, want TaskCycleError", err, err)
	}
	want := []TaskCycleEdge{
		{From: TaskIdentity{Package: "@fixture/a", Task: "build"}, To: TaskIdentity{Package: "@fixture/b", Task: "build"}, Kind: DependenciesKind},
		{From: TaskIdentity{Package: "@fixture/b", Task: "build"}, To: TaskIdentity{Package: "@fixture/c", Task: "build"}, Kind: DevDependenciesKind},
		{From: TaskIdentity{Package: "@fixture/c", Task: "build"}, To: TaskIdentity{Package: "@fixture/a", Task: "build"}, Kind: PeerDependenciesKind},
	}
	if !reflect.DeepEqual(cycleErr.Edges, want) {
		t.Errorf("cycle edges = %+v, want %+v", cycleErr.Edges, want)
	}
	if !strings.Contains(err.Error(), cycleErr.CycleDescription()) {
		t.Errorf("cycle error %q omits its structured cycle %q", err, cycleErr.CycleDescription())
	}
	for _, pkg := range []string{"a", "b", "c"} {
		if _, err := os.Stat(filepath.Join(root, "packages", pkg, "ran")); !os.IsNotExist(err) {
			t.Errorf("task for @fixture/%s ran before cycle rejection (stat error %v)", pkg, err)
		}
	}
}

// case: S-261.4
func TestRunE2ECachedOutputsPreserveFileModes(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	writePkg(t, pkgDir, `{"name":"@kb/app"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{
			Command: `sh -c "mkdir -p dist && printf regular > dist/regular.txt && printf executable > dist/run.sh && chmod 644 dist/regular.txt && chmod 755 dist/run.sh"`,
			Outputs: []string{"dist/**"},
		}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")
	run := func() RunResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		return result
	}
	if result := run(); !result.OK || result.Results[0].Cached {
		t.Fatalf("first build = %+v, want fresh successful build", result)
	}
	for name := range map[string]os.FileMode{"regular.txt": 0o644, "run.sh": 0o755} {
		if err := os.Remove(filepath.Join(pkgDir, "dist", name)); err != nil {
			t.Fatalf("remove %s: %v", name, err)
		}
	}
	result := run()
	if !result.OK || !result.Results[0].Cached {
		t.Fatalf("second build = %+v, want cached successful build", result)
	}
	for name, want := range map[string]os.FileMode{"regular.txt": 0o644, "run.sh": 0o755} {
		info, err := os.Stat(filepath.Join(pkgDir, "dist", name))
		if err != nil {
			t.Fatalf("stat restored %s: %v", name, err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("restored %s mode = %04o, want %04o", name, got, want)
		}
	}
	storeRoot, err := cache.SharedRoot(root)
	if err != nil {
		t.Fatalf("resolve shared store: %v", err)
	}
	if err := filepath.WalkDir(filepath.Join(storeRoot, "tasks"), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var manifest map[string]any
		if err := json.Unmarshal(data, &manifest); err != nil {
			return err
		}
		outputs, ok := manifest["outputs"].([]any)
		if !ok {
			return nil
		}
		for _, output := range outputs {
			if ref, ok := output.(map[string]any); ok {
				delete(ref, "mode")
			}
		}
		data, err = json.Marshal(manifest)
		if err != nil {
			return err
		}
		return os.WriteFile(path, data, 0o644)
	}); err != nil {
		t.Fatalf("remove mode metadata from cached manifest: %v", err)
	}
	for _, name := range []string{"regular.txt", "run.sh"} {
		if err := os.Remove(filepath.Join(pkgDir, "dist", name)); err != nil {
			t.Fatalf("remove %s for legacy cache check: %v", name, err)
		}
	}
	legacy := run()
	if !legacy.OK || legacy.Results[0].Cached {
		t.Fatalf("legacy manifest run = %+v, want a successful rebuild after cache miss", legacy)
	}
}

// case: S-261.5
func TestAffectedBuildSelectsChangedInputsAfterMerge(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	coreDir := filepath.Join(root, "packages", "core")
	runtimeDir := filepath.Join(root, "packages", "runtime")
	appDir := filepath.Join(root, "packages", "app")
	writePkg(t, coreDir, `{"name":"@fixture/core"}`)
	writePkg(t, runtimeDir, `{"name":"@fixture/runtime","dependencies":{"@fixture/core":"workspace:*"}}`)
	writePkg(t, appDir, `{"name":"@fixture/app","dependencies":{"@fixture/runtime":"workspace:*"}}`)
	for _, dir := range []string{coreDir, runtimeDir, appDir} {
		writeEngineFile(t, filepath.Join(dir, "src", "input.txt"), "initial\n")
	}
	writeEngineFile(t, filepath.Join(coreDir, "README.md"), "package notes\n")
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("**/dist/\n.kb/\n"), 0o644); err != nil {
		t.Fatalf("write .gitignore: %v", err)
	}
	if err := os.WriteFile(filepath.Join(coreDir, "src", "input.txt"), []byte("initial\n"), 0o644); err != nil {
		t.Fatalf("write core input: %v", err)
	}
	for _, args := range [][]string{{"init", "-b", "main"}, {"config", "user.email", "devkit@example.test"}, {"config", "user.name", "kb-devkit test"}, {"add", "."}, {"commit", "-m", "initial packages"}} {
		runGitCommand(t, root, args...)
	}

	cfg := testConfig([]config.NamedCategory{
		{Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{
			Command: `sh -c "mkdir -p dist && cat src/input.txt > dist/output.txt"`,
			Inputs:  []string{"src/**"},
			Outputs: []string{"dist/**"},
			Deps:    []string{"^build"},
		}},
	}
	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	first, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
	if err != nil || !first.OK {
		t.Fatalf("initial build = %+v, error = %v", first, err)
	}
	runGitCommand(t, root, "checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(coreDir, "src", "input.txt"), []byte("merged change\n"), 0o644); err != nil {
		t.Fatalf("change core input: %v", err)
	}
	runGitCommand(t, root, "add", "packages/core/src/input.txt")
	runGitCommand(t, root, "commit", "-m", "change core input")
	runGitCommand(t, root, "checkout", "main")
	runGitCommand(t, root, "merge", "--no-ff", "feature", "-m", "merge feature")

	changed, err := AffectedPackages(ws, cfg)
	if err != nil {
		t.Fatalf("AffectedPackages: %v", err)
	}
	if len(changed.Packages) != 0 {
		t.Fatalf("committed merge has Git-diff packages %v, want none", packageNames(changed.Packages))
	}
	selected, err := AffectedRunPackages(ws, cfg, []string{"build"}, cacheRoot, false)
	if err != nil {
		t.Fatalf("AffectedRunPackages: %v", err)
	}
	want := []string{"@fixture/core", "@fixture/runtime", "@fixture/app"}
	got := packageNames(selected)
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) || strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("--affected selected %v (git changes %v), want %v", got, packageNames(changed.Packages), want)
	}
	completed, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
	if err != nil || !completed.OK {
		t.Fatalf("build after merged change = %+v, error = %v", completed, err)
	}
	runGitCommand(t, root, "checkout", "feature")
	runGitCommand(t, root, "checkout", "main")
	unchangedAfterCheckout, err := AffectedRunPackages(ws, cfg, []string{"build"}, cacheRoot, false)
	if err != nil {
		t.Fatalf("AffectedRunPackages after content-neutral checkout = %v", err)
	}
	if len(unchangedAfterCheckout) != 0 {
		t.Fatalf("content-neutral checkout selected %v by input hashes; want none", packageNames(unchangedAfterCheckout))
	}
	if err := os.WriteFile(filepath.Join(coreDir, "README.md"), []byte("notes outside declared build inputs\n"), 0o644); err != nil {
		t.Fatalf("change file outside task inputs: %v", err)
	}
	diffOnly, err := AffectedPackages(ws, cfg)
	if err != nil {
		t.Fatalf("AffectedPackages after README change: %v", err)
	}
	diffOnlySelection, err := AffectedRunPackages(ws, cfg, []string{"build"}, cacheRoot, true)
	if err != nil {
		t.Fatalf("AffectedRunPackages with diff-only: %v", err)
	}
	unchangedInputs, err := AffectedRunPackages(ws, cfg, []string{"build"}, cacheRoot, false)
	if err != nil {
		t.Fatalf("AffectedRunPackages after README change: %v", err)
	}
	wantChanged := []string{"@fixture/app", "@fixture/core", "@fixture/runtime"}
	for _, selection := range [][]workspace.Package{diffOnly.Packages, diffOnlySelection, unchangedInputs} {
		got := packageNames(selection)
		sort.Strings(got)
		if strings.Join(got, "\x00") != strings.Join(wantChanged, "\x00") {
			t.Fatalf("Git diff = %v, diff-only selection = %v, input-hash selection = %v; each must select %v for a tracked package file change", packageNames(diffOnly.Packages), packageNames(diffOnlySelection), packageNames(unchangedInputs), wantChanged)
		}
	}
}

func runGitCommand(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
}

func packageNames(packages []workspace.Package) []string {
	names := make([]string, len(packages))
	for i, pkg := range packages {
		names[i] = pkg.Name
	}
	return names
}

// case: S-179.18
func TestRunE2EDoesNotReplayCachedFailure(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{
			Command: `sh -c "test -f ../dependency.ready"`,
			Outputs: []string{"dist/**"},
		}},
	}

	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")
	run := func() RunResult {
		t.Helper()
		result, err := Run(ws, cfg, RunOptions{
			Tasks:     []string{"build"},
			WSRoot:    root,
			CacheRoot: cacheRoot,
		})
		if err != nil {
			t.Fatalf("Run error: %v", err)
		}
		return result
	}

	first := run()
	firstSummary, err := first.Summary()
	if err != nil {
		t.Fatalf("first run summary: %v", err)
	}
	if first.OK || firstSummary.Failed != 1 {
		t.Fatalf("first run = %+v, want one failed task", first)
	}

	second := run()
	if second.OK || len(second.Results) != 1 || second.Results[0].Cached {
		t.Fatalf("second run = %+v, want a fresh failed execution", second)
	}
	if summary, err := second.Summary(); err != nil || summary.Scheduled != 1 || summary.Passed != 0 || summary.Failed != 1 || summary.Cached != 0 || summary.Blocked != 0 || summary.NotAffected != 0 {
		t.Fatalf("second summary = %+v, want total=1 passed=0 failed=1 cached=0", summary)
	}
	if err := os.WriteFile(filepath.Join(root, "packages", "dependency.ready"), nil, 0o644); err != nil {
		t.Fatalf("write dependency artifact: %v", err)
	}

	third := run()
	if !third.OK || len(third.Results) != 1 || third.Results[0].Cached {
		t.Fatalf("third run = %+v, want a fresh successful execution", third)
	}
	if summary, err := third.Summary(); err != nil || summary.Scheduled != 1 || summary.Passed != 1 || summary.Failed != 0 || summary.Cached != 0 || summary.Blocked != 0 || summary.NotAffected != 0 {
		t.Fatalf("third summary = %+v, want total=1 passed=1 failed=0 cached=0", summary)
	}

	fourth := run()
	if !fourth.OK || len(fourth.Results) != 1 || !fourth.Results[0].Cached {
		t.Fatalf("fourth run = %+v, want the successful task cached", fourth)
	}
}

// case: S-179.23, S-179.37, S-261.6
func TestRunSummaryPartitionsScheduledTasksAndCountsBlockedDependents(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "core"), `{"name":"@fixture/core"}`)
	writePkg(t, filepath.Join(root, "packages", "middle"), `{"name":"@fixture/middle","dependencies":{"@fixture/core":"workspace:*"}}`)
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@fixture/app","dependencies":{"@fixture/middle":"workspace:*"}}`)
	writePkg(t, filepath.Join(root, "packages", "independent"), `{"name":"@fixture/independent"}`)
	writePkg(t, filepath.Join(root, "packages", "untouched"), `{"name":"@fixture/untouched"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "core", Category: config.CategoryConfig{Match: []string{"packages/core"}, Preset: "node-lib"}},
		{Name: "libraries", Category: config.CategoryConfig{Match: []string{"packages/middle", "packages/app", "packages/independent", "packages/untouched"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {
			{Categories: []string{"core"}, Command: "false"},
			{Categories: []string{"libraries"}, Command: "true", Deps: []string{"^build"}},
		},
	}
	ws := mustWorkspace(t, root, cfg)
	var selected []workspace.Package
	for _, pkg := range ws.Packages {
		if pkg.Dir != filepath.Join(root, "packages", "untouched") {
			selected = append(selected, pkg)
		}
	}
	if len(selected) != 4 {
		t.Fatalf("selected packages = %+v; want core, middle, app, and independent", selected)
	}

	result, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build"},
		Packages:  selected,
		Affected:  true,
		WSRoot:    root,
		CacheRoot: filepath.Join(root, ".kb", "devkit-cache"),
	})
	if err != nil || result.OK || len(result.Results) != 2 {
		t.Fatalf("failed dependency run = %+v, error = %v; want failed root and independent result", result, err)
	}
	summary, err := result.Summary()
	if err != nil {
		t.Fatalf("failed dependency summary: %v", err)
	}
	if summary.Scheduled != 5 || summary.Passed != 1 || summary.Cached != 0 || summary.Failed != 1 || summary.Blocked != 2 || summary.NotAffected != 1 {
		t.Fatalf("failed dependency summary = %+v; want scheduled=5 passed=1 failed=1 blocked=2 notAffected=1", summary)
	}
	if summary.Passed+summary.Cached+summary.Failed+summary.Blocked+summary.NotAffected != summary.Scheduled {
		t.Fatalf("summary counts do not partition scheduled tasks: %+v", summary)
	}
	blocked := make(map[string]string, len(summary.BlockedTasks))
	for _, task := range summary.BlockedTasks {
		blocked[task.Package] = task.BlockedByPackage + ":" + task.BlockedByTask
	}
	if blocked["@fixture/middle"] != "@fixture/core:build" || blocked["@fixture/app"] != "@fixture/core:build" {
		t.Fatalf("blocked task details = %+v; want middle and app blocked-by @fixture/core:build", summary.BlockedTasks)
	}
	independentPassed := false
	for _, task := range result.Results {
		if task.Package == "@fixture/independent" && task.OK {
			independentPassed = true
		}
	}
	if summary.NotAffected != 1 || !independentPassed {
		t.Fatalf("result = %+v; want independent branch passed and one not-affected task", result)
	}
}

// case: S-179.19
func TestRunIncludesDeclaredTaskDependenciesWhenOnlyTheDependentWasRequested(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "package"), `{"name":"@fixture/package"}`)
	cfg := testConfig([]config.NamedCategory{
		{Name: "package", Category: config.CategoryConfig{Match: []string{"packages/package"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"prepare": {{Command: `sh -c "printf ready > prepared.txt"`}},
		"build":   {{Command: `sh -c "test -f prepared.txt"`, Deps: []string{"prepare"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	nodes, err := buildDAG(ws.Packages, []string{"build"}, cfg, ws)
	if err != nil {
		t.Fatalf("buildDAG error: %v", err)
	}
	buildNode := nodes[nodeKey{pkg: "@fixture/package", task: "build"}]
	if len(buildNode.deps) != 1 || buildNode.deps[0].to != (nodeKey{pkg: "@fixture/package", task: "prepare"}) {
		t.Fatalf("build dependencies = %+v; want same-package prepare task", buildNode.deps)
	}
	result, err := Run(ws, cfg, RunOptions{
		Tasks: []string{"build"}, WSRoot: root, CacheRoot: filepath.Join(root, ".kb", "devkit-cache"), Concurrency: 1,
	})
	if err != nil || !result.OK || len(result.Results) != 2 {
		t.Fatalf("Run = %+v, error = %v; want prepare then build", result, err)
	}
	if result.Results[0].Task != "prepare" || result.Results[1].Task != "build" {
		t.Fatalf("task results = %+v; want prepare before build", result.Results)
	}
}

func TestRunE2ERespectsCrossPackageDependencies(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "core"), `{"name":"@kb/core"}`)
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app","dependencies":{"@kb/core":"workspace:*"}}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {
			{
				Command: `sh -c "printf built > build.txt"`,
				Outputs: []string{"build.txt"},
			},
		},
		"verify": {
			{
				Command: `sh -c "test -f build.txt && test -f ../core/build.txt"`,
				Deps:    []string{"build", "^build"},
			},
		},
	}

	ws := mustWorkspace(t, root, cfg)

	var seen []string
	result, err := Run(ws, cfg, RunOptions{
		Tasks:       []string{"build", "verify"},
		WSRoot:      root,
		CacheRoot:   filepath.Join(root, ".kb", "devkit-cache"),
		Concurrency: 1,
		OnResult: func(r TaskResult, done, total int) {
			seen = append(seen, r.Package+":"+r.Task)
		},
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if !result.OK {
		t.Fatalf("RunResult not OK: %+v", result)
	}
	if len(result.Results) != 4 {
		t.Fatalf("results count = %d, want 4", len(result.Results))
	}
	if len(seen) != 4 {
		t.Fatalf("OnResult count = %d, want 4", len(seen))
	}

	if _, err := os.Stat(filepath.Join(root, "packages", "core", "build.txt")); err != nil {
		t.Fatalf("core build artifact missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "packages", "app", "build.txt")); err != nil {
		t.Fatalf("app build artifact missing: %v", err)
	}
}

// case: S-179.37
func TestRunAffectedDependencyChainCompletesBeforeDependentTasks(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	coreDir := filepath.Join(root, "packages", "core")
	runtimeDir := filepath.Join(root, "packages", "runtime")
	appDir := filepath.Join(root, "packages", "app")
	writePkg(t, coreDir, `{"name":"@fixture/core"}`)
	writePkg(t, runtimeDir, `{"name":"@fixture/runtime","dependencies":{"@fixture/core":"workspace:*"}}`)
	writePkg(t, appDir, `{"name":"@fixture/app","dependencies":{"@fixture/runtime":"workspace:*"}}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "core", Category: config.CategoryConfig{Match: []string{"packages/core"}, Preset: "node-lib"}},
		{Name: "runtime", Category: config.CategoryConfig{Match: []string{"packages/runtime"}, Preset: "node-lib"}},
		{Name: "applications", Category: config.CategoryConfig{Match: []string{"packages/app"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {
			{Categories: []string{"core"}, Command: `sh -c "mkdir -p dist && printf core > dist/ready"`},
			{Categories: []string{"runtime"}, Command: `sh -c "test -f ../core/dist/ready && mkdir -p dist && printf runtime > dist/ready"`, Deps: []string{"^build"}},
			{Categories: []string{"applications"}, Command: `sh -c "test -f ../runtime/dist/ready"`, Deps: []string{"^build"}},
		},
	}
	ws := mustWorkspace(t, root, cfg)
	selected := ws.FilterByName([]string{"@fixture/runtime", "@fixture/app"})
	var completed []string
	result, err := Run(ws, cfg, RunOptions{
		Tasks:       []string{"build"},
		Packages:    selected,
		WSRoot:      root,
		CacheRoot:   filepath.Join(root, ".kb", "devkit-cache"),
		Concurrency: 3,
		OnResult: func(result TaskResult, _, _ int) {
			completed = append(completed, result.Package)
		},
	})
	if err != nil || !result.OK {
		t.Fatalf("affected dependency build = %+v, error = %v", result, err)
	}
	want := []string{"@fixture/core", "@fixture/runtime", "@fixture/app"}
	if len(completed) != len(want) {
		t.Fatalf("completed tasks = %v, want %v", completed, want)
	}
	for i := range want {
		if completed[i] != want[i] {
			t.Fatalf("completed task order = %v, want %v", completed, want)
		}
	}
}

// case: S-179.50, S-179.51, S-179.52
func TestRunZoneSelectionBuildsOnlySelectedRootsAndUpstreamClosure(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	platformDir := filepath.Join(root, "packages", "platform")
	pluginDir := filepath.Join(root, "packages", "plugin")
	siteDir := filepath.Join(root, "packages", "site")
	writePkg(t, platformDir, `{"name":"@fixture/platform"}`)
	writePkg(t, pluginDir, `{"name":"@fixture/plugin","dependencies":{"@fixture/platform":"workspace:*"}}`)
	writePkg(t, siteDir, `{"name":"@fixture/site"}`)

	siteDefaultBuild := false
	categories := []config.NamedCategory{
		{Name: "platform", Category: config.CategoryConfig{Match: []string{"packages/platform"}, Preset: "node-lib"}},
		{Name: "plugins", Category: config.CategoryConfig{Match: []string{"packages/plugin"}, Preset: "node-lib"}},
		{Name: "sites", Category: config.CategoryConfig{Match: []string{"packages/site"}, Preset: "node-lib", DefaultBuild: &siteDefaultBuild}},
	}
	cfg := testConfig(categories)
	cfg.Workspace.Zones = []config.NamedZone{
		{Name: "runtime", Match: []string{"packages/platform"}},
		{Name: "extensions", Match: []string{"packages/plugin"}},
		{Name: "web-apps", Match: []string{"packages/site"}},
	}
	cfg.Tasks = map[string]config.TaskConfig{
		"build":         {{Command: `sh -c "mkdir -p dist && touch dist/built"`, Inputs: []string{"package.json"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}}},
		"lint":          {{Command: "touch lint-ran"}},
		"type-check":    {{Command: "touch type-check-ran"}},
		"test":          {{Command: "touch test-ran"}},
		"test:cli":      {{Command: "touch test-cli-ran"}},
		"test:coverage": {{Command: "touch coverage-ran"}},
		"e2e":           {{Command: "touch e2e-ran"}},
	}
	ws := mustWorkspace(t, root, cfg)
	run := func(tasks []string, options RunOptions) (RunResult, error) {
		t.Helper()
		options.Tasks = tasks
		options.WSRoot = root
		options.CacheRoot = filepath.Join(root, ".kb", "devkit")
		options.Concurrency = 1
		return Run(ws, cfg, options)
	}

	build, err := run([]string{"build"}, RunOptions{Zones: []string{"extensions"}})
	if err != nil || !build.OK {
		t.Fatalf("build plugin zone = %+v, error = %v", build, err)
	}
	var built []string
	for _, result := range build.Results {
		built = append(built, result.Package)
	}
	if want := []string{"@fixture/platform", "@fixture/plugin"}; !reflect.DeepEqual(built, want) {
		t.Fatalf("build results = %v, want upstream closure %v without unrelated site", built, want)
	}

	for _, task := range []string{"lint", "type-check", "test", "test:cli", "test:coverage", "e2e"} {
		result, err := run([]string{task}, RunOptions{Zones: []string{"extensions"}})
		if err != nil || !result.OK || len(result.Results) != 1 || result.Results[0].Package != "@fixture/plugin" {
			t.Errorf("%s plugin zone = %+v, error = %v; want only @fixture/plugin", task, result, err)
		}
	}

	sites, err := run([]string{"build"}, RunOptions{Zones: []string{"web-apps"}})
	if err != nil || !sites.OK || len(sites.Results) != 1 || sites.Results[0].Package != "@fixture/site" {
		t.Fatalf("explicit sites zone = %+v, error = %v; want defaultBuild:false site", sites, err)
	}

	_, err = run([]string{"build"}, RunOptions{Zones: []string{"missing"}})
	if err == nil || !strings.Contains(err.Error(), "unknown workspace zone") {
		t.Fatalf("unknown zone error = %v, want fail-closed selection error", err)
	}
	_, err = run([]string{"build"}, RunOptions{Packages: ws.FilterByName([]string{"@fixture/plugin"}), ExplicitPackageSelection: true, Zones: []string{"runtime"}})
	if err == nil || !strings.Contains(err.Error(), "no packages match") {
		t.Fatalf("empty package-zone intersection error = %v, want fail-closed selection error", err)
	}
}

func TestRunE2EStopsAfterFailure(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {
			{Command: `sh -c "exit 7"`},
		},
		"verify": {
			{Command: `sh -c "touch should-not-run"`, Deps: []string{"build"}},
		},
	}

	ws := mustWorkspace(t, root, cfg)
	result, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build", "verify"},
		WSRoot:    root,
		CacheRoot: filepath.Join(root, ".kb", "devkit-cache"),
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if result.OK {
		t.Fatalf("RunResult OK = true, want false: %+v", result)
	}
	if len(result.Results) != 1 || result.Results[0].Task != "build" || result.Results[0].ExitCode != 7 {
		t.Fatalf("unexpected results after failure: %+v", result.Results)
	}
	if _, err := os.Stat(filepath.Join(root, "packages", "app", "should-not-run")); !os.IsNotExist(err) {
		t.Fatalf("verify task should not have run, stat err = %v", err)
	}
}

func TestRunMarksFailedPackagesAsDirty(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: `sh -c "exit 1"`}},
	}

	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")

	result, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build"},
		WSRoot:    root,
		CacheRoot: cacheRoot,
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if result.OK {
		t.Fatal("expected RunResult.OK = false")
	}

	if !cache.NewStateStore(cacheRoot).IsDirty("@kb/app", "build") {
		t.Fatal("@kb/app:build should be DIRTY after failure")
	}
}

func TestRunMarksSuccessPackagesAsClean(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: `sh -c "exit 0"`}},
	}

	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")

	result, err := Run(ws, cfg, RunOptions{
		Tasks:     []string{"build"},
		WSRoot:    root,
		CacheRoot: cacheRoot,
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if !result.OK {
		t.Fatal("expected RunResult.OK = true")
	}

	if cache.NewStateStore(cacheRoot).IsDirty("@kb/app", "build") {
		t.Fatal("@kb/app:build should be CLEAN after success")
	}
}

func TestRunMarksNotExecutedPackagesAsDirty(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "core"), `{"name":"@kb/core"}`)
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app","dependencies":{"@kb/core":"workspace:*"}}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")

	// Phase 1: both packages build successfully → both CLEAN.
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: `sh -c "exit 0"`, Deps: []string{"^build"}}},
	}
	ws := mustWorkspace(t, root, cfg)
	r1, err := Run(ws, cfg, RunOptions{Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1})
	if err != nil || !r1.OK {
		t.Fatalf("phase 1 Run should succeed: err=%v ok=%v", err, r1.OK)
	}
	ss := cache.NewStateStore(cacheRoot)
	if ss.IsDirty("@kb/core", "build") || ss.IsDirty("@kb/app", "build") {
		t.Fatal("both packages should be CLEAN after phase 1")
	}

	// Phase 2: core fails → app is blocked and must be marked DIRTY for retry.
	cfg.Tasks["build"] = config.TaskConfig{{Command: `sh -c "exit 1"`, Deps: []string{"^build"}}}
	r2, err := Run(ws, cfg, RunOptions{
		Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, Concurrency: 1, NoCache: true,
	})
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if r2.OK {
		t.Fatal("expected RunResult.OK = false (core fails)")
	}

	// core: actually failed → DIRTY
	if !ss.IsDirty("@kb/core", "build") {
		t.Fatal("@kb/core:build should be DIRTY (actually failed)")
	}
	// app: was CLEAN, blocked by the failed dependency → must be DIRTY
	if !ss.IsDirty("@kb/app", "build") {
		t.Fatal("@kb/app:build should be DIRTY (was CLEAN but blocked by dependency failure)")
	}
}

func TestDirtyPackagesCoversRetryAfterFailure(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "app"), `{"name":"@kb/app"}`)

	cfg := testConfig([]config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {{Command: `sh -c "exit 1"`}},
	}

	ws := mustWorkspace(t, root, cfg)
	cacheRoot := filepath.Join(root, ".kb", "devkit-cache")

	// First run — fails
	Run(ws, cfg, RunOptions{ //nolint:errcheck
		Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot,
	})

	// DirtyPackages must return @kb/app even though no files changed
	dirty, err := DirtyPackages(ws, cfg, []string{"build"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(dirty) != 1 || dirty[0].Name != "@kb/app" {
		t.Fatalf("DirtyPackages after failure = %v, want [@kb/app]", dirty)
	}

	// Fix: run succeeds. NoCache:true avoids hitting the cached failure manifest
	// (same inputHash since inputs are empty in this test), ensuring a real execution
	// that writes CLEAN state.
	cfg.Tasks["build"] = config.TaskConfig{{Command: `sh -c "exit 0"`}}
	Run(ws, cfg, RunOptions{ //nolint:errcheck
		Tasks: []string{"build"}, WSRoot: root, CacheRoot: cacheRoot, NoCache: true,
	})

	// Now DirtyPackages must be empty
	dirty2, err := DirtyPackages(ws, cfg, []string{"build"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(dirty2) != 0 {
		t.Fatalf("DirtyPackages after fix = %v, want []", dirty2)
	}
}

func mustWorkspace(t *testing.T, root string, cfg *config.DevkitConfig) *workspace.Workspace {
	t.Helper()
	if output, err := exec.Command("git", "-C", root, "rev-parse", "--show-toplevel").CombinedOutput(); err != nil {
		initTrackedFixture(t, root)
	} else if len(output) == 0 {
		t.Fatal("git rev-parse returned an empty workspace root")
	}
	if output, err := exec.Command("git", "-C", root, "add", "--all").CombinedOutput(); err != nil {
		t.Fatalf("git add workspace fixture: %v: %s", err, output)
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}
	return ws
}

func testConfig(categories []config.NamedCategory) *config.DevkitConfig {
	return &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: categories,
		},
	}
}

func writeWorkspaceRoot(t *testing.T, root string, workspaces []string) {
	t.Helper()
	var list string
	for i, w := range workspaces {
		if i > 0 {
			list += ","
		}
		list += `"` + w + `"`
	}
	content := `{"workspaces":[` + list + `]}`
	writeEngineFile(t, filepath.Join(root, "package.json"), content)
}

func writePkg(t *testing.T, dir, pkgJSON string) {
	t.Helper()
	writeEngineFile(t, filepath.Join(dir, "package.json"), pkgJSON)
}

func writeEngineFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// case: S-179.41
func TestRunEmitsTaskResultBeforeSlowPeerCompletes(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	writePkg(t, filepath.Join(root, "packages", "slow"), `{"name":"@fixture/slow"}`)
	writePkg(t, filepath.Join(root, "packages", "fast"), `{"name":"@fixture/fast"}`)
	cfg := testConfig([]config.NamedCategory{
		{Name: "slow", Category: config.CategoryConfig{Match: []string{"packages/slow"}, Preset: "node-lib"}},
		{Name: "fast", Category: config.CategoryConfig{Match: []string{"packages/fast"}, Preset: "node-lib"}},
	})
	cfg.Tasks = map[string]config.TaskConfig{
		"build": {
			{Categories: []string{"slow"}, Command: `sh -c "sleep 12"`},
			{Categories: []string{"fast"}, Command: `sh -c "sleep 0.05"`},
		},
	}
	ws := mustWorkspace(t, root, cfg)
	resultReader, resultWriter := io.Pipe()
	completionLines := make(chan string, 2)
	go func() {
		scanner := bufio.NewScanner(resultReader)
		for scanner.Scan() {
			completionLines <- scanner.Text()
		}
		close(completionLines)
	}()
	slowFinished := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, err := Run(ws, cfg, RunOptions{
			Tasks: []string{"build"}, WSRoot: root, CacheRoot: filepath.Join(root, ".kb", "devkit-cache"), Concurrency: 2,
			OnResult: func(result TaskResult, _, _ int) {
				if _, err := fmt.Fprintf(resultWriter, "%s:%s\n", result.Package, result.Task); err != nil {
					t.Errorf("write completion line: %v", err)
				}
				if result.Package == "@fixture/slow" {
					close(slowFinished)
				}
			},
		})
		_ = resultWriter.Close()
		if err != nil {
			t.Errorf("Run error: %v", err)
		}
	}()
	t.Cleanup(func() { <-done })
	select {
	case line := <-completionLines:
		if line != "@fixture/fast:build" {
			t.Fatalf("first completion line = %q, want the fast task", line)
		}
		select {
		case <-slowFinished:
			t.Fatal("slow subprocess completed before the fast task's output line")
		default:
		}
	case <-done:
		t.Fatal("Run completed without emitting the fast task result while the slow task was still running")
	case <-time.After(testdeadline.Budget(t)):
		t.Fatal("fast task completion output was not emitted before the slow subprocess completed")
	}
	<-done
}

// case: S-179.41
func TestExecutorEmitsHeartbeatBeforeSlowSubprocessCompletes(t *testing.T) {
	root := t.TempDir()
	store, err := cache.NewLocalStore(filepath.Join(root, ".kb", "devkit-cache"))
	if err != nil {
		t.Fatal(err)
	}
	exec := NewExecutor(store, cache.NewManifestStore(filepath.Join(root, ".kb", "devkit-cache")), cache.NewStateStore(filepath.Join(root, ".kb", "devkit-cache")), root, filepath.Join(root, ".kb", "devkit-cache"), false)
	heartbeat := make(chan string, 1)
	exec.onHeartbeat = func(packageName, taskName string, elapsed time.Duration) {
		select {
		case heartbeat <- fmt.Sprintf("%s:%s elapsed %s", packageName, taskName, elapsed.Round(time.Millisecond)):
		default:
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _, _ = exec.runCommand(`sh -c "sleep 1"`, root, "@fixture/slow", "build", 100*time.Millisecond)
	}()
	select {
	case line := <-heartbeat:
		if line == "" {
			t.Fatal("heartbeat line was empty")
		}
	case <-done:
		t.Fatal("slow subprocess completed before its heartbeat")
	case <-time.After(testdeadline.Budget(t)):
		t.Fatal("heartbeat was not emitted before the slow subprocess completed")
	}
	<-done
}
