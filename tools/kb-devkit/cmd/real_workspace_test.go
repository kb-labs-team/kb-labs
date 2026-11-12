package cmd

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// realWorkspace loads this repository's own devkit.yaml and workspace: the
// producer side of every seam below is the real file, not a fixture.
func realWorkspace(t *testing.T) (*workspace.Workspace, *config.DevkitConfig) {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFile(filepath.Join(root, "devkit.yaml"))
	if err != nil {
		t.Fatalf("load devkit.yaml: %v", err)
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	return ws, cfg
}

// Seam: devkit.yaml categories -> discovery -> the default-build attribute.
// Every package under sites/ is a product app; nothing else is.
// case: S-179.48
func TestRealWorkspaceMarksExactlyTheSitesAsProductApps(t *testing.T) {
	ws, cfg := realWorkspace(t)
	sites := 0
	for _, pkg := range ws.Packages {
		category, ok := cfg.Workspace.FindCategory(pkg.Category)
		if !ok {
			continue
		}
		isSite := strings.HasPrefix(pkg.RelPath, "sites/")
		if isSite {
			sites++
		}
		if isSite == category.BuiltByDefault() {
			t.Errorf("%s (%s, category %s): built by default = %t", pkg.Name, pkg.RelPath, pkg.Category, category.BuiltByDefault())
		}
	}
	if sites == 0 {
		t.Fatal("found no packages under sites/")
	}
}
