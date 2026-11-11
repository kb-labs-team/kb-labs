package checks

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestTypeCheckProjectRuleRequiresPackageOwnedProject(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "sites", "web")
	pkgDir := filepath.Join(parent, "packages", "config")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(parent, "tsconfig.json"), []byte(`{"files":[]}`), 0o600); err != nil { t.Fatal(err) }

	cfg := &config.DevkitConfig{Tasks: map[string]config.TaskConfig{
		"type-check": {{Categories: []string{"site-pkg"}, Command: "tsc --noEmit -p tsconfig.json"}},
	}}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{{Name: "@kb-labs/web-config", Dir: pkgDir, Category: "site-pkg"}}}
	issues := (&typeCheckProjectRule{cfg: cfg}).CheckWorkspace(ws)
	if len(issues) != 1 || issues[0].Severity != SeverityError {
		t.Fatalf("issues = %#v, want one missing package-owned project error", issues)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "tsconfig.json"), []byte(`{"files":[]}`), 0o600); err != nil { t.Fatal(err) }
	if issues := (&typeCheckProjectRule{cfg: cfg}).CheckWorkspace(ws); len(issues) != 0 {
		t.Fatalf("issues with package-owned project = %#v, want none", issues)
	}
}

func TestWorkspaceTypeCheckTasksAreProjectScopedAndConfigPackagesHaveNoTask(t *testing.T) {
	cfg, err := config.LoadFile(filepath.Join("..", "..", "..", "..", "devkit.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if def := engine.ResolveTaskDef(cfg, "type-check", "site-pkg"); def == nil || def.Command != "tsc --noEmit -p tsconfig.json" {
		t.Fatalf("site-pkg type-check task = %#v, want explicit package project", def)
	}
	if def := engine.ResolveTaskDef(cfg, "type-check", "site-config"); def != nil {
		t.Fatalf("site-config unexpectedly receives type-check task: %#v", def)
	}
	if def := engine.ResolveTaskDef(cfg, "type-check", "ts-lib"); def == nil || def.Command != "tsc --noEmit -p tsconfig.json" {
		t.Fatalf("ts-lib type-check task = %#v, want explicit package project", def)
	}
}
