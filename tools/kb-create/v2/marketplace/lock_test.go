package marketplace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

func TestWriteLock_PluginsAndAdaptersOnly(t *testing.T) {
	root := t.TempDir()
	artifacts := []contracts.Artifact{
		{ID: "@kb-labs/platform-core", Kind: "platform", Package: "@kb-labs/platform-core", Version: "1.0.0"},
		{ID: "@kb-labs/binary-kbdev", Kind: "binary", Version: "1.0.0"},
		{ID: "@kb-labs/plugin-commit", Kind: "plugin", Package: "@kb-labs/plugin-commit", Version: "1.2.3"},
		{ID: "@kb-labs/adapters-sqlite", Kind: "adapter", Package: "@kb-labs/adapters-sqlite", Version: "4.5.6"},
	}

	if err := WriteLock(root, artifacts, time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("WriteLock: %v", err)
	}

	lock := readBack(t, root)
	if lock.Schema != Schema {
		t.Fatalf("schema = %q, want %q", lock.Schema, Schema)
	}
	if len(lock.Installed) != 2 {
		t.Fatalf("installed = %d entries, want 2 (platform/binary kinds must be excluded): %+v", len(lock.Installed), lock.Installed)
	}
	plugin, ok := lock.Installed["@kb-labs/plugin-commit"]
	if !ok {
		t.Fatal("plugin entry missing")
	}
	if plugin.ResolvedPath != "node_modules/@kb-labs/plugin-commit" {
		t.Errorf("resolvedPath = %q", plugin.ResolvedPath)
	}
	if !plugin.Enabled {
		t.Error("fresh entry should default to enabled")
	}
	if plugin.Integrity != "" {
		t.Errorf("integrity should be empty (skips core-discovery's check), got %q", plugin.Integrity)
	}
}

func TestWriteLock_PreservesDisabledAcrossReapply(t *testing.T) {
	root := t.TempDir()
	artifacts := []contracts.Artifact{
		{ID: "@kb-labs/plugin-commit", Kind: "plugin", Package: "@kb-labs/plugin-commit", Version: "1.0.0"},
	}
	now := time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)
	if err := WriteLock(root, artifacts, now); err != nil {
		t.Fatalf("first WriteLock: %v", err)
	}

	// Simulate a user disabling the plugin out of band (as `kb marketplace
	// disable` would).
	lock := readBack(t, root)
	entry := lock.Installed["@kb-labs/plugin-commit"]
	entry.Enabled = false
	lock.Installed["@kb-labs/plugin-commit"] = entry
	writeRaw(t, root, lock)

	// A re-apply with the same artifact must not silently re-enable it.
	if err := WriteLock(root, artifacts, now.Add(time.Hour)); err != nil {
		t.Fatalf("second WriteLock: %v", err)
	}
	after := readBack(t, root)
	if after.Installed["@kb-labs/plugin-commit"].Enabled {
		t.Error("re-apply must preserve a previously disabled entry")
	}
}

func TestWriteLock_NoDiscoverableArtifacts_NoFileWritten(t *testing.T) {
	root := t.TempDir()
	artifacts := []contracts.Artifact{
		{ID: "@kb-labs/platform-core", Kind: "platform", Package: "@kb-labs/platform-core", Version: "1.0.0"},
	}
	if err := WriteLock(root, artifacts, time.Now()); err != nil {
		t.Fatalf("WriteLock: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "marketplace.lock")); !os.IsNotExist(err) {
		t.Fatalf("expected no lock file, got err=%v", err)
	}
}

func readBack(t *testing.T, root string) Lock {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, ".kb", "marketplace.lock"))
	if err != nil {
		t.Fatalf("read lock: %v", err)
	}
	var lock Lock
	if err := json.Unmarshal(data, &lock); err != nil {
		t.Fatalf("unmarshal lock: %v", err)
	}
	return lock
}

func writeRaw(t *testing.T, root string, lock Lock) {
	t.Helper()
	data, err := json.MarshalIndent(lock, "", "  ")
	if err != nil {
		t.Fatalf("marshal lock: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "marketplace.lock"), data, 0o600); err != nil {
		t.Fatalf("write lock: %v", err)
	}
}
