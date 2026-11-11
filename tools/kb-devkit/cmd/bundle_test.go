package cmd

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/kb-labs/devkit/internal/workspace"
	"gopkg.in/yaml.v3"
)

// ─── slugify ──────────────────────────────────────────────────────────────────

func TestSlugify(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"@kb-labs/docs-site", "docs-site"},
		{"@scope/pkg", "pkg"},
		{"unscoped", "unscoped"},
		{"@scope/nested/deep", "deep"},
	}
	for _, tt := range tests {
		if got := slugify(tt.in); got != tt.want {
			t.Errorf("slugify(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ─── resolvePackageFrom ───────────────────────────────────────────────────────

func TestResolvePackageFromByName(t *testing.T) {
	pkgs := []workspace.Package{
		{Name: "@kb/core", Dir: "/ws/core", RelPath: "core"},
		{Name: "@kb/app", Dir: "/ws/apps/app", RelPath: "apps/app"},
	}
	p, err := resolvePackageFrom(pkgs, "/ws", "@kb/app")
	if err != nil || p.Name != "@kb/app" {
		t.Fatalf("resolvePackageFrom by name = (%v, %v), want @kb/app", p, err)
	}
}

func TestResolvePackageFromByPath(t *testing.T) {
	pkgs := []workspace.Package{
		{Name: "@kb/app", Dir: "/ws/apps/app", RelPath: "apps/app"},
	}
	p, err := resolvePackageFrom(pkgs, "/ws", "apps/app")
	if err != nil || p.Name != "@kb/app" {
		t.Fatalf("resolvePackageFrom by path = (%v, %v), want @kb/app", p, err)
	}
}

func TestResolvePackageFromNotFound(t *testing.T) {
	pkgs := []workspace.Package{
		{Name: "@kb/core", Dir: "/ws/core", RelPath: "core"},
	}
	_, err := resolvePackageFrom(pkgs, "/ws", "missing")
	if err == nil {
		t.Fatal("expected error for missing package, got nil")
	}
}

// ─── buildClosure ─────────────────────────────────────────────────────────────

func TestBuildClosureIncludesTransitiveDeps(t *testing.T) {
	root := t.TempDir()

	// Graph: app → lib-a → lib-b
	libBDir := mkPkg(t, root, "packages/lib-b", `{"name":"@kb/lib-b"}`)
	libADir := mkPkg(t, root, "packages/lib-a", `{"name":"@kb/lib-a","dependencies":{"@kb/lib-b":"workspace:*"}}`)
	appDir := mkPkg(t, root, "apps/app", `{"name":"@kb/app","dependencies":{"@kb/lib-a":"workspace:*"}}`)

	pkgByName := map[string]workspace.Package{
		"@kb/lib-b": {Name: "@kb/lib-b", Dir: libBDir, RelPath: "packages/lib-b"},
		"@kb/lib-a": {Name: "@kb/lib-a", Dir: libADir, RelPath: "packages/lib-a"},
		"@kb/app":   {Name: "@kb/app", Dir: appDir, RelPath: "apps/app"},
	}

	closure := mustBuildClosure(t, pkgByName["@kb/app"], pkgByName, false)

	names := make([]string, len(closure))
	for i, p := range closure {
		names[i] = p.Name
	}
	sort.Strings(names)

	want := []string{"@kb/app", "@kb/lib-a", "@kb/lib-b"}
	if len(names) != len(want) {
		t.Fatalf("closure = %v, want %v", names, want)
	}
	for i, w := range want {
		if names[i] != w {
			t.Fatalf("closure[%d] = %q, want %q", i, names[i], w)
		}
	}
}

func TestBuildClosureIncludesDevDeps(t *testing.T) {
	root := t.TempDir()

	devkitDir := mkPkg(t, root, "infra/devkit", `{"name":"@kb/devkit"}`)
	libDir := mkPkg(t, root, "packages/lib", `{"name":"@kb/lib","devDependencies":{"@kb/devkit":"workspace:*"}}`)

	pkgByName := map[string]workspace.Package{
		"@kb/devkit": {Name: "@kb/devkit", Dir: devkitDir, RelPath: "infra/devkit"},
		"@kb/lib":    {Name: "@kb/lib", Dir: libDir, RelPath: "packages/lib"},
	}

	closure := mustBuildClosure(t, pkgByName["@kb/lib"], pkgByName, false)

	names := make(map[string]bool)
	for _, p := range closure {
		names[p.Name] = true
	}
	if !names["@kb/devkit"] {
		t.Fatalf("closure missing @kb/devkit (devDependency), got %v", names)
	}
}

func TestBuildClosureIsSortedByRelPath(t *testing.T) {
	root := t.TempDir()

	bDir := mkPkg(t, root, "packages/b", `{"name":"@kb/b"}`)
	aDir := mkPkg(t, root, "packages/a", `{"name":"@kb/a","dependencies":{"@kb/b":"workspace:*"}}`)

	pkgByName := map[string]workspace.Package{
		"@kb/b": {Name: "@kb/b", Dir: bDir, RelPath: "packages/b"},
		"@kb/a": {Name: "@kb/a", Dir: aDir, RelPath: "packages/a"},
	}

	closure := mustBuildClosure(t, pkgByName["@kb/a"], pkgByName, false)

	if len(closure) != 2 {
		t.Fatalf("closure len = %d, want 2", len(closure))
	}
	if closure[0].RelPath >= closure[1].RelPath {
		t.Fatalf("closure not sorted: %q >= %q", closure[0].RelPath, closure[1].RelPath)
	}
}

func TestBuildClosureHandlesDiamondDeps(t *testing.T) {
	// app → lib-a → shared
	//     → lib-b → shared
	// shared must appear once
	root := t.TempDir()

	sharedDir := mkPkg(t, root, "packages/shared", `{"name":"@kb/shared"}`)
	libADir := mkPkg(t, root, "packages/lib-a", `{"name":"@kb/lib-a","dependencies":{"@kb/shared":"workspace:*"}}`)
	libBDir := mkPkg(t, root, "packages/lib-b", `{"name":"@kb/lib-b","dependencies":{"@kb/shared":"workspace:*"}}`)
	appDir := mkPkg(t, root, "apps/app", `{"name":"@kb/app","dependencies":{"@kb/lib-a":"workspace:*","@kb/lib-b":"workspace:*"}}`)

	pkgByName := map[string]workspace.Package{
		"@kb/shared": {Name: "@kb/shared", Dir: sharedDir, RelPath: "packages/shared"},
		"@kb/lib-a":  {Name: "@kb/lib-a", Dir: libADir, RelPath: "packages/lib-a"},
		"@kb/lib-b":  {Name: "@kb/lib-b", Dir: libBDir, RelPath: "packages/lib-b"},
		"@kb/app":    {Name: "@kb/app", Dir: appDir, RelPath: "apps/app"},
	}

	closure := mustBuildClosure(t, pkgByName["@kb/app"], pkgByName, false)
	if len(closure) != 4 {
		names := make([]string, len(closure))
		for i, p := range closure {
			names[i] = p.Name
		}
		t.Fatalf("diamond closure = %v (len %d), want 4 unique packages", names, len(closure))
	}
}

// ─── writeManifests ───────────────────────────────────────────────────────────

func TestWriteManifestsCreatesWorkspaceYAMLAndPackageJSONFiles(t *testing.T) {
	root := t.TempDir()
	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "pnpm-workspace.yaml"), []byte("packages:\n  - '**/*'\nallowBuilds:\n  esbuild: true\noverrides:\n  react: ^19.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Create source package.json files.
	mkPkg(t, root, "packages/lib-a", `{"name":"@kb/lib-a"}`)
	mkPkg(t, root, "packages/lib-b", `{"name":"@kb/lib-b"}`)

	closure := []workspace.Package{
		{Name: "@kb/lib-a", Dir: filepath.Join(root, "packages/lib-a"), RelPath: "packages/lib-a"},
		{Name: "@kb/lib-b", Dir: filepath.Join(root, "packages/lib-b"), RelPath: "packages/lib-b"},
	}

	if err := writeManifests(outDir, root, closure); err != nil {
		t.Fatalf("writeManifests: %v", err)
	}

	// Check pnpm-workspace.yaml.
	data, err := os.ReadFile(filepath.Join(outDir, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatalf("read pnpm-workspace.yaml: %v", err)
	}
	var ws struct {
		Packages    []string               `yaml:"packages"`
		AllowBuilds map[string]bool        `yaml:"allowBuilds"`
		Overrides   map[string]interface{} `yaml:"overrides"`
	}
	if err := yaml.Unmarshal(data, &ws); err != nil {
		t.Fatalf("parse pnpm-workspace.yaml: %v", err)
	}
	if len(ws.Packages) != 2 {
		t.Fatalf("pnpm-workspace.yaml packages = %v, want 2", ws.Packages)
	}
	if !ws.AllowBuilds["esbuild"] || ws.Overrides["react"] != "^19.0.0" {
		t.Fatalf("workspace settings were not preserved: allowBuilds=%v overrides=%v", ws.AllowBuilds, ws.Overrides)
	}

	// Check package.json files were copied.
	for _, rel := range []string{"packages/lib-a/package.json", "packages/lib-b/package.json"} {
		if _, err := os.Stat(filepath.Join(outDir, rel)); err != nil {
			t.Errorf("missing %s: %v", rel, err)
		}
	}
}

func TestWriteManifestsWorkspaceYAMLHasExactPaths(t *testing.T) {
	root := t.TempDir()
	outDir := t.TempDir()
	mkPkg(t, root, "sites/web/apps/docs", `{"name":"@kb/docs-site"}`)

	closure := []workspace.Package{
		{Name: "@kb/docs-site", Dir: filepath.Join(root, "sites/web/apps/docs"), RelPath: "sites/web/apps/docs"},
	}

	if err := writeManifests(outDir, root, closure); err != nil {
		t.Fatalf("writeManifests: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(outDir, "pnpm-workspace.yaml"))
	var ws struct {
		Packages []string `yaml:"packages"`
	}
	yaml.Unmarshal(data, &ws)

	if len(ws.Packages) != 1 || ws.Packages[0] != "sites/web/apps/docs" {
		t.Fatalf("pnpm-workspace.yaml = %v, want exact path [sites/web/apps/docs]", ws.Packages)
	}
}

// ─── copyRootFiles ────────────────────────────────────────────────────────────

func TestCopyRootFilesCopiesToOutDir(t *testing.T) {
	wsRoot := t.TempDir()
	outDir := t.TempDir()

	if err := os.WriteFile(filepath.Join(wsRoot, "package.json"), []byte(`{"name":"root"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "pnpm-lock.yaml"), []byte("lockfileVersion: '9.0'\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := copyRootFiles(outDir, wsRoot); err != nil {
		t.Fatalf("copyRootFiles: %v", err)
	}

	for _, f := range []string{"package.json", "pnpm-lock.yaml"} {
		if _, err := os.Stat(filepath.Join(outDir, f)); err != nil {
			t.Errorf("missing %s in outDir", f)
		}
	}
}

func TestCopyRootFilesSilentlySkipsAbsentLockfile(t *testing.T) {
	wsRoot := t.TempDir()
	outDir := t.TempDir()

	if err := os.WriteFile(filepath.Join(wsRoot, "package.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// No pnpm-lock.yaml — must not error.
	if err := copyRootFiles(outDir, wsRoot); err != nil {
		t.Fatalf("copyRootFiles without lockfile: %v", err)
	}
}

// ─── copySources ─────────────────────────────────────────────────────────────

func TestCopySourcesSkipsIgnoredDirs(t *testing.T) {
	root := t.TempDir()
	outDir := t.TempDir()

	pkgDir := filepath.Join(root, "packages", "lib")
	must(t, os.MkdirAll(filepath.Join(pkgDir, "src"), 0o755))
	must(t, os.MkdirAll(filepath.Join(pkgDir, "node_modules", "react"), 0o755))
	must(t, os.MkdirAll(filepath.Join(pkgDir, "dist"), 0o755))
	must(t, os.MkdirAll(filepath.Join(pkgDir, ".next"), 0o755))
	must(t, os.WriteFile(filepath.Join(pkgDir, "src", "index.ts"), []byte("export {}"), 0o644))
	must(t, os.WriteFile(filepath.Join(pkgDir, "node_modules", "react", "index.js"), []byte(""), 0o644))
	must(t, os.WriteFile(filepath.Join(pkgDir, "dist", "index.js"), []byte(""), 0o644))
	must(t, os.WriteFile(filepath.Join(pkgDir, ".next", "server.js"), []byte(""), 0o644))
	must(t, os.WriteFile(filepath.Join(pkgDir, "debug.log"), []byte(""), 0o644))

	closure := []workspace.Package{
		{Name: "@kb/lib", Dir: pkgDir, RelPath: "packages/lib"},
	}

	if err := copySources(outDir, closure); err != nil {
		t.Fatalf("copySources: %v", err)
	}

	// src/index.ts must be present.
	if _, err := os.Stat(filepath.Join(outDir, "packages", "lib", "src", "index.ts")); err != nil {
		t.Error("src/index.ts not copied")
	}

	// These must be absent.
	for _, absent := range []string{
		filepath.Join(outDir, "packages", "lib", "node_modules"),
		filepath.Join(outDir, "packages", "lib", "dist"),
		filepath.Join(outDir, "packages", "lib", ".next"),
		filepath.Join(outDir, "packages", "lib", "debug.log"),
	} {
		if _, err := os.Stat(absent); err == nil {
			t.Errorf("expected %s to be absent, but it exists", absent)
		}
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// mkPkg creates a package directory with a package.json and returns the dir path.
func mkPkg(t *testing.T, root, rel, pkgJSON string) string {
	t.Helper()
	dir := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkgJSON), 0o644); err != nil {
		t.Fatalf("write package.json %s: %v", rel, err)
	}
	return dir
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func mustBuildClosure(t *testing.T, target workspace.Package, packages map[string]workspace.Package, prod bool) []workspace.Package {
	t.Helper()
	closure, err := buildClosure(target, packages, prod)
	if err != nil {
		t.Fatalf("buildClosure: %v", err)
	}
	return closure
}
