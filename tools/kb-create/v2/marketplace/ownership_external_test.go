package marketplace_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/marketplace"
)

// case: S-284.20
func TestMarketplacePinAbsentFromRestoredWorkspaceIsRetained(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0700); err != nil {
		t.Fatal(err)
	}
	lock := marketplace.Lock{Schema: marketplace.Schema, Plugins: map[string]marketplace.Item{
		"marketplace-plugin": {Package: "@kb-labs/marketplace-plugin", Version: "1.0.0", Source: "marketplace", MarketplaceSource: "npm", SignatureStatus: "unsigned"},
	}}
	data, err := json.Marshal(lock)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "marketplace.lock"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pnpm-workspace.yaml"), []byte("minimumReleaseAge: 1440\n"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	verified, err := catalog.VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := artifacts.NewPnpm(artifacts.PnpmConfig{Root: root, CacheRoot: filepath.Join(root, "cache"),
		PackageManagerRoot: filepath.Join(root, "state"), Registry: "https://registry.test",
		ReleaseCatalog: verified, PreviousReleaseCatalog: &verified})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Install(nil); err != nil {
		t.Fatal(err)
	}
	workspace, err := os.ReadFile(filepath.Join(root, "pnpm-workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(workspace), "@kb-labs/marketplace-plugin@1.0.0") {
		t.Fatalf("Marketplace pin missing from restored workspace: %s", workspace)
	}
}
