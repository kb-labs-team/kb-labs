package checks

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// case: S-179.27
func TestRunAllReportsPerCheckProgress(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "packages", "demo")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writePackageJSON(t, pkgDir, `{"name":"@acme/demo"}`)
	cfg := &config.DevkitConfig{Presets: map[string]config.Preset{"demo": {Language: "typescript"}}}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{{Name: "@acme/demo", Dir: pkgDir, RelPath: "packages/demo", Category: "demo", Preset: "demo", Language: "typescript"}}}
	var mu sync.Mutex
	var events []ProgressEvent
	RunAll(ws, cfg, Default(), nil, func(event ProgressEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	})
	mu.Lock()
	defer mu.Unlock()
	if len(events) == 0 {
		t.Fatal("progress events = none, want each executed rule to report start and completion")
	}
	started, completed := false, false
	for _, event := range events {
		if event.Package != "@acme/demo" && event.Package != "workspace" || event.Check == "" {
			t.Fatalf("progress event = %#v, want package and check identity", event)
		}
		started = started || event.Running
		completed = completed || !event.Running
	}
	if !started || !completed {
		t.Fatalf("progress events = %#v, want running and completed states", events)
	}
}

type workspaceCountRule struct{ packageCount int }

func (r *workspaceCountRule) Name() string                                   { return "workspace-count" }
func (r *workspaceCountRule) Scope() string                                  { return "workspace" }
func (r *workspaceCountRule) Check(workspace.Package, config.Preset) []Issue { return nil }
func (r *workspaceCountRule) CheckWorkspace(ws *workspace.Workspace) []Issue {
	r.packageCount = len(ws.Packages)
	return nil
}

func TestRunAllForPackagesKeepsWorkspaceRulesFullAndScopesPackageRules(t *testing.T) {
	root := t.TempDir()
	gate := workspace.Package{Name: "@acme/host", Preset: "node-lib", Dir: filepath.Join(root, "host")}
	internal := workspace.Package{Name: "@acme/runner", Preset: "node-lib", Dir: filepath.Join(root, "runner"), ReleaseLane: "internal-tool"}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{gate, internal}}
	cfg := &config.DevkitConfig{Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}}}
	registry := &Registry{}
	registry.Register(fakeRule{name: "package-rule"})
	workspaceRule := &workspaceCountRule{}
	registry.Register(workspaceRule)
	results := RunAllForPackages(ws, []workspace.Package{gate}, cfg, registry, nil, nil)
	if workspaceRule.packageCount != 2 {
		t.Fatalf("workspace rule saw %d packages, want full workspace of 2", workspaceRule.packageCount)
	}
	if results[gate.Name].ChecksRun != 1 {
		t.Fatalf("gating package checks = %#v, want one package check", results[gate.Name])
	}
	if _, exists := results[internal.Name]; exists {
		t.Fatalf("candidate package checks included internal tool: %#v", results[internal.Name])
	}
}

type workspaceFailureRule struct{}

func (workspaceFailureRule) Name() string                                   { return "workspace-failure" }
func (workspaceFailureRule) Scope() string                                  { return "workspace" }
func (workspaceFailureRule) Check(workspace.Package, config.Preset) []Issue { return nil }
func (workspaceFailureRule) CheckWorkspace(*workspace.Workspace) []Issue {
	return []Issue{{Check: "workspace-failure", Severity: SeverityError, Message: "workspace failure"}}
}

func TestRunPackageRulesForInternalToolIgnoresWorkspaceFailureAndKeepsPackageFailure(t *testing.T) {
	root := t.TempDir()
	internal := workspace.Package{Name: "github.com/kb-labs/kb-runner", Preset: "node-lib", Language: "typescript", Dir: filepath.Join(root, "tools/kb-runner"), ReleaseLane: "internal-tool"}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{internal}}
	cfg := &config.DevkitConfig{Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}}}
	registry := &Registry{}
	registry.Register(workspaceFailureRule{})
	registry.Register(fakeRule{name: "package-rule"})

	passed := RunPackageRulesForPackages(ws, []workspace.Package{internal}, cfg, registry, nil, nil)
	if _, exists := passed["workspace"]; exists {
		t.Fatalf("package-only checks returned workspace result %#v", passed["workspace"])
	}
	if got := passed[internal.Name]; got.ChecksRun != 1 || len(got.Issues) != 0 {
		t.Fatalf("package-only result = %#v, want one passing package check", got)
	}

	registry.Register(fakeRule{name: "failing-package-rule", issues: []Issue{{Check: "failing-package-rule", Severity: SeverityError, Message: "internal package failure"}}})
	failed := RunPackageRulesForPackages(ws, []workspace.Package{internal}, cfg, registry, nil, nil)
	if got := failed[internal.Name]; len(got.Issues) != 1 || got.Issues[0].Message != "internal package failure" {
		t.Fatalf("package failure evidence = %#v, want the internal package finding", got.Issues)
	}
}

