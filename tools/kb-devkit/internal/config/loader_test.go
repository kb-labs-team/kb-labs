package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverFindsNearestConfigUpward(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "apps", "service", "src")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}

	want := filepath.Join(root, "apps", "service", "devkit.yaml")
	if err := os.WriteFile(want, []byte("schemaVersion: 2\nextends: [builtin:generic]\n"), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	got, err := Discover(nested)
	if err != nil {
		t.Fatalf("Discover error: %v", err)
	}
	if got != want {
		t.Fatalf("Discover = %q, want %q", got, want)
	}
}

func TestDiscoverReturnsHelpfulErrorWhenMissing(t *testing.T) {
	root := t.TempDir()

	_, err := Discover(root)
	if err == nil {
		t.Fatal("Discover error = nil, want error")
	}
	if !strings.Contains(err.Error(), "no devkit.yaml found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLoadFileParsesYAMLAndRejectsUnsupportedExtension(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "devkit.yaml")
	content := `
schemaVersion: 2
extends: [builtin:generic]
workspace:
  packageManager: pnpm
  maxDepth: 5
  categories:
    libs:
      match: ["packages/*"]
      preset: node-lib
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write yaml: %v", err)
	}

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile error: %v", err)
	}
	if cfg.SchemaVersion != 2 || cfg.Workspace.PackageManager != "pnpm" || cfg.Workspace.MaxDepth != 5 {
		t.Fatalf("unexpected config: %+v", cfg)
	}

	badPath := filepath.Join(root, "devkit.json")
	if err := os.WriteFile(badPath, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write json: %v", err)
	}
	if _, err := LoadFile(badPath); err == nil {
		t.Fatal("LoadFile unsupported extension error = nil, want error")
	}
}

func TestRootDirReturnsConfigParent(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "nested", "devkit.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if got := RootDir(configPath); got != filepath.Dir(configPath) {
		t.Fatalf("RootDir = %q, want %q", got, filepath.Dir(configPath))
	}
}

func TestLoadFileResolvesBuiltInPackViaExtends(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "devkit.yaml")
	content := `
schemaVersion: 2
extends: [builtin:generic]
workspace:
  packageManager: pnpm
categories:
  libs:
    match: ["packages/**"]
    preset: node-lib
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write yaml: %v", err)
	}

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile error: %v", err)
	}
	preset, err := ResolvePreset("node-lib", cfg)
	if err != nil {
		t.Fatalf("ResolvePreset error: %v", err)
	}
	if preset.PackageJSON.RequiredDevDeps["typescript"] != "^5" {
		t.Fatalf("preset = %+v", preset)
	}
	if len(cfg.Workspace.Categories) != 1 || cfg.Workspace.Categories[0].Name != "libs" {
		t.Fatalf("categories = %#v", cfg.Workspace.Categories)
	}
}

func TestLoadFileWithoutExtendsUsesOnlyLocalPresetsAndConfig(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "devkit.yaml")
	content := `
schemaVersion: 2
workspace:
  packageManager: pnpm
categories:
  libs:
    match: ["packages/**"]
    preset: custom
presets:
  custom:
    language: typescript
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write yaml: %v", err)
	}

	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile error: %v", err)
	}
	preset, err := ResolvePreset("custom", cfg)
	if err != nil {
		t.Fatalf("ResolvePreset error: %v", err)
	}
	if preset.Language != "typescript" {
		t.Fatalf("preset = %+v", preset)
	}
}

// Seam: the repository's real devkit.yaml, read by the loader `kb-devkit run`
// uses, must carry run.task_memory_mb; a dropped field silently disables
// memory admission.
func TestRepositoryDevkitYamlCarriesTaskMemory(t *testing.T) {
	cfg, err := LoadFile(filepath.Join("..", "..", "..", "..", "devkit.yaml"))
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if cfg.Run.TaskMemoryMB != 2419 {
		t.Fatalf("Run.TaskMemoryMB = %d, want 2419", cfg.Run.TaskMemoryMB)
	}
}

func TestChildTaskMemoryOverridesExtendedConfig(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "base.yaml")
	if err := os.WriteFile(base, []byte("schemaVersion: 2\nrun:\n  task_memory_mb: 100\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(root, "devkit.yaml")
	if err := os.WriteFile(child, []byte("schemaVersion: 2\nextends: [./base.yaml]\nrun:\n  task_memory_mb: 200\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile(child)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if cfg.Run.TaskMemoryMB != 200 {
		t.Fatalf("child override: got %d, want 200", cfg.Run.TaskMemoryMB)
	}
	if err := os.WriteFile(child, []byte("schemaVersion: 2\nextends: [./base.yaml]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err = LoadFile(child)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if cfg.Run.TaskMemoryMB != 100 {
		t.Fatalf("inherited: got %d, want 100", cfg.Run.TaskMemoryMB)
	}
}
