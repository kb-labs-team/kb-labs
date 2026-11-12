package engine

import (
	"path/filepath"
	"sort"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// The repository's own devkit.yaml and package manifests are the real producer of
// task assignments. Every declared task must plan over the real workspace, so a
// task/script mismatch fails here instead of on a hosted runner.
// case: S-179.49
func TestRepositoryTasksPlanOverTheRealWorkspace(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := config.LoadFile(filepath.Join(root, "devkit.yaml"))
	if err != nil {
		t.Fatalf("load repository devkit.yaml: %v", err)
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("load repository workspace: %v", err)
	}
	tasks := make([]string, 0, len(cfg.Tasks))
	for name := range cfg.Tasks {
		tasks = append(tasks, name)
	}
	sort.Strings(tasks)
	for _, task := range tasks {
		if _, err := buildDAG(ws.Packages, []string{task}, cfg, ws); err != nil {
			t.Errorf("repository task %q does not plan: %v", task, err)
		}
	}
}
