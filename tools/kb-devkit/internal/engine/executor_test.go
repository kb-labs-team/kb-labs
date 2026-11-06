package engine

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestExpandOutputFilesAndSplitCommand(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "dist", "a.js"), "a")
	writeFile(t, filepath.Join(root, "dist", "nested", "b.js"), "b")

	files, err := expandOutputFiles(root, []string{"dist/**/*.js", "dist/*.js"})
	if err != nil {
		t.Fatalf("expandOutputFiles error: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("files = %#v, want 2", files)
	}

	parts := splitCommand(`node -e "console.log('hi there')"`)
	if len(parts) != 3 || parts[2] != "console.log('hi there')" {
		t.Fatalf("splitCommand = %#v", parts)
	}

	if !matchGlobSimple("dist/**/*.js", "dist/nested/b.js") {
		t.Fatal("matchGlobSimple recursive match = false, want true")
	}
}

func TestExecutorStoresAndRestoresOutputsThroughCache(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}
	manifests := cache.NewManifestStore(cacheRoot)
	states := cache.NewStateStore(cacheRoot)
	exec := NewExecutor(store, manifests, states, root, cacheRoot, false)

	pkgDir := filepath.Join(root, "pkg")
	writeFile(t, filepath.Join(pkgDir, "input.txt"), "hello")
	writeFile(t, filepath.Join(pkgDir, "out.txt"), "artifact")

	refs, err := exec.storeOutputs(pkgDir, []string{"out.txt"})
	if err != nil {
		t.Fatalf("storeOutputs error: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs = %#v, want 1", refs)
	}

	if err := os.Remove(filepath.Join(pkgDir, "out.txt")); err != nil {
		t.Fatalf("remove out.txt: %v", err)
	}
	m := &cache.Manifest{Outputs: refs}
	if err := exec.restoreOutputs(m, pkgDir); err != nil {
		t.Fatalf("restoreOutputs error: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(pkgDir, "out.txt"))
	if err != nil {
		t.Fatalf("read restored output: %v", err)
	}
	if string(data) != "artifact" {
		t.Fatalf("restored output = %q, want artifact", data)
	}
}

func TestConsumerBuildIsNotCachedAfterInheritedTsConfigChanges(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	appDir := filepath.Join(root, "services", "gateway", "app")
	gatewayDir := filepath.Join(root, "services", "gateway")
	writeFile(t, filepath.Join(appDir, "package.json"), `{"name":"@fixture/gateway-app"}`)
	writeFile(t, filepath.Join(appDir, "src", "index.ts"), "export const value = true\n")
	writeFile(t, filepath.Join(appDir, "tsconfig.build.json"), `{"extends":"../tsconfig.base.json","include":["src"]}`)
	writeFile(t, filepath.Join(gatewayDir, "tsconfig.base.json"), `{"compilerOptions":{"strict":true}}`)
	initTrackedFixture(t, root)
	globalDigest, ownedInputDigests, dependencyDigests, err := workspaceInputDigests(&workspace.Workspace{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	workspaceRoot := findWorkspaceRoot(t)
	exec := &Executor{
		objects: store, manifests: cache.NewManifestStore(cacheRoot), states: cache.NewStateStore(cacheRoot),
		wsRoot: workspaceRoot, logRoot: filepath.Join(cacheRoot, "logs"), runtimeFingerprint: "fixture-toolchain",
		ownedInputDigests: ownedInputDigests, dependencyDigests: dependencyDigests, globalInputDigest: globalDigest,
	}
	pkg := workspace.Package{Name: "@fixture/gateway-app", Dir: appDir, Language: "typescript"}
	def := TaskDef{Name: "build", Command: "true", Inputs: []string{"src/**", "tsconfig*.json"}, Cache: true}

	first := exec.Run(pkg, def, false, nil)
	if !first.OK || first.Cached {
		t.Fatalf("first gateway app build = %+v, want successful execution", first)
	}
	second := exec.Run(pkg, def, false, nil)
	if !second.OK || !second.Cached {
		t.Fatalf("second gateway app build = %+v, want cache hit", second)
	}
	writeFile(t, filepath.Join(gatewayDir, "tsconfig.base.json"), `{"compilerOptions":{"strict":false}}`)
	tsconfigBase := filepath.Join(gatewayDir, "tsconfig.base.json")
	exec.globalInputDigest, err = cache.ContentDigest(root, []string{tsconfigBase}, map[string]cache.TrackedFile{filepath.Clean(tsconfigBase): {Mode: 0100644}})
	if err != nil {
		t.Fatal(err)
	}
	third := exec.Run(pkg, def, false, nil)
	if !third.OK || third.Cached {
		t.Fatalf("gateway app build after only its inherited tsconfig changed = %+v, want a fresh execution", third)
	}
}

func TestConsumerTestIsNotCachedAfterImportedVitestConfigChanges(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	appDir := filepath.Join(root, "services", "gateway", "app")
	servicesDir := filepath.Join(root, "services")
	writeFile(t, filepath.Join(appDir, "package.json"), `{"name":"@fixture/gateway-app","type":"module"}`)
	writeFile(t, filepath.Join(appDir, "src", "test.ts"), "export const value = true\n")
	writeFile(t, filepath.Join(appDir, "vitest.config.ts"), "import base from '../../vitest.config.mjs'; export default base\n")
	writeFile(t, filepath.Join(servicesDir, "vitest.config.mjs"), "export default { test: { testTimeout: 1000 } }\n")
	initTrackedFixture(t, root)
	globalDigest, ownedInputDigests, dependencyDigests, err := workspaceInputDigests(&workspace.Workspace{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	workspaceRoot := findWorkspaceRoot(t)
	vitestLink := filepath.Join(appDir, "node_modules", "vitest")
	if err := os.MkdirAll(filepath.Dir(vitestLink), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(workspaceRoot, "node_modules", "vitest"), vitestLink); err != nil {
		t.Fatal(err)
	}

	exec := &Executor{
		objects: store, manifests: cache.NewManifestStore(cacheRoot), states: cache.NewStateStore(cacheRoot),
		wsRoot: workspaceRoot, logRoot: filepath.Join(cacheRoot, "logs"), runtimeFingerprint: "fixture-toolchain",
		ownedInputDigests: ownedInputDigests, dependencyDigests: dependencyDigests, globalInputDigest: globalDigest,
	}
	pkg := workspace.Package{Name: "@fixture/gateway-app", Dir: appDir, Language: "typescript"}
	def := TaskDef{Name: "test", Command: "true", Inputs: []string{"src/**", "vitest.config.*"}, Cache: true}

	first := exec.Run(pkg, def, false, nil)
	if !first.OK || first.Cached {
		t.Fatalf("first gateway app test = %+v, want successful execution", first)
	}
	second := exec.Run(pkg, def, false, nil)
	if !second.OK || !second.Cached {
		t.Fatalf("second gateway app test = %+v, want cache hit", second)
	}
	writeFile(t, filepath.Join(servicesDir, "vitest.config.mjs"), "export default { test: { testTimeout: 2000 } }\n")
	vitestConfig := filepath.Join(servicesDir, "vitest.config.mjs")
	exec.globalInputDigest, err = cache.ContentDigest(root, []string{vitestConfig}, map[string]cache.TrackedFile{filepath.Clean(vitestConfig): {Mode: 0100644}})
	if err != nil {
		t.Fatal(err)
	}
	third := exec.Run(pkg, def, false, nil)
	if !third.OK || third.Cached {
		t.Fatalf("gateway app test after only its imported Vitest config changed = %+v, want fresh execution", third)
	}
}

func findWorkspaceRoot(t *testing.T) string {
	t.Helper()
	current, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(current, "pnpm-workspace.yaml")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			t.Fatal("workspace root not found from test process directory")
		}
		current = parent
	}
}

func TestTaskFingerprintChangesWhenTaskDefinitionChanges(t *testing.T) {
	exec := &Executor{runtimeFingerprint: "toolchain"}
	base := TaskDef{Name: "build", Command: "tsup", Inputs: []string{"src/**"}, Outputs: []string{"dist/**"}, Deps: []string{"^build"}, Cache: true}
	changedCommand := base
	changedCommand.Command = "pnpm build"
	changedDeps := base
	changedDeps.Deps = nil

	if exec.taskFingerprint(base) == exec.taskFingerprint(changedCommand) {
		t.Fatal("command must be part of the task fingerprint")
	}
	if exec.taskFingerprint(base) == exec.taskFingerprint(changedDeps) {
		t.Fatal("dependency graph must be part of the task fingerprint")
	}
}

func TestResolveBinPrefersWorkspaceNodeModulesBin(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "node_modules", ".bin", "eslint"), "#!/bin/sh\n")
	got := resolveBin("eslint", root, t.TempDir())
	if got != filepath.Join(root, "node_modules", ".bin", "eslint") {
		t.Fatalf("resolveBin = %q", got)
	}
}

func TestResolveBinPrefersPackageNodeModulesBin(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "packages", "ui-kit")
	writeFile(t, filepath.Join(root, "node_modules", ".bin", "tsx"), "#!/bin/sh\n")
	writeFile(t, filepath.Join(pkgDir, "node_modules", ".bin", "tsx"), "#!/bin/sh\n")
	got := resolveBin("tsx", root, pkgDir)
	if got != filepath.Join(pkgDir, "node_modules", ".bin", "tsx") {
		t.Fatalf("resolveBin = %q; want package-local executable", got)
	}
}

