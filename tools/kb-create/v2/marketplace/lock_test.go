package marketplace

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

func TestWriteLock_PluginsAndAdaptersOnly(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "@kb-labs/commit", `{"name":"@kb-labs/commit"}`)
	writePackageJSON(t, root, "@kb-labs/adapters-sqlite", `{"name":"@kb-labs/adapters-sqlite"}`)
	artifacts := []contracts.Artifact{
		{ID: "@kb-labs/platform-core", Kind: "platform", Package: "@kb-labs/platform-core", Version: "1.0.0"},
		{ID: "@kb-labs/binary-kbdev", Kind: "binary", Version: "1.0.0"},
		{ID: "@kb-labs/commit", Kind: "plugin", Package: "@kb-labs/commit", Version: "1.2.3", SHA256: strings.Repeat("a", 64)},
		{ID: "@kb-labs/adapters-sqlite", Kind: "adapter", Package: "@kb-labs/adapters-sqlite", Version: "4.5.6"},
	}

	if err := WriteLock(root, root, artifacts, time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("WriteLock: %v", err)
	}

	lock := readBack(t, root)
	if lock.Schema != Schema {
		t.Fatalf("schema = %q, want %q", lock.Schema, Schema)
	}
	if len(lock.Plugins) != 1 || len(lock.Adapters) != 1 {
		t.Fatalf("plugins/adapters = %d/%d, want 1/1 (non-discoverable kinds must be excluded): %+v", len(lock.Plugins), len(lock.Adapters), lock)
	}
	plugin, ok := lock.Plugins["@kb-labs/commit"]
	if !ok {
		t.Fatal("plugin entry missing")
	}
	if plugin.ResolvedPath != "node_modules/@kb-labs/commit" {
		t.Errorf("resolvedPath = %q", plugin.ResolvedPath)
	}
	if plugin.Package != "@kb-labs/commit" {
		t.Errorf("package = %q", plugin.Package)
	}
	if !plugin.Enabled {
		t.Error("fresh entry should default to enabled")
	}
	if plugin.Integrity == "" {
		t.Error("integrity should be carried from installed package metadata")
	}
	if adapter, ok := lock.Adapters["@kb-labs/adapters-sqlite"]; !ok || adapter.Source != "platform" {
		t.Errorf("adapter missing from machine adapters map: %+v", lock.Adapters)
	}
}

