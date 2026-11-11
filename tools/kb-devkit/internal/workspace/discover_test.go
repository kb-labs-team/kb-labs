package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
)

func TestClassifyCarriesInternalToolReleaseLane(t *testing.T) {
	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{
		{Name: "internal-tool", Category: config.CategoryConfig{
			Match: []string{"tools/kb-runner"}, Preset: "go-binary", ReleaseLane: "internal-tool",
		}},
	}}}
	category, preset, language, releaseLane := classify("tools/kb-runner", cfg)
	if category != "internal-tool" || preset != "go-binary" || language != "go" || releaseLane != "internal-tool" {
		t.Fatalf("classify = (%q, %q, %q, %q)", category, preset, language, releaseLane)
	}
}

func TestTrackedUnownedFilesUsesPackageOwnershipAndIgnoresUntracked(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	mustWritePackage(t, filepath.Join(root, "packages", "alpha", "package.json"), `{"name":"@kb/alpha"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "alpha", "src", "index.ts"), "export {}\n")
	mustWritePackage(t, filepath.Join(root, "packages", "beta", "package.json"), `{"name":"@kb/beta"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "beta", "src", "index.ts"), "export {}\n")
	mustWritePackage(t, filepath.Join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
	if output, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	if output, err := exec.Command("git", "-C", root, "add", "--all").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, output)
	}

	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{
		{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
	}}}
	ws, err := New(root, cfg)
	if err != nil {
		t.Fatal(err)
	}
	mustWritePackage(t, filepath.Join(root, "untracked.txt"), "ignored\n")

	got, owned, modes, err := ws.TrackedFileOwnership()
	if err != nil {
		t.Fatalf("TrackedFiles: %v", err)
	}
	if len(got) != 2 || filepath.Base(got[0]) != "package.json" || filepath.Base(got[1]) != "pnpm-lock.yaml" {
		t.Fatalf("tracked unowned files = %v; want root package.json and pnpm-lock.yaml", got)
	}
	if len(owned["@kb/alpha"]) != 2 || len(owned["@kb/beta"]) != 2 {
		t.Fatalf("tracked package ownership = %v; want package.json and src file for alpha and beta", owned)
	}
	for _, path := range append(append([]string(nil), got...), owned["@kb/alpha"]...) {
		if modes[filepath.Clean(path)].Mode != 0100644 {
			t.Errorf("tracked mode for %s = %o; want 100644", path, modes[filepath.Clean(path)].Mode)
		}
	}
}

func TestDiscoverPackagesFallsBackToPackageJSONWorkspaces(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	mustWritePackage(t, filepath.Join(root, "packages", "alpha", "package.json"), `{"name":"@kb/alpha"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "beta", "package.json"), `{"name":"@kb/beta"}`)

	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
			},
		},
	}

	pkgs, err := discoverPackages(root, cfg)
	if err != nil {
		t.Fatalf("discoverPackages error: %v", err)
	}
	if len(pkgs) != 2 {
		t.Fatalf("packages count = %d, want 2", len(pkgs))
	}
	if pkgs[0].ReleaseLane != "" || pkgs[1].ReleaseLane != "" {
		t.Fatalf("default package release lanes = %q and %q, want empty default", pkgs[0].ReleaseLane, pkgs[1].ReleaseLane)
	}

	names := []string{pkgs[0].Name, pkgs[1].Name}
	sort.Strings(names)
	if names[0] != "@kb/alpha" || names[1] != "@kb/beta" {
		t.Fatalf("package names = %#v", names)
	}
}

func TestDiscoverPackagesDefaultsToGatingExceptDeclaredInternalTool(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*","tools/*"]}`)
	mustWritePackage(t, filepath.Join(root, "packages", "host", "package.json"), `{"name":"@kb/host"}`)
	mustWritePackage(t, filepath.Join(root, "tools", "runner", "package.json"), `{"name":"@kb/runner"}`)

	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{
		{Name: "host", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
		{Name: "internal-tool", Category: config.CategoryConfig{Match: []string{"tools/runner"}, Preset: "go-binary", ReleaseLane: "internal-tool"}},
	}}}

	pkgs, err := discoverPackages(root, cfg)
	if err != nil {
		t.Fatalf("discoverPackages error: %v", err)
	}
	if len(pkgs) != 2 {
		t.Fatalf("packages count = %d, want 2", len(pkgs))
	}
	lanes := map[string]string{}
	for _, pkg := range pkgs {
		lanes[pkg.Name] = pkg.ReleaseLane
	}
	if lanes["@kb/host"] != "" || lanes["@kb/runner"] != "internal-tool" {
		t.Fatalf("release lane defaults = %#v, want host default gating and runner internal-tool", lanes)
	}
}

