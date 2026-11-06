package engine

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestResolveTaskDefResolvesMatchingVariantAndDefaultCache(t *testing.T) {
	disabled := false
	cfg := &config.DevkitConfig{
		Tasks: map[string]config.TaskConfig{
			"build": {
				{Command: "echo default", Inputs: []string{"src/**"}},
				{Categories: []string{"tools"}, Command: "go build", Inputs: []string{"*.go"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}, Cache: &disabled},
			},
		},
	}

	got := ResolveTaskDef(cfg, "build", "tools")
	if got == nil {
		t.Fatal("ResolveTaskDef returned nil")
	}
	if got.Command != "go build" || got.Cache || len(got.Deps) != 1 {
		t.Fatalf("unexpected task def: %+v", got)
	}

	got = ResolveTaskDef(cfg, "build", "unknown")
	if got == nil || got.Command != "echo default" || !got.Cache {
		t.Fatalf("fallback task def = %+v, want catch-all with cache=true", got)
	}

	if got := ResolveTaskDef(cfg, "missing", "tools"); got != nil {
		t.Fatalf("ResolveTaskDef missing task = %+v, want nil", got)
	}
}

func TestBuildDAGRejectsPackageTaskWithMissingScript(t *testing.T) {
	root := t.TempDir()
	writeRootWorkspace(t, root)
	pkg := newPkg(t, root, "e2e/mcp", "@kb-labs/e2e-mcp", `{"name":"@kb-labs/e2e-mcp","scripts":{"e2e":"playwright test"}}`)
	pkg.Category = "e2e-suite"
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{pkg}}
	cfg := &config.DevkitConfig{Tasks: map[string]config.TaskConfig{
		"test": {{Categories: []string{"e2e-suite"}, Command: "pnpm run test"}},
	}}

	_, err := buildDAG(ws.Packages, []string{"test"}, cfg, ws)
	if err == nil {
		t.Fatal("buildDAG accepted pnpm run test without a package test script")
	}
	if got, want := err.Error(), `DevKit task "test" for package "@kb-labs/e2e-mcp" invokes missing package script "test"; declare it in package.json or remove the task assignment, then rerun kb-devkit run test --packages @kb-labs/e2e-mcp`; got != want {
		t.Fatalf("buildDAG error = %q, want %q", got, want)
	}
}

func TestBuildDAGAndAffectedPackages(t *testing.T) {
	root := t.TempDir()
	writeRootWorkspace(t, root)
	libA := newPkg(t, root, "packages/a", "@kb/a", `{"name":"@kb/a","dependencies":{"@kb/b":"workspace:*"}}`)
	libB := newPkg(t, root, "packages/b", "@kb/b", `{"name":"@kb/b"}`)
	app := newPkg(t, root, "apps/app", "@kb/app", `{"name":"@kb/app","dependencies":{"@kb/a":"workspace:*"}}`)

	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*", "apps/*"}, Preset: "node-lib"}},
			},
		},
		Tasks: map[string]config.TaskConfig{
			"build": {{Command: "echo build"}},
			"test":  {{Command: "echo test", Deps: []string{"build", "^build"}}},
		},
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}

	nodes, err := buildDAG(ws.Packages, []string{"build", "test"}, cfg, ws)
	if err != nil {
		t.Fatalf("buildDAG error: %v", err)
	}

	appTest := nodes[nodeKey{pkg: "@kb/app", task: "test"}]
	if len(appTest.deps) != 2 {
		t.Fatalf("app test deps = %#v, want self build + dep build", appTest.deps)
	}

	changed := filepath.Join(libB.Dir, "src", "index.ts")
	if err := os.MkdirAll(filepath.Dir(changed), 0o755); err != nil {
		t.Fatalf("mkdir changed file: %v", err)
	}
	if err := os.WriteFile(changed, []byte("export {}"), 0o644); err != nil {
		t.Fatalf("write changed file: %v", err)
	}
	script := filepath.Join(root, "changed-files.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$1\"\n"), 0o755); err != nil {
		t.Fatalf("write changed-files.sh: %v", err)
	}

	cfg.Affected = config.AffectedConfig{
		Strategy: "command",
		Command:  "sh " + script + " " + changed,
	}

	affected, err := AffectedPackages(ws, cfg)
	if err != nil {
		t.Fatalf("AffectedPackages error: %v", err)
	}
	if len(affected.Packages) != 3 {
		t.Fatalf("affected count = %d, want 3", len(affected.Packages))
	}

	_ = libA
	_ = libB
	_ = app
}

func TestCollectChangedFilesHelpers(t *testing.T) {
	root := t.TempDir()

	files, err := collectChangedFiles(root, "command", "")
	if err == nil || len(files) != 0 {
		t.Fatalf("collectChangedFiles command without command = (%v, %v), want error", files, err)
	}

	raw := []byte("a.txt\n/tmp/abs.txt\na.txt\n")
	parsed := parseFileList(root, filepath.Join(root, "repo"), raw)
	if len(parsed) != 2 {
		t.Fatalf("parseFileList = %#v, want deduped 2 items", parsed)
	}

	gitmodules := "[submodule \"x\"]\n\tpath = plugins/foo\n[submodule \"y\"]\n\tpath = infra/bar\n"
	if err := os.WriteFile(filepath.Join(root, ".gitmodules"), []byte(gitmodules), 0o644); err != nil {
		t.Fatalf("write .gitmodules: %v", err)
	}
	roots, err := readSubmoduleRoots(root)
	if err != nil {
		t.Fatalf("readSubmoduleRoots error: %v", err)
	}
	if len(roots) != 2 {
		t.Fatalf("roots = %#v, want 2", roots)
	}
}

func newPkg(t *testing.T, root, rel, name, pkgJSON string) workspace.Package {
	t.Helper()
	dir := filepath.Join(root, rel)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	return workspace.Package{Name: name, Dir: dir, Category: "libs", RelPath: rel}
}

func writeRootWorkspace(t *testing.T, root string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"workspaces":["packages/*","apps/*"]}`), 0o644); err != nil {
		t.Fatalf("write root package.json: %v", err)
	}
}
