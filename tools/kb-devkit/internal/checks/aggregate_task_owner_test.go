package checks

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// case: S-179.40
func TestAggregateTaskOwnerRejectsParentWithTaskVariants(t *testing.T) {
	cfg, ws := aggregateFixture(t, "aggregate")
	issues := runAggregateTaskOwner(t, cfg, ws)
	if len(issues) != 1 {
		t.Fatalf("issues = %#v, want one aggregate task ownership finding", issues)
	}
	issue := issues[0]
	if issue.Check != "aggregate-task-owner" || issue.Severity != SeverityError {
		t.Errorf("finding identity = (%q, %q), want (%q, error)", issue.Check, issue.Severity, "aggregate-task-owner")
	}
	for _, expected := range []string{"@acme/aggregate", "@acme/docs", "child packages own the tasks"} {
		if !strings.Contains(issue.Message+issue.Fix, expected) {
			t.Errorf("finding %#v does not include %q", issue, expected)
		}
	}
}

// case: S-179.40
func TestAggregateTaskOwnerAllowsParentWithoutTaskVariants(t *testing.T) {
	cfg, ws := aggregateFixture(t, "container")
	issues := runAggregateTaskOwner(t, cfg, ws)
	if len(issues) != 0 {
		t.Fatalf("issues = %#v, want no findings for a no-task category", issues)
	}
}

// case: S-179.40
func TestAggregateTaskOwnerAcceptsRealWorkspace(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate test source")
	}
	moduleDir := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	root := filepath.Clean(filepath.Join(moduleDir, "../.."))
	cfg, err := config.LoadFile(filepath.Join(root, "devkit.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatal(err)
	}
	issues := runAggregateTaskOwner(t, cfg, ws)
	if len(issues) != 0 {
		t.Fatalf("real workspace findings = %#v, want none", issues)
	}
}

func aggregateFixture(t *testing.T, parentCategory string) (*config.DevkitConfig, *workspace.Workspace) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "pnpm-workspace.yaml"), []byte("packages:\n  - 'packages/**'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writePackage := func(rel, name string) {
		dir := filepath.Join(root, rel)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		manifest := `{"name":"` + name + `","version":"1.0.0"}`
		if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writePackage("packages/aggregate", "@acme/aggregate")
	writePackage("packages/aggregate/apps/docs", "@acme/docs")
	writePackage("packages/plain", "@acme/plain")

	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{
			{Name: parentCategory, Category: config.CategoryConfig{Match: []string{"packages/aggregate"}}},
			{Name: "site-app", Category: config.CategoryConfig{Match: []string{"packages/aggregate/apps/docs"}}},
			{Name: "plain", Category: config.CategoryConfig{Match: []string{"packages/plain"}}},
		}},
		Tasks: map[string]config.TaskConfig{
			"build": {
				{Categories: []string{"aggregate", "site-app"}, Command: "pnpm run build"},
			},
			"lint": {
				{Categories: []string{"aggregate"}, Command: "pnpm run lint"},
			},
		},
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover fixture workspace: %v", err)
	}
	return cfg, ws
}

func runAggregateTaskOwner(t *testing.T, cfg *config.DevkitConfig, ws *workspace.Workspace) []Issue {
	t.Helper()
	results := RunAll(ws, cfg, Build(cfg, ws.Root, "check"), []string{"aggregate-task-owner"}, nil)
	result, ok := results["workspace"]
	if !ok {
		t.Fatal("aggregate-task-owner did not run as a workspace check")
	}
	if result.ChecksRun != 1 {
		t.Fatalf("workspace checks run = %d, want exactly one selected check", result.ChecksRun)
	}
	return result.Issues
}