func TestExpandPatternCollectsRecursivePackagesAndSkipsIgnoredDirs(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "packages", "alpha", "package.json"), `{"name":"alpha"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "nested", "beta", "package.json"), `{"name":"beta"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "node_modules", "ignored", "package.json"), `{"name":"ignored"}`)
	mustWritePackage(t, filepath.Join(root, "packages", ".hidden", "secret", "package.json"), `{"name":"secret"}`)

	got := expandPattern(root, "packages/**", 3)
	sort.Strings(got)

	want := []string{
		filepath.Join(root, "packages", "alpha"),
		filepath.Join(root, "packages", "nested", "beta"),
	}
	if len(got) != len(want) {
		t.Fatalf("expandPattern count = %d, want %d (%#v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expandPattern[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestClassifyAndPackageByPath(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "infra", "kb-labs-devkit-bin")
	mustWritePackage(t, filepath.Join(pkgDir, "package.json"), `{"name":"@kb-labs/devkit-bin"}`)
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["infra/*"]}`)

	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "tools", Category: config.CategoryConfig{Match: []string{"infra/*"}, Preset: "go-binary"}},
			},
		},
	}

	ws, err := New(root, cfg)
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}
	if len(ws.Packages) != 1 {
		t.Fatalf("packages count = %d, want 1", len(ws.Packages))
	}

	pkg := ws.Packages[0]
	if pkg.Category != "tools" || pkg.Preset != "go-binary" || pkg.Language != "go" {
		t.Fatalf("unexpected package classification: %+v", pkg)
	}

	ownedPath := filepath.Join(pkgDir, "cmd", "main.go")
	if err := os.MkdirAll(filepath.Dir(ownedPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(ownedPath, []byte("package main"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	owner, ok := ws.PackageByPath(ownedPath)
	if !ok || owner.Name != "@kb-labs/devkit-bin" {
		t.Fatalf("PackageByPath = (%+v, %v), want @kb-labs/devkit-bin", owner, ok)
	}

	if got := ws.FilterByName([]string{"@kb-labs/devkit-bin"}); len(got) != 1 {
		t.Fatalf("FilterByName count = %d, want 1", len(got))
	}
	if got := ws.FilterByCategory("tools"); len(got) != 1 {
		t.Fatalf("FilterByCategory count = %d, want 1", len(got))
	}
}

func TestMatchPatternHandlesLiteralStarAndRecursiveSuffix(t *testing.T) {
	tests := []struct {
		pattern string
		path    string
		want    bool
	}{
		{pattern: "infra/*", path: "infra/kb-labs-devkit-bin", want: true},
		{pattern: "infra/*", path: "infra/tools/bin", want: false},
		{pattern: "platform/*/packages/**", path: "platform/kb-labs-cli/packages/cli-bin/src", want: true},
		{pattern: "platform/*/packages/**", path: "platform/kb-labs-cli", want: false},
	}

	for _, tt := range tests {
		if got := matchPattern(tt.pattern, tt.path); got != tt.want {
			t.Fatalf("matchPattern(%q, %q) = %v, want %v", tt.pattern, tt.path, got, tt.want)
		}
	}
}

func TestReadPackageNameFallsBackToDirectoryName(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "no-name")
	mustWritePackage(t, filepath.Join(dir, "package.json"), `{}`)
	if got := readPackageName(dir); got != "no-name" {
		t.Fatalf("readPackageName fallback = %q, want no-name", got)
	}
}

func TestDiscoverAllIncludesUncategorizedPackages(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*","apps/*/src/*"]}`)
	mustWritePackage(t, filepath.Join(root, "packages", "lib-a", "package.json"), `{"name":"@kb/lib-a"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "lib-b", "package.json"), `{"name":"@kb/lib-b"}`)
	// Nested app — not covered by categories that only match "packages/*"
	mustWritePackage(t, filepath.Join(root, "apps", "web", "src", "app", "package.json"), `{"name":"@kb/web-app"}`)

	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
			},
		},
	}

	// discoverPackages filters out uncategorized — DiscoverAll must not.
	categorized, err := discoverPackages(root, cfg)
	if err != nil {
		t.Fatalf("discoverPackages: %v", err)
	}
	if len(categorized) != 2 {
		t.Fatalf("discoverPackages count = %d, want 2", len(categorized))
	}

	all, err := DiscoverAll(root, cfg)
	if err != nil {
		t.Fatalf("DiscoverAll: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("DiscoverAll count = %d, want 3", len(all))
	}

	names := make(map[string]bool)
	for _, p := range all {
		names[p.Name] = true
	}
	for _, want := range []string{"@kb/lib-a", "@kb/lib-b", "@kb/web-app"} {
		if !names[want] {
			t.Fatalf("DiscoverAll missing %q, got %v", want, names)
		}
	}
}

func TestDiscoverAllRespectsExcludeFromCfg(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*","fixtures/*"]}`)
	mustWritePackage(t, filepath.Join(root, "packages", "lib", "package.json"), `{"name":"@kb/lib"}`)
	mustWritePackage(t, filepath.Join(root, "fixtures", "test-pkg", "package.json"), `{"name":"@kb/fixture"}`)

	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Exclude: []string{"fixtures/*"},
		},
	}

	all, err := DiscoverAll(root, cfg)
	if err != nil {
		t.Fatalf("DiscoverAll: %v", err)
	}
	if len(all) != 1 || all[0].Name != "@kb/lib" {
		t.Fatalf("DiscoverAll = %v, want only @kb/lib", all)
	}
}

