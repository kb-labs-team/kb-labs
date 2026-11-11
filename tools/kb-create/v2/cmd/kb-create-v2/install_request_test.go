package v2cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

// case: S-040.1
func TestInstallWizardPreservesCallerRequestFields(t *testing.T) {
	projectRoot := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(projectRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	canonicalProjectRoot, err := filepath.EvalSymlinks(projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	base := contracts.InstallRequest{
		PlatformRoot: "/tmp/platform", ProjectRoot: canonicalProjectRoot,
		Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, ServiceProfile: "default",
	}
	request, err := mergeDirectRequest(base, directRequest{
		GatewayURL: "http://127.0.0.1:4700", PlatformVersion: "2.4.1", SDKVersion: "3.2.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.GatewayURL != "http://127.0.0.1:4700" || request.Platform.Version != "2.4.1" || request.SDK.Version != "3.2.0" {
		t.Fatalf("caller fields were lost during wizard request compilation: %#v", request)
	}
	if request.PlatformRoot != base.PlatformRoot || request.ProjectRoot != canonicalProjectRoot || request.ServiceProfile != base.ServiceProfile {
		t.Fatalf("scenario request fields were lost during merge: %#v", request)
	}
}

func TestInstallWizardCarriesMarketplaceSourcesFromInstallFlags(t *testing.T) {
	request, err := mergeDirectRequest(contracts.InstallRequest{
		PlatformRoot: "/tmp/platform", Platform: contracts.VersionSelector{Channel: contracts.ChannelStable},
	}, directRequest{
		MarketplaceRegistryURL: "https://registry.example.test", MarketplaceSigningKeyEnv: "KB_MARKETPLACE_KEY",
		MarketplaceTokenEnv: "KB_MARKETPLACE_TOKEN", MarketplaceNpmURL: "https://npm.example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := &contracts.MarketplaceSources{RegistryURL: "https://registry.example.test", SigningPublicKeyEnv: "KB_MARKETPLACE_KEY", RegistryTokenEnv: "KB_MARKETPLACE_TOKEN", NpmURL: "https://npm.example.test"}
	if request.MarketplaceSources == nil || *request.MarketplaceSources != *want {
		t.Fatalf("marketplace sources = %#v, want %#v", request.MarketplaceSources, want)
	}
}

func TestInstallWizardCarriesNpmOnlyMarketplaceMirror(t *testing.T) {
	request, err := mergeDirectRequest(contracts.InstallRequest{
		PlatformRoot: "/tmp/platform", Platform: contracts.VersionSelector{Channel: contracts.ChannelStable},
	}, directRequest{MarketplaceNpmURL: "http://verdaccio:4873"})
	if err != nil {
		t.Fatalf("mergeDirectRequest() rejected an npm-only Marketplace mirror: %v", err)
	}
	if request.MarketplaceSources == nil || request.MarketplaceSources.NpmURL != "http://verdaccio:4873" {
		t.Fatalf("MarketplaceSources = %#v, want the Verdaccio npm source", request.MarketplaceSources)
	}
}