type fakeRule struct {
	name   string
	issues []Issue
}

func (r fakeRule) Name() string { return r.name }

func (r fakeRule) Check(pkg workspace.Package, preset config.Preset) []Issue {
	out := make([]Issue, len(r.issues))
	copy(out, r.issues)
	for i := range out {
		if out[i].Message == "" {
			out[i].Message = pkg.Name
		}
	}
	return out
}

func TestRunAllAppliesOnlyFilterAndMergesCircularResults(t *testing.T) {
	root := t.TempDir()
	pkgA := workspace.Package{
		Name:     "@kb/a",
		Dir:      filepath.Join(root, "packages", "a"),
		Preset:   "node-lib",
		Language: "typescript",
	}
	pkgB := workspace.Package{
		Name:     "@kb/b",
		Dir:      filepath.Join(root, "packages", "b"),
		Preset:   "node-lib",
		Language: "typescript",
	}

	writePackageJSON(t, pkgA.Dir, `{"name":"@kb/a","dependencies":{"@kb/b":"workspace:*"}}`)
	writePackageJSON(t, pkgB.Dir, `{"name":"@kb/b","dependencies":{"@kb/a":"workspace:*"}}`)

	ws := &workspace.Workspace{Packages: []workspace.Package{pkgA, pkgB}}
	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Preset: "node-lib"}},
			},
		},
	}
	registry := &Registry{
		rules: []Rule{
			fakeRule{name: "selected", issues: []Issue{{Check: "selected", Severity: SeverityInfo}}},
			fakeRule{name: "ignored", issues: []Issue{{Check: "ignored", Severity: SeverityWarning}}},
		},
	}

	results := RunAll(ws, cfg, registry, []string{"selected", "circular"}, nil)

	for _, pkg := range []workspace.Package{pkgA, pkgB} {
		result, ok := results[pkg.Name]
		if !ok {
			t.Fatalf("missing result for %s", pkg.Name)
		}
		if result.Skipped {
			t.Fatalf("package %s unexpectedly skipped", pkg.Name)
		}
		if len(result.Issues) != 2 {
			t.Fatalf("issues for %s = %#v, want selected + circular", pkg.Name, result.Issues)
		}
		if result.Issues[0].Check != "selected" || result.Issues[1].Check != "circular" {
			t.Fatalf("unexpected issues for %s: %#v", pkg.Name, result.Issues)
		}
	}
}

func TestRunAllRunsCircularCheckByItself(t *testing.T) {
	root := t.TempDir()
	pkgA := workspace.Package{Name: "@kb/a", Dir: filepath.Join(root, "a"), Preset: "node-lib"}
	pkgB := workspace.Package{Name: "@kb/b", Dir: filepath.Join(root, "b"), Preset: "node-lib"}
	writePackageJSON(t, pkgA.Dir, `{"name":"@kb/a","dependencies":{"@kb/b":"workspace:*"}}`)
	writePackageJSON(t, pkgB.Dir, `{"name":"@kb/b","devDependencies":{"@kb/a":"workspace:*"}}`)
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"node-lib": {Deps: config.DepsRules{CheckCircular: true}}},
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{
			Name: "libs", Category: config.CategoryConfig{Preset: "node-lib"},
		}}},
	}
	results := RunAll(&workspace.Workspace{Packages: []workspace.Package{pkgA, pkgB}}, cfg, &Registry{}, []string{"circular"}, nil)
	for _, pkg := range []workspace.Package{pkgA, pkgB} {
		result, ok := results[pkg.Name]
		if !ok {
			t.Fatalf("missing circular result for %s", pkg.Name)
		}
		if result.ChecksRun != 1 || len(result.Issues) != 1 || result.Issues[0].Check != "circular" {
			t.Fatalf("result for %s = %#v, want one circular finding", pkg.Name, result)
		}
	}
}

func TestRunAllSkipsPackageWhenPresetResolutionFails(t *testing.T) {
	ws := &workspace.Workspace{
		Packages: []workspace.Package{
			{Name: "@kb/missing", Dir: t.TempDir(), Preset: "does-not-exist"},
		},
	}
	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Preset: "node-lib"}},
			},
		},
	}

	results := RunAll(ws, cfg, &Registry{}, nil, nil)
	result := results["@kb/missing"]
	if !result.Skipped {
		t.Fatalf("Skipped = false, want true: %#v", result)
	}
}

func writePackageJSON(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
}