func TestDiscoverAllSkipsNegationPatterns(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - \"!packages/ignored\"\n")
	mustWritePackage(t, filepath.Join(root, "packages", "good", "package.json"), `{"name":"@kb/good"}`)
	mustWritePackage(t, filepath.Join(root, "packages", "ignored", "package.json"), `{"name":"@kb/ignored"}`)

	all, err := DiscoverAll(root, nil)
	if err != nil {
		t.Fatalf("DiscoverAll: %v", err)
	}
	// "!packages/ignored" negation is skipped by DiscoverAll (we rely on cfg.Exclude for exclusions).
	// The important thing is it doesn't crash and returns at least the good package.
	names := make(map[string]bool)
	for _, p := range all {
		names[p.Name] = true
	}
	if !names["@kb/good"] {
		t.Fatalf("DiscoverAll missing @kb/good, got %v", names)
	}
}

func mustWritePackage(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestCategoryPatternsDiscoverNonPnpmPackagesAndResolveBuildTask(t *testing.T) {
	root := t.TempDir()
	mustWritePackage(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	mustWritePackage(t, filepath.Join(root, "packages", "library", "package.json"), `{"name":"@kb/library"}`)
	mustWritePackage(t, filepath.Join(root, "e2e", "fixtures", "adapters", "deterministic", "package.json"), `{"name":"@kb/e2e-deterministic"}`)
	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{
			{Name: "library", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
			{Name: "e2e-pack-extra", Category: config.CategoryConfig{Match: []string{"e2e/fixtures/adapters/*"}, Preset: "node-lib"}},
		}},
		Tasks: map[string]config.TaskConfig{"build": {
			{Categories: []string{"library"}, Command: "tsup"},
			{Categories: []string{"e2e-pack-extra"}, Command: "node build-fixture.mjs"},
		}},
	}
	ws, err := New(root, cfg)
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}
	if len(ws.Packages) != 2 {
		t.Fatalf("discovered package count = %d, want pnpm package plus category-declared fixture", len(ws.Packages))
	}
	fixture, ok := ws.PackageByPath(filepath.Join(root, "e2e", "fixtures", "adapters", "deterministic"))
	if !ok || fixture.Category != "e2e-pack-extra" || !fixture.BuildTarget {
		t.Fatalf("fixture graph entry = (%+v, %v), want category and resolved build task", fixture, ok)
	}
	if fixture.PnpmMember {
		t.Fatalf("fixture package = %+v, category-discovered fixture must not be a pnpm member", fixture)
	}
	if library, ok := ws.PackageByPath(filepath.Join(root, "packages", "library")); !ok || !library.PnpmMember {
		t.Fatalf("workspace package = (%+v, %v), want pnpm membership", library, ok)
	}
	cfg.Tasks["build"] = config.TaskConfig{{Categories: []string{"library"}, Command: "tsup"}}
	withoutTarget, err := New(root, cfg)
	if err != nil {
		t.Fatalf("workspace.New after task mutation error: %v", err)
	}
	fixture, ok = withoutTarget.PackageByPath(filepath.Join(root, "e2e", "fixtures", "adapters", "deterministic"))
	if !ok || fixture.BuildTarget {
		t.Fatalf("fixture build-target flag = (%+v, %v), want discovered package without a build target", fixture, ok)
	}
}
