package v2cli

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/resolve"
)

// case: S-181.7
func TestGeneratedSecretReplanUsesInstallCacheAndRestoresStagingRoot(t *testing.T) {
	installRoot := t.TempDir()
	stagingRoot := filepath.Join(installRoot, ".kb", "v2", "versions", "stage")
	request := contracts.InstallRequest{PlatformRoot: stagingRoot, Source: contracts.SourceOffline}
	plannedRequest, restoredRequest := generatedSecretReplanRequest(request, installRoot, stagingRoot, true)
	if plannedRequest.PlatformRoot != installRoot {
		t.Fatalf("generated-secret replan root = %q, want stable install root", plannedRequest.PlatformRoot)
	}
	if restoredRequest.PlatformRoot != stagingRoot {
		t.Fatalf("post-replan root = %q, want initial staging root", restoredRequest.PlatformRoot)
	}
	if plannedRequest.Source != contracts.SourceOffline || restoredRequest.Source != contracts.SourceOffline {
		t.Fatalf("replan changed source: planned=%q restored=%q", plannedRequest.Source, restoredRequest.Source)
	}

	packageBytes := testfixtures.PackageTarball("@kb/platform", "2.0.0", nil)
	digest := sha256.Sum256(packageBytes)
	hash := hex.EncodeToString(digest[:])
	cachePath := filepath.Join(installRoot, "state", "cache", "packages", hash+".tgz")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, packageBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: hash,
			Tarball:  "https://registry.example/platform.tgz",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}}}}}
	source = testfixtures.CatalogWithTarballURLs(source)
	sealed, err := testfixtures.SealCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err = catalog.Seal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := resolve.PlanWith(plannedRequest, sealed, resolve.Options{})
	if err != nil {
		t.Fatalf("generated-secret replan did not resolve from the install-root cache: %v", err)
	}
	if len(resolved.Artifacts) != 1 || resolved.Artifacts[0].ResolvedFrom != "cache" {
		t.Fatalf("offline replan artifact provenance = %#v, want checksum-verified cache", resolved.Artifacts)
	}
	resolved.Request = restoredRequest
	if resolved.Request.PlatformRoot != stagingRoot {
		t.Fatalf("resolved plan writes at %q, want staging root %q", resolved.Request.PlatformRoot, stagingRoot)
	}
}