func TestExecutorWritesCleanStateOnSuccess(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}
	states := cache.NewStateStore(cacheRoot)
	exec := NewExecutor(store, cache.NewManifestStore(cacheRoot), states, root, cacheRoot, false)

	pkgDir := filepath.Join(root, "pkg")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pkg := workspace.Package{Name: "@kb/app", Dir: pkgDir}
	def := TaskDef{Name: "build", Command: `sh -c "exit 0"`, Cache: true}

	r := exec.Run(pkg, def, false, nil)
	if !r.OK {
		t.Fatalf("expected OK, stderr: %s", r.Stderr)
	}
	if states.IsDirty(pkg.Name, def.Name) {
		t.Fatal("IsDirty = true after success, want false (CLEAN)")
	}
}

func TestExecutorWritesDirtyStateOnFailure(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}
	states := cache.NewStateStore(cacheRoot)
	exec := NewExecutor(store, cache.NewManifestStore(cacheRoot), states, root, cacheRoot, false)

	pkgDir := filepath.Join(root, "pkg")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pkg := workspace.Package{Name: "@kb/app", Dir: pkgDir}
	def := TaskDef{Name: "build", Command: `sh -c "exit 1"`, Cache: true}

	r := exec.Run(pkg, def, false, nil)
	if r.OK {
		t.Fatal("expected failure")
	}
	if !states.IsDirty(pkg.Name, def.Name) {
		t.Fatal("IsDirty = false after failure, want true (DIRTY)")
	}
}

