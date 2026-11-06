package watcher

import (
	"github.com/kb-labs/devkit/internal/testdeadline"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestHandleFSEventDebouncesPerPackage(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "packages", "app")
	if err := os.MkdirAll(filepath.Join(pkgDir, "src"), 0o755); err != nil {
		t.Fatalf("mkdir pkgDir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"workspaces":["packages/*"]}`), 0o644); err != nil {
		t.Fatalf("write root package.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@kb/app"}`), 0o644); err != nil {
		t.Fatalf("write pkg package.json: %v", err)
	}

	ws, err := workspace.New(root, &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}
	w, err := New(ws)
	if err != nil {
		t.Fatalf("New watcher error: %v", err)
	}
	defer w.Stop()

	file1 := filepath.Join(pkgDir, "src", "a.ts")
	file2 := filepath.Join(pkgDir, "src", "b.ts")
	if err := os.MkdirAll(filepath.Dir(file1), 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}

	w.handleFSEvent(fsnotify.Event{Name: file1})
	w.handleFSEvent(fsnotify.Event{Name: file2})

	select {
	case ev := <-w.Events():
		if ev.Event != EventRecheck || ev.Package != "@kb/app" || ev.File != file2 {
			t.Fatalf("unexpected watch event: %+v", ev)
		}
	case <-time.After(testdeadline.Budget(t)):
		t.Fatal("timed out waiting for debounced watch event")
	}
}

func TestHandleFSEventIgnoresUnknownPaths(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "packages", "app")
	if err := os.MkdirAll(filepath.Join(pkgDir, "src"), 0o755); err != nil {
		t.Fatalf("mkdir pkgDir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"workspaces":["packages/*"]}`), 0o644); err != nil {
		t.Fatalf("write root package.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@kb/app"}`), 0o644); err != nil {
		t.Fatalf("write pkg package.json: %v", err)
	}

	ws, err := workspace.New(root, &config.DevkitConfig{
		Workspace: config.WorkspaceConfig{
			Categories: []config.NamedCategory{
				{Name: "libs", Category: config.CategoryConfig{Match: []string{"packages/*"}, Preset: "node-lib"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("workspace.New error: %v", err)
	}
	w, err := New(ws)
	if err != nil {
		t.Fatalf("New watcher error: %v", err)
	}
	defer w.Stop()

	w.handleFSEvent(fsnotify.Event{Name: filepath.Join(root, "elsewhere", "x.ts")})

	select {
	case ev := <-w.Events():
		t.Fatalf("unexpected event for unrelated path: %+v", ev)
	case <-time.After(testdeadline.Budget(t)):
	}
}
