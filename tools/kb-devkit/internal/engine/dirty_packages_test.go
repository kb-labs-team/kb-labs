package engine

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// makeWS builds a minimal Workspace from a slice of package names.
// Packages are in the order provided — workspace order is preserved.
func makeWS(names ...string) *workspace.Workspace {
	pkgs := make([]workspace.Package, len(names))
	for i, n := range names {
		pkgs[i] = workspace.Package{Name: n, Dir: "/fake/" + n}
	}
	return &workspace.Workspace{Root: "/fake", Packages: pkgs}
}

func TestDirtyPackagesIncludesNeverBuilt(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), ".kb", "devkit")
	ws := makeWS("@kb/app")

	got, err := DirtyPackages(ws, &config.DevkitConfig{Tasks: map[string]config.TaskConfig{"build": {{Command: "true"}}}}, []string{"build"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "@kb/app" {
		t.Fatalf("DirtyPackages = %v, want [@kb/app] (no state file = dirty)", got)
	}
}

func TestDirtyPackagesExcludesCleanState(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@kb/app"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	initTrackedFixture(t, root)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	states := cache.NewStateStore(cacheRoot)
	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{Name: "app", Category: config.CategoryConfig{Match: []string{"packages/app"}, Preset: "node-lib"}}}}, Tasks: map[string]config.TaskConfig{"build": {{Command: "true"}}}}
	def := TaskDef{Name: "build", Command: "true", Cache: true}
	ws := mustWorkspace(t, root, cfg)
	global, owned, dependencies, err := workspaceInputDigests(ws)
	if err != nil {
		t.Fatal(err)
	}
	inputHash, err := hashTaskInputs(ws.Packages[0], def, nil, cache.RuntimeFingerprint(), global, owned["@kb/app"], dependencies["@kb/app"])
	if err != nil {
		t.Fatal(err)
	}
	if err := states.SetClean("@kb/app", "build", inputHash); err != nil {
		t.Fatalf("SetClean: %v", err)
	}

	got, err := DirtyPackages(ws, cfg, []string{"build"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("DirtyPackages = %v, want [] (state is CLEAN)", got)
	}
}

func TestDirtyPackagesIncludesDirtyState(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), ".kb", "devkit")
	states := cache.NewStateStore(cacheRoot)
	if err := states.SetDirty("@kb/app", "build", "last_run_failed"); err != nil {
		t.Fatalf("SetDirty: %v", err)
	}
	ws := makeWS("@kb/app")

	got, err := DirtyPackages(ws, &config.DevkitConfig{Tasks: map[string]config.TaskConfig{"build": {{Command: "true"}}}}, []string{"build"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "@kb/app" {
		t.Fatalf("DirtyPackages = %v, want [@kb/app] (state is DIRTY)", got)
	}
}

func TestDirtyPackagesSchedulesTaskWhenInputHashCannotBeRead(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "packages", "app")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@kb/app"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	initTrackedFixture(t, root)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	if err := cache.NewStateStore(cacheRoot).SetClean("@kb/app", "build", "last-successful-hash"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(pkgDir, "package.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(pkgDir); err != nil {
		t.Fatal(err)
	}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{{Name: "@kb/app", Dir: pkgDir}}}
	cfg := &config.DevkitConfig{Tasks: map[string]config.TaskConfig{"build": {{Command: "true"}}}}

	got, err := DirtyPackages(ws, cfg, []string{"build"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "@kb/app" {
		t.Fatalf("DirtyPackages after input hash read error = %v, want [@kb/app] so Executor can report it", got)
	}
}

func TestDirtyPackagesAllTasksMustBeClean(t *testing.T) {
	root := t.TempDir()
	writeWorkspaceRoot(t, root, []string{"packages/*"})
	pkgDir := filepath.Join(root, "packages", "app")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@kb/app"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	initTrackedFixture(t, root)
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	states := cache.NewStateStore(cacheRoot)
	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{Name: "app", Category: config.CategoryConfig{Match: []string{"packages/app"}, Preset: "node-lib"}}}}, Tasks: map[string]config.TaskConfig{"build": {{Command: "true"}}, "test": {{Command: "true"}}}}
	ws := mustWorkspace(t, root, cfg)
	global, owned, dependencies, err := workspaceInputDigests(ws)
	if err != nil {
		t.Fatal(err)
	}
	buildHash, err := hashTaskInputs(ws.Packages[0], *ResolveTaskDef(cfg, "build", ""), nil, cache.RuntimeFingerprint(), global, owned[ws.Packages[0].Name], dependencies[ws.Packages[0].Name])
	if err != nil {
		t.Fatal(err)
	}
	testHash, err := hashTaskInputs(ws.Packages[0], *ResolveTaskDef(cfg, "test", ""), nil, cache.RuntimeFingerprint(), global, owned[ws.Packages[0].Name], dependencies[ws.Packages[0].Name])
	if err != nil {
		t.Fatal(err)
	}
	// build is clean but test is dirty
	if err := states.SetClean("@kb/app", "build", buildHash); err != nil {
		t.Fatalf("SetClean build: %v", err)
	}
	if err := states.SetDirty("@kb/app", "test", "last_run_failed"); err != nil {
		t.Fatalf("SetDirty test: %v", err)
	}
	got, err := DirtyPackages(ws, cfg, []string{"build", "test"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "@kb/app" {
		t.Fatalf("DirtyPackages = %v, want [@kb/app] (test task is DIRTY)", got)
	}

	// Now fix test state — both clean → excluded
	if err := states.SetClean("@kb/app", "test", testHash); err != nil {
		t.Fatalf("SetClean test: %v", err)
	}
	got2, err := DirtyPackages(ws, cfg, []string{"build", "test"}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) != 0 {
		t.Fatalf("DirtyPackages = %v, want [] (all tasks CLEAN)", got2)
	}
}

func initTrackedFixture(t *testing.T, root string) {
	t.Helper()
	for _, args := range [][]string{{"init", "--quiet"}, {"add", "--all"}} {
		command := exec.Command("git", append([]string{"-C", root}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
}

func TestDirtyPackagesEmptyTasks(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), ".kb", "devkit")
	ws := makeWS("@kb/app")

	got, err := DirtyPackages(ws, nil, []string{}, cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("DirtyPackages with empty tasks = %v, want []", got)
	}
}
