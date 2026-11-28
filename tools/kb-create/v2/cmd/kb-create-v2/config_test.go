package v2cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

// case: PC-001.20
func TestInstallConfigMergesOnlyDeclaredRequestFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := []byte(`{"marketplaceSources":{"registryUrl":"http://127.0.0.1:45100/api/v1/marketplace-registry","signingPublicKeyEnv":"KB_REGISTRY_KEY","npmUrl":"http://verdaccio:4873"},"serviceTransportURLs":{"marketplace-registry":"http://registry:3000"},"values":{"gateway.marketplaceRegistryRoute":{"serviceId":"marketplace-registry","prefix":"/api/v1/marketplace-registry"}},"secretInputs":["gateway.internalSecret"]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := readInstallConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	request, err := mergeInstallConfig(contracts.InstallRequest{
		Schema: contracts.RequestSchema, PlatformRoot: filepath.Join(t.TempDir(), "platform"),
		GatewayURL: "http://127.0.0.1:45100", Values: map[string]string{"gateway.access.mode": `"secured"`},
	}, config)
	if err != nil {
		t.Fatal(err)
	}
	if request.MarketplaceSources == nil || request.MarketplaceSources.RegistryURL != "http://127.0.0.1:45100/api/v1/marketplace-registry" ||
		request.MarketplaceSources.SigningPublicKeyEnv != "KB_REGISTRY_KEY" || request.MarketplaceSources.NpmURL != "http://verdaccio:4873" {
		t.Fatalf("Marketplace sources = %#v", request.MarketplaceSources)
	}
	var route map[string]any
	if err := json.Unmarshal([]byte(request.Values["gateway.marketplaceRegistryRoute"]), &route); err != nil || route["serviceId"] != "marketplace-registry" {
		t.Fatalf("route value = %q (%v)", request.Values["gateway.marketplaceRegistryRoute"], err)
	}
	if request.ServiceTransportURLs["marketplace-registry"] != "http://registry:3000" || request.Values["platform.adapterOptions"] != "" {
		t.Fatalf("service transport override = %#v; adapter options should not be replaced: %#v", request.ServiceTransportURLs, request.Values["platform.adapterOptions"])
	}
	if request.Values["gateway.access.mode"] != `"secured"` || len(request.SecretInputs) != 1 || request.SecretInputs[0] != "gateway.internalSecret" {
		t.Fatalf("existing request fields were not retained: %#v", request)
	}
	if request.ServiceTransportURLs["marketplace-registry"] != "http://registry:3000" {
		t.Fatalf("typed service transport config = %#v", request.ServiceTransportURLs)
	}
}

// case: PC-001.20
func TestInstallConfigRejectsPathsAndUnknownFields(t *testing.T) {
	for _, contents := range []string{
		`{"operations":[{"op":"replace","path":"/platform/adapterOptions","value":{}}]}`,
		`{"values":{"platform.adapterOptions":{}},"configPath":"/arbitrary/path"}`,
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := readInstallConfig(path); err == nil {
			t.Fatalf("accepted unsupported config fields: %s", contents)
		}
	}
	config := installConfig{ServiceTransportURLs: map[string]string{
		"marketplace-registry": "https://registry.example.test/?token=secret",
	}}
	if _, err := mergeInstallConfig(contracts.InstallRequest{PlatformRoot: filepath.Join(t.TempDir(), "platform")}, config); err == nil {
		t.Fatal("accepted query parameters in service transport URL")
	}
	if _, err := mergeInstallConfig(contracts.InstallRequest{Values: map[string]string{}}, installConfig{
		Values: map[string]json.RawMessage{"marketplace.sources": json.RawMessage(`[{"kind":"npm","url":"https://npm.example.test","authToken":"literal"}]`)},
	}); err == nil {
		t.Fatal("accepted Marketplace sources through untyped config values")
	}
}

// case: PC-001.20, S-268.6
func TestInstallConfigRejectsInlineSecretsFromReleaseCatalog(t *testing.T) {
	source, err := catalog.LoadFile("testdata/x251-release-index.json")
	if err != nil {
		t.Fatal(err)
	}
	requirements := append([]contracts.ConfigRequirement(nil), source.Platforms[0].Config...)
	var openAISecrets []contracts.ConfigRequirement
	for _, adapter := range source.Adapters {
		if adapter.ID == "openai-llm" {
			openAISecrets = adapter.Config
		}
	}
	if len(openAISecrets) == 0 {
		t.Fatal("real x251 release catalog omitted openai-llm secret requirements")
	}
	artifacts := []contracts.Artifact{{Config: append(requirements, openAISecrets...)}}
	cases := []struct {
		name   string
		values map[string]string
	}{
		{name: "marketplace auth token", values: map[string]string{
			"marketplace.sources": `[{"kind":"registry","url":"https://registry.example.test","authToken":"literal-token"}]`,
		}},
		{name: "nested adapter secret", values: map[string]string{
			"platform.adapterOptions": `{"llm":{"apiKey":"literal-key"}}`,
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := validateConfigValues(contracts.InstallRequest{Values: test.values}, artifacts); err == nil {
				t.Fatalf("accepted inline secret from real release metadata: %#v", test.values)
			}
		})
	}
	if err := validateConfigValues(contracts.InstallRequest{Values: map[string]string{
		"platform.adapterOptions": `{"llm":{"apiKey":"${OPENAI_API_KEY}"}}`,
	}}, artifacts); err != nil {
		t.Fatalf("rejected manifest-declared secret reference: %v", err)
	}
}

// case: PC-001.20
func TestLegacyRequestMarketplaceSourcesRemainSupportedWithoutInlineCredentials(t *testing.T) {
	source, err := catalog.LoadFile("testdata/x251-release-index.json")
	if err != nil {
		t.Fatal(err)
	}
	artifacts := []contracts.Artifact{{Config: source.Platforms[0].Config}}
	for _, raw := range []string{
		`[{"kind":"npm","url":"https://npm.example.test"}]`,
		`[{"kind":"registry","url":"https://registry.example.test","authToken":"${REGISTRY_TOKEN}"}]`,
	} {
		if err := validateConfigValues(contracts.InstallRequest{Values: map[string]string{"marketplace.sources": raw}}, artifacts); err != nil {
			t.Fatalf("legacy request marketplace.sources %s rejected: %v", raw, err)
		}
	}
	if err := validateConfigValues(contracts.InstallRequest{Values: map[string]string{
		"marketplace.sources": `[{"kind":"registry","url":"https://registry.example.test","authToken":"plaintext"}]`,
	}}, artifacts); err == nil {
		t.Fatal("legacy request accepted an inline Marketplace credential")
	}
	if err := validateConfigValues(contracts.InstallRequest{Values: map[string]string{
		"marketplace.sources": `[{"kind":"npm","url":"https://npm.example.test/?token=query-secret"}]`,
	}}, artifacts); err == nil {
		t.Fatal("legacy request accepted a secret-bearing Marketplace URL query")
	}
}

// case: PC-001.20
func TestInstallConfigRejectsLiteralAndSecretReferenceForSameID(t *testing.T) {
	config := installConfig{Values: map[string]json.RawMessage{"gateway.token": json.RawMessage(`"literal"`)}, SecretInputs: []string{"gateway.token"}}
	if _, err := mergeInstallConfig(contracts.InstallRequest{Values: map[string]string{}}, config); err == nil {
		t.Fatal("accepted a config ID as both a literal and a secret reference")
	}
}

// case: PC-001.20
func TestInvalidScenarioOverlayDoesNotPersistScenarioState(t *testing.T) {
	root := filepath.Join(t.TempDir(), "platform")
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{"values":{"unknown.setting":"\"value\""}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	indexData, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, indexData, 0o600); err != nil {
		t.Fatal(err)
	}
	_, failure := resolvePlan(planInput{
		Operation: "plan", Index: indexPath, ConfigFile: configPath, ScenarioID: "custom",
		Answers: `{"access.mode":"local"}`, Direct: directRequest{PlatformRoot: root},
	})
	if failure == nil {
		t.Fatal("plan accepted a config value outside the selected release catalog")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("invalid scenario config wrote platform state before rejection: %v", err)
	}
}
