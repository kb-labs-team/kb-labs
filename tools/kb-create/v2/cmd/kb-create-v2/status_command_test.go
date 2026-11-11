package v2cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/render"
)

func TestMarketplaceSourceStatusRedactsCredentialValues(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, ".kb", "kb.config.jsonc")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"marketplace":{"sources":[{"kind":"registry","url":"https://registry.example.test","signingPublicKey":"literal-private-key","authToken":"literal-token"},{"kind":"npm","url":"https://npm.example.test"}]}}`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	sources, err := marketplaceSourceStatus(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 || sources[0]["kind"] != "registry" || sources[1]["kind"] != "npm" {
		t.Fatalf("sources = %#v", sources)
	}
	if sources[0]["signingKeyConfigured"] != true || sources[0]["authTokenConfigured"] != true {
		t.Fatalf("credential status = %#v", sources[0])
	}
	for _, source := range sources {
		if _, leaks := source["authToken"]; leaks {
			t.Fatalf("credential value leaked: %#v", source)
		}
		if _, leaks := source["signingPublicKey"]; leaks {
			t.Fatalf("signing key leaked: %#v", source)
		}
	}
}

func TestMarketplaceSourceStatusReadsGoRenderedSourceShape(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{
		Schema: contracts.ResolvedPlanSchema,
		Request: contracts.InstallRequest{MarketplaceSources: &contracts.MarketplaceSources{
			RegistryURL: "https://registry.example.test", SigningPublicKeyEnv: "KB_REGISTRY_PUBLIC_KEY",
			RegistryTokenEnv: "KB_REGISTRY_TOKEN", NpmURL: "https://npm.example.test",
		}},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.120.1", Services: []contracts.Service{{ID: "gateway"}}},
	}
	output, err := render.Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, ".kb", render.ConfigFilename)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, output.Config, 0o600); err != nil {
		t.Fatal(err)
	}

	sources, err := marketplaceSourceStatus(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 || sources[0]["kind"] != "registry" || sources[1]["kind"] != "npm" {
		t.Fatalf("sources = %#v", sources)
	}
	if sources[0]["signingKeyConfigured"] != true || sources[0]["authTokenConfigured"] != true {
		t.Fatalf("credential status = %#v", sources[0])
	}
	for _, source := range sources {
		if _, leaks := source["authToken"]; leaks {
			t.Fatalf("credential value leaked: %#v", source)
		}
		if _, leaks := source["signingPublicKey"]; leaks {
			t.Fatalf("signing key leaked: %#v", source)
		}
	}
}

// case: S-268.12
func TestMarketplaceNpmOnlySourceStatusReadsGoRenderedMirror(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{
		Schema:       contracts.ResolvedPlanSchema,
		Request:      contracts.InstallRequest{MarketplaceSources: &contracts.MarketplaceSources{NpmURL: "http://verdaccio:4873"}},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.120.1", Services: []contracts.Service{{ID: "gateway"}}},
	}
	output, err := render.Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, ".kb", render.ConfigFilename)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, output.Config, 0o600); err != nil {
		t.Fatal(err)
	}

	sources, err := marketplaceSourceStatus(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 1 || sources[0]["kind"] != "npm" || sources[0]["url"] != "http://verdaccio:4873" {
		t.Fatalf("Marketplace source status = %#v, want the rendered npm mirror", sources)
	}
}