func TestReadLockRejectsPluginWithoutPackage(t *testing.T) {
	root := t.TempDir()
	lockPath := filepath.Join(root, ".kb", "marketplace.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o750); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"schema":"kb.marketplace/3","plugins":{"@kb-labs/commit":{"version":"1.0.0","integrity":"sha256-abc","resolvedPath":"node_modules/@kb-labs/commit","source":"platform","enabled":true}}}`)
	if err := os.WriteFile(lockPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readLock(root); err == nil || !strings.Contains(err.Error(), "require a package") {
		t.Fatalf("readLock error = %v, want required package validation", err)
	}
}

func TestPreserveInstalledComponentsAddsOnlyPlatformAdaptersToUpdateRequest(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	writeRaw(t, root, Lock{
		Schema: Schema,
		Plugins: map[string]Item{
			"commit": {Version: "1.2.3", Package: "@kb-labs/commit", Source: "platform", Enabled: true},
		},
		Adapters: map[string]Item{
			"vibeproxy": {Version: "2.0.0", Source: "platform", Enabled: true},
		},
	})
	request := contracts.InstallRequest{
		Plugins:  []contracts.ComponentRequest{{ID: "requested-plugin"}},
		Adapters: []contracts.ComponentRequest{{ID: "openai"}, {ID: "vibeproxy"}},
	}

	if _, err := PreserveInstalledComponents(root, &request); err != nil {
		t.Fatalf("PreserveInstalledComponents: %v", err)
	}

	pluginIDs := make(map[string]bool)
	for _, component := range request.Plugins {
		pluginIDs[component.ID] = true
	}
	adapterIDs := make(map[string]bool)
	for _, component := range request.Adapters {
		adapterIDs[component.ID] = true
	}
	if len(pluginIDs) != 1 || !pluginIDs["requested-plugin"] {
		t.Errorf("plugins = %+v; Marketplace plugin identities must not enter the release-index request", request.Plugins)
	}
	if !adapterIDs["openai"] || !adapterIDs["vibeproxy"] {
		t.Errorf("adapters = %+v; installed and requested adapters must both remain", request.Adapters)
	}
	if len(request.Adapters) != 2 {
		t.Errorf("adapters = %+v; an existing request must not be duplicated", request.Adapters)
	}
}

func TestWriteLockCarriesMarketplacePluginIdentityAcrossPlatformUpdate(t *testing.T) {
	activeRoot, targetRoot := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(activeRoot, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	writeRaw(t, activeRoot, Lock{Schema: Schema, Plugins: map[string]Item{
		"@kb-labs/commit": {Version: "2.1.0", Integrity: "sha256-commit", Package: "@kb-labs/commit", Source: "marketplace", MarketplaceSource: "registry", SignatureStatus: "verified", Enabled: true},
	}})
	if err := WriteLock(targetRoot, activeRoot, nil, time.Now()); err != nil {
		t.Fatalf("WriteLock: %v", err)
	}
	entry, ok := readBack(t, targetRoot).Plugins["@kb-labs/commit"]
	if !ok || entry.Source != "marketplace" || entry.MarketplaceSource != "registry" || entry.Version != "2.1.0" {
		t.Fatalf("updated Marketplace entry = %#v, present=%v", entry, ok)
	}
}

func TestWriteLock_PreservesDisabledAcrossReapply(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "@kb-labs/plugin-commit", `{"name":"@kb-labs/plugin-commit"}`)
	artifacts := []contracts.Artifact{
		{ID: "@kb-labs/plugin-commit", Kind: "plugin", Package: "@kb-labs/plugin-commit", Version: "1.0.0"},
	}
	now := time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)
	if err := WriteLock(root, root, artifacts, now); err != nil {
		t.Fatalf("first WriteLock: %v", err)
	}

	// Simulate a user disabling the plugin out of band (as `kb marketplace
	// disable` would).
	lock := readBack(t, root)
	entry := lock.Plugins["@kb-labs/plugin-commit"]
	entry.Enabled = false
	lock.Plugins["@kb-labs/plugin-commit"] = entry
	writeRaw(t, root, lock)

	// A re-apply with the same artifact must not silently re-enable it.
	if err := WriteLock(root, root, artifacts, now.Add(time.Hour)); err != nil {
		t.Fatalf("second WriteLock: %v", err)
	}
	after := readBack(t, root)
	if after.Plugins["@kb-labs/plugin-commit"].Enabled {
		t.Error("re-apply must preserve a previously disabled entry")
	}
}

func TestWriteLockUpdatePreservesEnabledStateFromActiveRoot(t *testing.T) {
	activeRoot := t.TempDir()
	targetRoot := t.TempDir()
	writePackageJSON(t, activeRoot, "@kb-labs/plugin-commit", `{"name":"@kb-labs/plugin-commit"}`)
	writePackageJSON(t, targetRoot, "@kb-labs/plugin-commit", `{"name":"@kb-labs/plugin-commit"}`)
	artifacts := []contracts.Artifact{{
		ID: "commit", Kind: "plugin", Package: "@kb-labs/plugin-commit", Version: "1.0.0",
	}}
	if err := WriteLock(activeRoot, activeRoot, artifacts, time.Now()); err != nil {
		t.Fatalf("write active lock: %v", err)
	}
	lock := readBack(t, activeRoot)
	entry := lock.Plugins["commit"]
	entry.Enabled = false
	lock.Plugins["commit"] = entry
	writeRaw(t, activeRoot, lock)

	if err := WriteLock(targetRoot, activeRoot, artifacts, time.Now()); err != nil {
		t.Fatalf("write target lock from active root: %v", err)
	}
	if readBack(t, targetRoot).Plugins["commit"].Enabled {
		t.Fatal("update enabled a plugin that was disabled in the active marketplace lock")
	}
}

func TestWriteLock_NoDiscoverableArtifacts_NoFileWritten(t *testing.T) {
	root := t.TempDir()
	artifacts := []contracts.Artifact{
		{ID: "@kb-labs/platform-core", Kind: "platform", Package: "@kb-labs/platform-core", Version: "1.0.0"},
	}
	if err := WriteLock(root, root, artifacts, time.Now()); err != nil {
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

func writePackageJSON(t *testing.T, root, packageName, contents string) {
	t.Helper()
	packageDir := filepath.Join(root, "node_modules", filepath.FromSlash(packageName))
	if err := os.MkdirAll(packageDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageDir, "package.json"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestWriteLockRegistersPlatformMembersThatArePlugins(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "@kb/workflow-entry", `{"name":"@kb/workflow-entry"}`)
	err := WriteLock(root, root, []contracts.Artifact{
		{ID: "workflow", Kind: "platform-member", Registry: "plugin", Package: "@kb/workflow-entry", Version: "2.0.0"},
		{ID: "gateway", Kind: "platform-member", Package: "@kb/gateway", Version: "2.0.0"},
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	lock, err := readLock(root)
	if err != nil || len(lock.Plugins) != 1 || lock.Plugins["workflow"].Source != "platform" {
		t.Fatalf("lock = %+v / %v", lock, err)
	}
}

// case: S-006.3
func TestWriteLockUsesInstalledPackageJSONIntegrity(t *testing.T) {
	root := t.TempDir()
	packageJSON := `{"name":"@kb-labs/workflow-entry","version":"2.0.0"}`
	writePackageJSON(t, root, "@kb-labs/workflow-entry", packageJSON)
	if err := WriteLock(root, root, []contracts.Artifact{{
		ID: "workflow", Kind: "platform-member", Registry: "plugin",
		Package: "@kb-labs/workflow-entry", Version: "2.0.0", SHA256: strings.Repeat("a", 64),
	}}, time.Now()); err != nil {
		t.Fatalf("WriteLock: %v", err)
	}

	digest := sha256.Sum256([]byte(packageJSON))
	want := "sha256-" + base64.StdEncoding.EncodeToString(digest[:])
	if got := readBack(t, root).Plugins["workflow"].Integrity; got != want {
		t.Fatalf("integrity = %q, want installed package.json integrity %q", got, want)
	}
}
