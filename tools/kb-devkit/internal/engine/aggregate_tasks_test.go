package engine

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// case: S-179.40
func TestBuildDAGSkipsAggregatePackagesAndSchedulesChildren(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "pnpm-workspace.yaml"), []byte("packages:\n  - 'packages/**'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writePackage := func(rel, name string) {
		dir := filepath.Join(root, rel)
		writePkgJSON(t, dir, `{"name":"`+name+`","version":"1.0.0","scripts":{"build":"next build"}}`)
	}
	writePackage("packages/aggregate", "@acme/aggregate")
	writePackage("packages/aggregate/apps/docs", "@acme/docs")
	cfg := &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{
			{Name: "aggregate", Category: config.CategoryConfig{Match: []string{"packages/aggregate"}}},
			{Name: "site-app", Category: config.CategoryConfig{Match: []string{"packages/aggregate/apps/docs"}}},
		}},
		Tasks: map[string]config.TaskConfig{"build": {
			{Categories: []string{"aggregate", "site-app"}, Command: "pnpm run build"},
		}},
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover fixture workspace: %v", err)
	}
	nodes, err := buildDAG(ws.Packages, []string{"build"}, cfg, ws)
	if err != nil {
		t.Fatalf("build fixture task DAG: %v", err)
	}
	if _, exists := nodes[nodeKey{pkg: "@acme/aggregate", task: "build"}]; exists {
		t.Fatal("aggregate package has a scheduled build task")
	}
	if _, exists := nodes[nodeKey{pkg: "@acme/docs", task: "build"}]; !exists {
		t.Fatal("child package has no scheduled build task")
	}
}
