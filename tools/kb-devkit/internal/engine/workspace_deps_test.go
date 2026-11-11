package engine

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/kb-labs/devkit/internal/workspace"
)

func TestReadGoModuleEditParsesStdoutAndKeepsStderrDiagnosticOnly(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	moduleDir := filepath.Join(root, "module")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(moduleDir, 0o755); err != nil {
		t.Fatal(err)
	}
	goCommand := "#!/bin/sh\nprintf '%s\\n' '{\"Module\":{\"Path\":\"example.internal/module\"}}'\nprintf 'go: toolchain notice\\n' >&2\n"
	if err := os.WriteFile(filepath.Join(binDir, "go"), []byte(goCommand), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("HOME", t.TempDir())
	module, err := readGoModuleEdit(moduleDir)
	if err != nil {
		t.Fatal(err)
	}
	if module.Module.Path != "example.internal/module" {
		t.Fatalf("parsed module path = %q, want example.internal/module", module.Module.Path)
	}
}

func TestWorkspaceDepsReadsAllDependencySections(t *testing.T) {
	root := t.TempDir()

	// @kb/types is a workspace package listed in peerDependencies — it IS in pkgByName,
	// so it must be included (devkit doesn't filter by "workspace:*" syntax, only by membership).
	pkgByName := map[string]workspace.Package{
		"@kb/core":     {Name: "@kb/core", Dir: filepath.Join(root, "core")},
		"@kb/devkit":   {Name: "@kb/devkit", Dir: filepath.Join(root, "devkit")},
		"@kb/types":    {Name: "@kb/types", Dir: filepath.Join(root, "types")},
		"@kb/testing":  {Name: "@kb/testing", Dir: filepath.Join(root, "testing")},
		"@kb/optional": {Name: "@kb/optional", Dir: filepath.Join(root, "optional")},
	}

	pkgJSON := `{
		"name": "@kb/app",
		"dependencies":    {"@kb/core":    "workspace:*"},
		"optionalDependencies": {"@kb/optional": "workspace:*"},
		"devDependencies": {"@kb/devkit":  "workspace:*", "@kb/testing": "workspace:*"},
		"peerDependencies":{"@kb/types":   "workspace:*"}
	}`

	dir := filepath.Join(root, "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := WorkspaceDeps(dir, pkgByName)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)

	want := []string{"@kb/core", "@kb/devkit", "@kb/optional", "@kb/testing", "@kb/types"}
	if len(got) != len(want) {
		t.Fatalf("WorkspaceDeps = %v, want %v", got, want)
	}
	for i, w := range want {
		if got[i] != w {
			t.Fatalf("WorkspaceDeps[%d] = %q, want %q", i, got[i], w)
		}
	}
}

func TestWorkspaceDepsResolvesGoRequireWithoutReplace(t *testing.T) {
	root := t.TempDir()
	toolDir := filepath.Join(root, "tools", "runner")
	consumerDir := filepath.Join(root, "services", "host")
	if err := os.MkdirAll(toolDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(consumerDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(toolDir, "go.mod"), []byte("module example.internal/runner\n\ngo 1.22.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(consumerDir, "go.mod"), []byte("module example.internal/host\n\ngo 1.22.0\n\nrequire example.internal/runner v1.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkgByName := map[string]workspace.Package{
		"runner": {Name: "runner", Dir: toolDir},
	}
	got, err := WorkspaceDeps(consumerDir, pkgByName)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "runner" {
		t.Fatalf("WorkspaceDeps = %v, want [runner]", got)
	}
}

func TestWorkspaceDepsDeduplicatesAcrossSections(t *testing.T) {
	root := t.TempDir()

	pkgByName := map[string]workspace.Package{
		"@kb/shared": {Name: "@kb/shared", Dir: filepath.Join(root, "shared")},
	}

	// @kb/shared appears in both dependencies and devDependencies — must appear once.
	pkgJSON := `{
		"name": "@kb/app",
		"dependencies":    {"@kb/shared": "workspace:*"},
		"devDependencies": {"@kb/shared": "workspace:*"}
	}`

	dir := filepath.Join(root, "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := WorkspaceDeps(dir, pkgByName)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "@kb/shared" {
		t.Fatalf("WorkspaceDeps dedup = %v, want [@kb/shared]", got)
	}
}

func TestWorkspaceDepsFiltersExternalPackages(t *testing.T) {
	root := t.TempDir()

	pkgByName := map[string]workspace.Package{
		"@kb/internal": {Name: "@kb/internal", Dir: filepath.Join(root, "internal")},
	}

	// react and typescript are external — must not appear in result.
	pkgJSON := `{
		"name": "@kb/app",
		"dependencies":    {"@kb/internal": "workspace:*", "react": "^18.0.0"},
		"devDependencies": {"typescript": "^5.0.0"}
	}`

	dir := filepath.Join(root, "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := WorkspaceDeps(dir, pkgByName)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "@kb/internal" {
		t.Fatalf("WorkspaceDeps external filter = %v, want [@kb/internal]", got)
	}
}

func TestWorkspaceDepsEmptyOnMissingPackageJSON(t *testing.T) {
	root := t.TempDir()
	pkgByName := map[string]workspace.Package{}

	got, err := WorkspaceDeps(filepath.Join(root, "nonexistent"), pkgByName)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("WorkspaceDeps missing dir = %v, want empty", got)
	}
}

func TestWorkspaceDepsIncludesLocalGoModuleReplacement(t *testing.T) {
	root := t.TempDir()
	consumer := filepath.Join(root, "tools", "kb-runner")
	dependency := filepath.Join(root, "tools", "clikit")
	if err := os.MkdirAll(consumer, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dependency, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(consumer, "go.mod"), []byte("module fixture/kb-runner\n\ngo 1.22\n\nrequire github.com/kb-labs/clikit v0.0.0\n\nreplace github.com/kb-labs/clikit => ../clikit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkgByName := map[string]workspace.Package{
		"@fixture/kb-runner": {Name: "@fixture/kb-runner", Dir: consumer},
		"@fixture/clikit":    {Name: "@fixture/clikit", Dir: dependency},
	}

	got, err := WorkspaceDeps(consumer, pkgByName)
	if err != nil {
		t.Fatalf("WorkspaceDeps: %v", err)
	}
	if len(got) != 1 || got[0] != "@fixture/clikit" {
		t.Fatalf("WorkspaceDeps = %v; want local Go module replacement @fixture/clikit", got)
	}
}