func TestExecutorWritesStateForNoCacheTasks(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}
	states := cache.NewStateStore(cacheRoot)
	exec := NewExecutor(store, cache.NewManifestStore(cacheRoot), states, root, cacheRoot, false)

	pkgDir := filepath.Join(root, "pkg")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pkg := workspace.Package{Name: "@kb/deploy", Dir: pkgDir}
	// cache:false simulates deploy-like tasks — state must still be written
	def := TaskDef{Name: "deploy", Command: `sh -c "exit 0"`, Cache: false}

	r := exec.Run(pkg, def, false, nil)
	if !r.OK {
		t.Fatalf("expected OK, stderr: %s", r.Stderr)
	}
	if states.IsDirty(pkg.Name, def.Name) {
		t.Fatal("IsDirty = true after cache:false success, want false (CLEAN)")
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestExecutorDoesNotReplayCachedFailure(t *testing.T) {
	root := t.TempDir()
	cacheRoot := filepath.Join(root, ".kb", "devkit")
	store, err := cache.NewLocalStore(cacheRoot)
	if err != nil {
		t.Fatalf("NewLocalStore error: %v", err)
	}
	exec := NewExecutor(store, cache.NewManifestStore(cacheRoot), cache.NewStateStore(cacheRoot), root, cacheRoot, false)

	pkgDir := filepath.Join(root, "pkg")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pkg := workspace.Package{Name: "@kb/app", Dir: pkgDir}
	// The marker sits outside the hashed inputs, like a dependency that is
	// rebuilt after a failed run: the input hash stays the same.
	def := TaskDef{Name: "test", Command: `sh -c "test -f ../marker"`, Cache: true}

	if r := exec.Run(pkg, def, false, nil); r.OK {
		t.Fatal("first run: expected failure")
	}
	inputHash, err := cache.HashInputsWithFingerprint(pkgDir, nil, []string{"package.json"}, exec.taskFingerprint(def))
	if err != nil {
		t.Fatalf("hash failed task inputs: %v", err)
	}
	if _, ok := exec.manifests.Get(pkg.Name, def.Name, inputHash); ok {
		t.Fatal("failed task result was written to the cache")
	}
	if err := os.WriteFile(filepath.Join(root, "marker"), nil, 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	r := exec.Run(pkg, def, false, nil)
	if !r.OK || r.Cached {
		t.Fatalf("second run: OK=%v Cached=%v, want a fresh successful run", r.OK, r.Cached)
	}
	if r := exec.Run(pkg, def, false, nil); !r.OK || !r.Cached {
		t.Fatalf("third run: OK=%v Cached=%v, want a cached success", r.OK, r.Cached)
	}
}
