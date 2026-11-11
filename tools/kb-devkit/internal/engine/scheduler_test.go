package engine

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// writePkgJSON creates a minimal package.json in dir.
func writePkgJSON(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// case: S-179.19, S-179.37
func TestWorkspaceBuildGraphOrdersEveryDeclaredWorkspaceDependency(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate scheduler test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
	cfg, err := config.LoadFile(filepath.Join(root, "devkit.yaml"))
	if err != nil {
		t.Fatalf("load workspace devkit.yaml: %v", err)
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover workspace packages: %v", err)
	}
	pkgs, err := expandBuildDependencyClosure(ws.Packages, ws.Packages)
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := buildDAG(pkgs, []string{"build"}, cfg, ws)
	if err != nil {
		t.Fatalf("build workspace task DAG: %v", err)
	}
	if len(pkgs) != len(ws.Packages) {
		t.Fatalf("build dependency closure has %d packages; workspace has %d", len(pkgs), len(ws.Packages))
	}

	byName := make(map[string]workspace.Package, len(ws.Packages))
	for _, pkg := range ws.Packages {
		byName[pkg.Name] = pkg
		def := ResolvePackageTaskDef(ws, cfg, "build", pkg)
		if def == nil {
			if _, scheduled := nodes[nodeKey{pkg.Name, "build"}]; scheduled {
				t.Errorf("package %s has a build node without a matching task definition", pkg.Name)
			}
			continue
		}
		if _, scheduled := nodes[nodeKey{pkg.Name, "build"}]; !scheduled {
			t.Errorf("package %s has a build task definition but no build node", pkg.Name)
		}
	}

	for key, node := range nodes {
		if key.task != "build" {
			continue
		}
		def := ResolvePackageTaskDef(ws, cfg, "build", node.pkg)
		if def == nil || !containsTask(def.Deps, "^build") {
			continue
		}
		depNames, err := WorkspaceDeps(node.pkg.Dir, byName)
		if err != nil {
			t.Fatal(err)
		}
		for _, depName := range depNames {
			if depName == node.pkg.Name {
				continue
			}
			depKey := nodeKey{pkg: depName, task: "build"}
			if _, scheduled := nodes[depKey]; !scheduled {
				t.Errorf("%s build depends on %s, but the dependency has no build task node", key.pkg, depName)
				continue
			}
			found := false
			for _, actual := range node.deps {
				if actual.to == depKey {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s build node is missing declared workspace dependency %s", key.pkg, depName)
			}
		}
	}
}

func TestBuildPkgDepMapFiltersSelfReference(t *testing.T) {
	root := t.TempDir()

	devkitDir := filepath.Join(root, "devkit")
	writePkgJSON(t, devkitDir, `{
		"name": "@kb/devkit",
		"devDependencies": {"@kb/devkit": "workspace:*"}
	}`)

	pkgs := []workspace.Package{
		{Name: "@kb/devkit", Dir: devkitDir},
	}
	pkgByName := map[string]workspace.Package{
		"@kb/devkit": pkgs[0],
	}

	depMap, err := buildPkgDepMap(pkgs, pkgByName)
	if err != nil {
		t.Fatal(err)
	}

	if deps, ok := depMap["@kb/devkit"]; ok && len(deps) > 0 {
		t.Fatalf("self-reference not filtered: got deps %v for @kb/devkit", deps)
	}
}

func TestBuildPkgDepMapKeepsLegitDeps(t *testing.T) {
	root := t.TempDir()

	typesDir := filepath.Join(root, "types")
	writePkgJSON(t, typesDir, `{"name": "@kb/types"}`)

	appDir := filepath.Join(root, "app")
	writePkgJSON(t, appDir, `{
		"name": "@kb/app",
		"dependencies": {"@kb/types": "workspace:*"},
		"devDependencies": {"@kb/app": "workspace:*"}
	}`)

	pkgs := []workspace.Package{
		{Name: "@kb/types", Dir: typesDir},
		{Name: "@kb/app", Dir: appDir},
	}
	pkgByName := map[string]workspace.Package{
		"@kb/types": pkgs[0],
		"@kb/app":   pkgs[1],
	}

	depMap, err := buildPkgDepMap(pkgs, pkgByName)
	if err != nil {
		t.Fatal(err)
	}

	// @kb/app should depend on @kb/types but NOT on itself
	deps := depMap["@kb/app"]
	if len(deps) != 1 || deps[0].Name != "@kb/types" || deps[0].Kind != DependenciesKind {
		t.Fatalf("@kb/app deps = %v, want [@kb/types dependencies]", deps)
	}
}

func TestAffectedPackagesSelectsFullGraphForUnownedPaths(t *testing.T) {
	root := t.TempDir()
	writeRootWorkspace(t, root)
	core := newPkg(t, root, "packages/core", "@fixture/core", `{"name":"@fixture/core"}`)
	app := newPkg(t, root, "apps/app", "@fixture/app", `{"name":"@fixture/app","dependencies":{"@fixture/core":"workspace:*"}}`)
	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*", "apps/*"}, Preset: "node-lib"}}}},
		Tasks:     map[string]config.TaskConfig{"build": {{Command: "echo build"}}},
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}
	t.Run("mixed package and root configuration", func(t *testing.T) {
		selection, err := selectAffectedPackages(ws, []string{filepath.Join(core.Dir, "src", "index.ts"), filepath.Join(root, "tsconfig.base.json")}, cfg.Affected.FullInputs)
		if err != nil {
			t.Fatalf("AffectedPackages error: %v", err)
		}
		if len(selection.Packages) != len(ws.Packages) || selection.Reason != "full: unowned path tsconfig.base.json" {
			t.Fatalf("selection = (%v, %q), want full graph and root-path reason", packageNames(selection.Packages), selection.Reason)
		}
	})

	t.Run("root only", func(t *testing.T) {
		selection, err := selectAffectedPackages(ws, []string{filepath.Join(root, "pnpm-workspace.yaml")}, cfg.Affected.FullInputs)
		if err != nil {
			t.Fatalf("AffectedPackages error: %v", err)
		}
		if len(selection.Packages) != len(ws.Packages) || selection.Reason != "full: unowned path pnpm-workspace.yaml" {
			t.Fatalf("selection = (%v, %q), want full graph and root-path reason", packageNames(selection.Packages), selection.Reason)
		}
	})

	t.Run("package only", func(t *testing.T) {
		selection, err := selectAffectedPackages(ws, []string{filepath.Join(core.Dir, "src", "index.ts")}, cfg.Affected.FullInputs)
		if err != nil {
			t.Fatalf("AffectedPackages error: %v", err)
		}
		if len(selection.Packages) != 2 || selection.Reason != "" {
			t.Fatalf("selection = (%v, %q), want changed package and dependent without full-selection reason", packageNames(selection.Packages), selection.Reason)
		}
	})
	t.Run("configured shared package input", func(t *testing.T) {
		sharedInput := "packages/core/shared-catalog.json"
		selection, err := selectAffectedPackages(ws, []string{filepath.Join(root, filepath.FromSlash(sharedInput))}, []string{sharedInput})
		if err != nil {
			t.Fatalf("AffectedPackages error: %v", err)
		}
		if len(selection.Packages) != len(ws.Packages) || selection.Reason != "full: configured shared input "+sharedInput {
			t.Fatalf("selection = (%v, %q), want full graph and configured-input reason", packageNames(selection.Packages), selection.Reason)
		}
	})
	t.Run("workspace policy files select the full graph", func(t *testing.T) {
		for _, relative := range []string{"pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", "devkit.yaml", "tsconfig.base.json", "scripts/ci/remote-verify.mjs"} {
			t.Run(relative, func(t *testing.T) {
				selection, err := selectAffectedPackages(ws, []string{filepath.Join(root, filepath.FromSlash(relative))}, cfg.Affected.FullInputs)
				if err != nil {
					t.Fatalf("AffectedPackages error: %v", err)
				}
				if len(selection.Packages) != len(ws.Packages) || selection.Reason != "full: unowned path "+relative {
					t.Fatalf("selection = (%v, %q), want full graph for %s", packageNames(selection.Packages), selection.Reason, relative)
				}
			})
		}
	})
	_ = app
}

func TestAffectedPackagesFromFilesUsesWorkspaceOwnership(t *testing.T) {
	root := t.TempDir()
	writeRootWorkspace(t, root)
	core := newPkg(t, root, "packages/core", "@fixture/core", `{"name":"@fixture/core"}`)
	app := newPkg(t, root, "apps/app", "@fixture/app", `{"name":"@fixture/app","dependencies":{"@fixture/core":"workspace:*"}}`)
	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*", "apps/*"}, Preset: "node-lib"}}}},
		Tasks:     map[string]config.TaskConfig{"build": {{Command: "echo build"}}},
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatal(err)
	}
	selection, err := AffectedPackagesFromFiles(ws, []string{"packages/core/src/index.ts"}, cfg.Affected.FullInputs)
	if err != nil {
		t.Fatal(err)
	}
	if len(selection.Packages) != 2 || selection.Reason != "" {
		t.Fatalf("selection = (%v, %q), want core and dependent app", packageNames(selection.Packages), selection.Reason)
	}
	if _, err := AffectedPackagesFromFiles(ws, []string{""}, cfg.Affected.FullInputs); err == nil {
		t.Fatal("empty changed-file path was accepted")
	}
	_ = core
	_ = app
}

// case: S-179.37
func TestBuildDAGRejectsWorkspaceBuildDependencyWithoutTaskNode(t *testing.T) {
	root := t.TempDir()
	coreDir := filepath.Join(root, "core")
	writePkgJSON(t, coreDir, `{"name":"@fixture/core"}`)
	runtimeDir := filepath.Join(root, "runtime")
	writePkgJSON(t, runtimeDir, `{"name":"@fixture/runtime","scripts":{"build":"tsup"},"dependencies":{"@fixture/core":"workspace:*"}}`)
	appDir := filepath.Join(root, "app")
	writePkgJSON(t, appDir, `{"name":"@fixture/app","dependencies":{"@fixture/runtime":"workspace:*"}}`)

	pkgs := []workspace.Package{
		{Name: "@fixture/core", Dir: coreDir, Category: "libraries"},
		{Name: "@fixture/runtime", Dir: runtimeDir, Category: "runtime"},
		{Name: "@fixture/app", Dir: appDir, Category: "applications"},
	}
	cfg := &config.DevkitConfig{
		Tasks: map[string]config.TaskConfig{
			"build": {
				{Categories: []string{"libraries", "applications"}, Command: "true", Deps: []string{"^build"}},
			},
		},
	}

	_, err := buildDAG(pkgs, []string{"build"}, cfg, &workspace.Workspace{Root: root, Packages: pkgs})
	var graphErr *TaskGraphError
	if !errors.As(err, &graphErr) {
		t.Fatal("build DAG accepted @fixture/app -> @fixture/runtime -> @fixture/core without a runtime build task")
	}
	if graphErr.Package != "@fixture/app" || graphErr.Dependency != "@fixture/runtime" ||
		graphErr.Task != "build" || graphErr.DependencyTask != "build" {
		t.Fatalf("task graph error = %+v, want the omitted runtime build node", graphErr)
	}
}

// case: S-179.49
// A source-only workspace dependency (no DevKit variant, no package script for
// the task) has nothing to run, so ^task is satisfied without a node.
func TestBuildDAGSatisfiesWorkspaceDependencyWithNothingToRun(t *testing.T) {
	root := t.TempDir()
	sharedDir := filepath.Join(root, "shared")
	writePkgJSON(t, sharedDir, `{"name":"@fixture/shared","scripts":{"test":"node --test"}}`)
	suiteDir := filepath.Join(root, "suite")
	writePkgJSON(t, suiteDir, `{"name":"@fixture/suite","scripts":{"e2e":"playwright test"},"devDependencies":{"@fixture/shared":"workspace:*"}}`)

	pkgs := []workspace.Package{
		{Name: "@fixture/shared", Dir: sharedDir, Category: "node-tests"},
		{Name: "@fixture/suite", Dir: suiteDir, Category: "suites"},
	}
	cfg := &config.DevkitConfig{
		Tasks: map[string]config.TaskConfig{
			"e2e": {
				{Categories: []string{"suites"}, Command: "pnpm run e2e", Deps: []string{"^build"}},
			},
		},
	}

	nodes, err := buildDAG(pkgs, []string{"e2e"}, cfg, &workspace.Workspace{Root: root, Packages: pkgs})
	if err != nil {
		t.Fatalf("buildDAG refused a source-only dependency: %v", err)
	}
	if _, planned := nodes[nodeKey{"@fixture/shared", "build"}]; planned {
		t.Fatal("buildDAG planned a build for a package that declares nothing to build")
	}
	if _, planned := nodes[nodeKey{"@fixture/suite", "e2e"}]; !planned {
		t.Fatal("buildDAG dropped the requested e2e task")
	}
}

func TestExpandBuildDependencyClosureAddsUpstreamPackages(t *testing.T) {
	root := t.TempDir()

	coreDir := filepath.Join(root, "core")
	writePkgJSON(t, coreDir, `{"name":"@kb/core"}`)
	appDir := filepath.Join(root, "app")
	writePkgJSON(t, appDir, `{"name":"@kb/app","dependencies":{"@kb/core":"workspace:*"}}`)

	all := []workspace.Package{
		{Name: "@kb/core", Dir: coreDir},
		{Name: "@kb/app", Dir: appDir},
	}
	closure, err := expandBuildDependencyClosure(all[1:], all)
	if err != nil {
		t.Fatal(err)
	}

	if len(closure) != 2 || closure[0].Name != "@kb/core" || closure[1].Name != "@kb/app" {
		t.Fatalf("closure = %v, want [@kb/core @kb/app]", closure)
	}
}

func TestBuildDAGSelfDepDoesNotCreateCycle(t *testing.T) {
	root := t.TempDir()

	// Simulate @kb-labs/devkit depending on itself — the exact real-world bug.
	devkitDir := filepath.Join(root, "devkit")
	writePkgJSON(t, devkitDir, `{
		"name": "@kb/devkit",
		"devDependencies": {"@kb/devkit": "workspace:*"}
	}`)

	coreDir := filepath.Join(root, "core")
	writePkgJSON(t, coreDir, `{
		"name": "@kb/core",
		"devDependencies": {"@kb/devkit": "workspace:*"}
	}`)

	pkgs := []workspace.Package{
		{Name: "@kb/devkit", Dir: devkitDir, Category: "ts-lib"},
		{Name: "@kb/core", Dir: coreDir, Category: "ts-lib"},
	}

	cfg := &config.DevkitConfig{
		Tasks: map[string]config.TaskConfig{
			"build": {
				{Categories: []string{"ts-lib"}, Command: "tsup", Deps: []string{"^build"}},
			},
		},
	}
	ws := &workspace.Workspace{Root: root, Packages: pkgs}

	nodes, err := buildDAG(pkgs, []string{"build"}, cfg, ws)
	if err != nil {
		t.Fatal(err)
	}

	// Both packages must be in the DAG
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}

	// @kb/devkit must have zero deps (self-ref filtered)
	devkitNode := nodes[nodeKey{"@kb/devkit", "build"}]
	if len(devkitNode.deps) != 0 {
		t.Fatalf("@kb/devkit should have 0 deps, got %v", devkitNode.deps)
	}

	// @kb/core depends on @kb/devkit only
	coreNode := nodes[nodeKey{"@kb/core", "build"}]
	if len(coreNode.deps) != 1 || coreNode.deps[0].to.pkg != "@kb/devkit" {
		t.Fatalf("@kb/core deps = %v, want [{@kb/devkit build}]", coreNode.deps)
	}

	// Verify no cycles: compute in-degrees, confirm both packages become runnable
	inDegree := map[nodeKey]int{}
	for k := range nodes {
		inDegree[k] = 0
	}
	for k, n := range nodes {
		_ = k
		for _, dep := range n.deps {
			inDegree[dep.to]++
		}
	}

	// At least one node must have in-degree 0 (DAG root)
	hasRoot := false
	for _, deg := range inDegree {
		if deg == 0 {
			hasRoot = true
			break
		}
	}
	if !hasRoot {
		t.Fatal("no DAG root found — cycle detected (in-degree > 0 for all nodes)")
	}
}
