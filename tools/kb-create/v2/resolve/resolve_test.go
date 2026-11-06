package resolve

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"os"
	"path/filepath"
	"reflect"
	stdruntime "runtime"
	"strings"
	"testing"
)

func planWithFixtureProvenance(request contracts.InstallRequest, source catalog.Catalog) (contracts.ResolvedInstallPlan, error) {
	return planWithFixtureProvenanceOptions(request, source, Options{})
}

func planWithFixtureProvenanceOptions(request contracts.InstallRequest, source catalog.Catalog, options Options) (contracts.ResolvedInstallPlan, error) {
	sealed, err := sealedFixtureCatalog(source)
	if err != nil {
		return contracts.ResolvedInstallPlan{}, err
	}
	return PlanWith(request, sealed, options)
}

func sealedFixtureCatalog(source catalog.Catalog) (catalog.Catalog, error) {
	source = testfixtures.CatalogWithTarballURLs(source)
	sealed, err := testfixtures.SealCatalog(source)
	if err != nil {
		return catalog.Catalog{}, err
	}
	return catalog.Seal(sealed)
}

// case: S-284.20
func TestPlanCarriesSealedTransitivePackageIdentities(t *testing.T) {
	source, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: t.TempDir(), ServiceProfile: "default", Platform: contracts.VersionSelector{Channel: contracts.ChannelCanary}}, source)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		ReleaseCatalog catalog.Catalog `json:"releaseCatalog"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Verify(decoded.ReleaseCatalog); err != nil {
		t.Fatalf("plan did not carry a verified release catalog: %v", err)
	}
	if len(decoded.ReleaseCatalog.Provenance) != len(source.Provenance) {
		t.Fatalf("plan provenance = %d, want %d", len(decoded.ReleaseCatalog.Provenance), len(source.Provenance))
	}
}

// case: S-284.20
func TestPlanRejectsUnverifiedProvenance(t *testing.T) {
	source, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	source.Provenance[0].Version = "1.2.3"
	_, err = Plan(contracts.InstallRequest{PlatformRoot: t.TempDir(), ServiceProfile: "default", Platform: contracts.VersionSelector{Channel: contracts.ChannelCanary}}, source)
	if err == nil {
		t.Fatal("plan accepted changed provenance without verifying the index digest")
	}
}

// case: S-181.4
func TestOfflinePlanReportsChecksumVerifiedCacheResolutionPerArtifact(t *testing.T) {
	root := t.TempDir()
	data := testfixtures.PackageTarball("@kb/platform", "2.0.0", nil)
	digest := sha256.Sum256(data)
	hash := hex.EncodeToString(digest[:])
	cachePath := filepath.Join(root, "state", "cache", "packages", hash+".tgz")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: hash,
			Tarball:  "https://registry.example/platform.tgz",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	}

	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: root, Source: contracts.SourceOffline}, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Artifacts) != 1 || plan.Artifacts[0].ResolvedFrom != "cache" || plan.Artifacts[0].ResolvedURL != "" {
		t.Fatalf("offline artifact provenance = %#v", plan.Artifacts)
	}

	onlinePlan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: root}, source)
	if err != nil {
		t.Fatal(err)
	}
	if onlinePlan.Artifacts[0].ResolvedFrom != "registry" || onlinePlan.Artifacts[0].ResolvedURL != "https://registry.example/platform.tgz" {
		t.Fatalf("registry artifact provenance = %#v", onlinePlan.Artifacts[0])
	}
}

func TestPlanRefusesSelectedPackageWithoutSealedProvenance(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	}
	source, err := catalog.Seal(source)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Plan(contracts.InstallRequest{PlatformRoot: t.TempDir(), ServiceProfile: "default"}, source)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeProvenanceMismatch ||
		failure.Meta["package"] != "@kb/platform" || failure.Meta["field"] != contracts.ProvenanceDigestField ||
		failure.Meta["actual"] != "<missing in sealed provenance record>" {
		t.Fatalf("selected package without sealed provenance was not refused: %#v, %v", failure, err)
	}
}

// case: S-181.4
func TestOfflinePlanRejectsMissingOrCorruptArtifactCacheEntry(t *testing.T) {
	for _, test := range []struct {
		name string
		data []byte
	}{{name: "missing"}, {name: "checksum mismatch", data: []byte("wrong bytes")}} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			wanted := []byte("sealed package bytes")
			digest := sha256.Sum256(wanted)
			hash := hex.EncodeToString(digest[:])
			cachePath := filepath.Join(root, "state", "cache", "packages", hash+".tgz")
			if test.data != nil {
				if err := os.MkdirAll(filepath.Dir(cachePath), 0o750); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(cachePath, test.data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
				Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: hash,
					Tarball: "https://registry.example/platform.tgz", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
					Profiles: map[string]contracts.ServiceGraph{"default": {}}}}}
			if _, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: root, Source: contracts.SourceOffline}, source); err == nil {
				t.Fatal("offline plan accepted an absent or corrupt cache entry")
			}
		})
	}
}

// case: S-285.2
func TestMissingGatewayCanBeResolvedFromHostDeclaration(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{
		ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
		Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
		Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Port: 4000}}}},
		Config:   []catalog.ConfigRequirement{{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: `{"serviceTransport":{"services":{}}}`}},
	}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir()}, source)
	if err != nil || plan.Host == nil || plan.Host.HealthURL != source.Platforms[0].Host.HealthURL {
		t.Fatalf("plan=%+v error=%v", plan, err)
	}
}

// case: S-285.2
func TestExplicitGatewaySuppliesMissingTransportEntry(t *testing.T) {
	graph := contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Port: 4000}, {ID: "rest", Port: 5050}}}
	host := contracts.HostSpec{HealthURL: "http://127.0.0.1:4000/health"}
	patches := []contracts.ConfigPatch{{Path: "/platform/adapterOptions", JSON: `{"serviceTransport":{"services":{"rest":{"url":"http://127.0.0.1:5050"}}}}`}}
	if err := configureGatewayAddress("http://127.0.0.1:5500", &graph, &host, patches); err != nil {
		t.Fatal(err)
	}
	var options struct {
		ServiceTransport struct {
			Services map[string]struct {
				URL string `json:"url"`
			} `json:"services"`
		} `json:"serviceTransport"`
	}
	if err := json.Unmarshal([]byte(patches[0].JSON), &options); err != nil {
		t.Fatal(err)
	}
	if options.ServiceTransport.Services["gateway"].URL != "http://127.0.0.1:5500" || graph.Services[1].Port != 6550 {
		t.Fatalf("options=%s graph=%+v", patches[0].JSON, graph)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(patches[0].JSON), &raw); err != nil {
		t.Fatal(err)
	}
	if raw["serviceTransport"].(map[string]any)["offset"] != float64(0) {
		t.Fatalf("transport would shift the already shifted URLs again: %s", patches[0].JSON)
	}
}

func TestPlanAppliesAnExplicitGatewayAddressToHostServicesAndConfig(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Port: 4000}, {ID: "rest", Port: 5050}}}},
			Config: []catalog.ConfigRequirement{{ID: "platform.adapterOptions", Path: "/platform/adapterOptions",
				Default: `{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:4000"},"rest":{"url":"http://127.0.0.1:5050"}}}}`}},
		}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir(), GatewayURL: "http://127.0.0.1:4100"}, source)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Host == nil || plan.Host.HealthURL != "http://127.0.0.1:4100/health" {
		t.Fatalf("host health URL = %#v", plan.Host)
	}
	if len(plan.ServiceGraph.Services) != 2 || plan.ServiceGraph.Services[0].Port != 4100 || plan.ServiceGraph.Services[1].Port != 5150 {
		t.Fatalf("service graph = %#v", plan.ServiceGraph.Services)
	}
	if plan.Host.Env["KB_NET_OFFSET"] != "100" {
		t.Fatalf("host environment = %#v", plan.Host.Env)
	}
	var optionsPatch *contracts.ConfigPatch
	for index := range plan.ConfigPatches {
		if plan.ConfigPatches[index].Path == "/platform/adapterOptions" {
			optionsPatch = &plan.ConfigPatches[index]
		}
	}
	if optionsPatch == nil {
		t.Fatalf("config patches = %#v", plan.ConfigPatches)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(optionsPatch.JSON), &config); err != nil {
		t.Fatal(err)
	}
	serviceTransport := config["serviceTransport"].(map[string]any)
	services := serviceTransport["services"].(map[string]any)
	gateway := services["gateway"].(map[string]any)
	if gateway["url"] != "http://127.0.0.1:4100" {
		t.Fatalf("gateway config = %#v", gateway)
	}
	rest := services["rest"].(map[string]any)
	if rest["url"] != "http://127.0.0.1:5150" {
		t.Fatalf("rest config = %#v", rest)
	}
}

func TestAmbiguousProviderFailsFast(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Package: "@kb/platform", SHA256: "platform", Version: "2.0.0", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}, Requires: []catalog.Requirement{{Capability: "logs"}}}}, Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "a", Package: "@kb/a", SHA256: "a", Version: "1"}, Provides: []string{"logs"}}, {Component: catalog.Component{ID: "b", Package: "@kb/b", SHA256: "b", Version: "1"}, Provides: []string{"logs"}}}}
	_, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err == nil {
		t.Fatal("expected error")
	}
	if value, ok := err.(*diag.Diag); !ok || value.Code != contracts.CodeProviderAmbiguous {
		t.Fatalf("%T %#v", err, err)
	}
}

// case: S-005.1
func TestClientProfileResolvesWithoutHostOrServices(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}, "client": {}},
			Binaries: []catalog.Binary{{ID: "kb-create", OS: stdruntime.GOOS, Arch: stdruntime.GOARCH, URL: "https://example.test/kb-create", Filename: "kb-create", SHA256: "binary"}},
			Members:  []catalog.Component{{ID: "cli-bin", Version: "2.0.0", Package: "@kb-labs/cli-bin", Tarball: "https://example.test/cli-bin.tgz", SHA256: "cli-bin"}},
		}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir(), ServiceProfile: "client"}, source)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Host != nil || plan.ServiceGraph.Profile != "client" || len(plan.ServiceGraph.Services) != 0 {
		t.Fatalf("client plan = %#v", plan)
	}
	if len(plan.Artifacts) != 2 || plan.Artifacts[0].Kind != "binary" || plan.Artifacts[0].ID != "kb-create" || plan.Artifacts[1].Package != "@kb-labs/cli-bin" || len(plan.ConfigPatches) != 0 {
		t.Fatalf("client artifacts/config = %#v / %#v", plan.Artifacts, plan.ConfigPatches)
	}
}

func TestDeclaredProviderDefaultWinsWithoutOrderDependence(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "p", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}, Requires: []catalog.Requirement{{Capability: "storage"}}}}, Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "z", Version: "1", Package: "@kb/z", SHA256: "z"}, Provides: []string{"storage"}}, {Component: catalog.Component{ID: "a", Version: "1", Package: "@kb/a", SHA256: "a"}, Provides: []string{"storage"}, DefaultFor: []string{"storage"}}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil || len(plan.ProviderBindings) != 1 || plan.ProviderBindings[0].AdapterID != "a" {
		t.Fatalf("plan/error = %#v / %v", plan, err)
	}
}

// cases: S-054.2, S-054.8, S-054.10
func TestSelectedPlatformMemberAdapterRetainsItsCredentialRequirement(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	platformRoot := filepath.Join(home, "kb-platform")
	requirementsData, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "adapters", "openai", "dist", "kb-create.requirements.json"))
	if err != nil {
		t.Fatal(err)
	}
	var requirementsFile struct {
		Requirements []catalog.ConfigRequirement `json:"requirements"`
	}
	if err := json.Unmarshal(requirementsData, &requirementsFile); err != nil {
		t.Fatal(err)
	}
	if len(requirementsFile.Requirements) != 2 {
		t.Fatalf("OpenAI package requirements = %#v", requirementsFile.Requirements)
	}
	requirement := requirementsFile.Requirements[0]
	provider := catalog.Adapter{
		Component: catalog.Component{
			ID: "openai-llm", Version: "2.0.0", Package: "@kb-labs/adapters-openai",
			SHA256: "openai", Config: []catalog.ConfigRequirement{requirement},
		},
		Provides: []string{"llm"}, DefaultFor: []string{"llm"},
	}
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
			Requires: []catalog.Requirement{{Capability: "llm", RequiredBy: "platform"}},
			Members: []catalog.Component{{
				ID: provider.ID, Version: provider.Version, Package: provider.Package, SHA256: provider.SHA256,
			}},
		}},
		Adapters: []catalog.Adapter{provider},
	}

	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: platformRoot}, source)
	if err != nil {
		t.Fatal(err)
	}
	for _, artifact := range plan.Artifacts {
		if artifact.Package != provider.Package {
			continue
		}
		if err := installed.Write(platformRoot, artifact); err != nil {
			t.Fatal(err)
		}
		input, err := installed.DoctorInput(platformRoot, []contracts.Artifact{artifact}, map[string]bool{})
		if err != nil {
			t.Fatal(err)
		}
		findings := doctor.Diagnose(input.Manifests, input.Configured)
		if len(findings) != 1 || findings[0].Code != doctor.CodeAdapterCredentialsMissing || findings[0].Severity != doctor.SeverityWarning || findings[0].Path != requirement.Path || findings[0].Action != requirement.Action {
			t.Fatalf("installed doctor findings = %#v; want the manifest-declared optional OpenAI credential warning", findings)
		}
		return
	}
	t.Fatalf("resolved plan omitted selected OpenAI platform member: %#v", plan.Artifacts)
}

func TestFreshPlatformInstallResolvesAndBindsBuiltinFilesystemStorage(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
			Requires: []catalog.Requirement{{Capability: "storage", RequiredBy: "platform"}},
			Config:   []catalog.ConfigRequirement{{ID: "storage.default", Path: "/platform/adapterOptions/storage", Default: `{"baseDir":"storage"}`}},
		}},
		Adapters: []catalog.Adapter{{
			Component: catalog.Component{ID: "fs-storage", Version: "2.0.0", Package: "@kb-labs/adapters-fs", SHA256: "fs"},
			Provides:  []string{"storage"}, DefaultFor: []string{"storage"},
		}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	adapterArtifacts := 0
	for _, artifact := range plan.Artifacts {
		if artifact.Kind == "adapter" && artifact.Package == "@kb-labs/adapters-fs" {
			adapterArtifacts++
		}
	}
	if adapterArtifacts != 1 {
		t.Fatalf("fresh install artifacts = %#v", plan.Artifacts)
	}
	if len(plan.ProviderBindings) != 1 || plan.ProviderBindings[0].Capability != "storage" || plan.ProviderBindings[0].Package != "@kb-labs/adapters-fs" {
		t.Fatalf("fresh install storage binding = %#v", plan.ProviderBindings)
	}
	if len(plan.ConfigPatches) < 2 || plan.ConfigPatches[1].Path != "/platform/adapters/storage" || plan.ConfigPatches[1].Value != "@kb-labs/adapters-fs@2.0.0" {
		t.Fatalf("fresh install config patches = %#v", plan.ConfigPatches)
	}
}

// case: S-054.1
func TestFreshPlatformInstallBindsEveryPersistentBuiltinAdapter(t *testing.T) {
	capabilities := []string{"storage", "cache", "eventBus", "documentDatabase", "kvStore", "analytics", "logger", "logRingBuffer", "logPersistence", "serviceTransport"}
	providers := []catalog.Adapter{
		{Component: catalog.Component{ID: "fs", Version: "2.0.0", Package: "@kb-labs/adapters-fs", SHA256: "fs"}, Provides: []string{"storage"}, DefaultFor: []string{"storage"}},
		{Component: catalog.Component{ID: "state-broker", Version: "2.0.0", Package: "@kb-labs/adapters-state-broker", SHA256: "cache"}, Provides: []string{"cache"}, DefaultFor: []string{"cache"}},
		{Component: catalog.Component{ID: "eventbus-cache", Version: "2.0.0", Package: "@kb-labs/adapters-eventbus-cache", SHA256: "eventbus"}, Provides: []string{"eventBus"}},
		{Component: catalog.Component{ID: "sqlite", Version: "2.0.0", Package: "@kb-labs/adapters-sqlite", SHA256: "sqlite"}, Provides: []string{"documentDatabase", "kvStore"}, DefaultFor: []string{"documentDatabase", "kvStore"}},
		{Component: catalog.Component{ID: "analytics-sqlite", Version: "2.0.0", Package: "@kb-labs/adapters-analytics-sqlite", SHA256: "analytics"}, Provides: []string{"analytics"}, DefaultFor: []string{"analytics"}},
		{Component: catalog.Component{ID: "pino", Version: "2.0.0", Package: "@kb-labs/adapters-pino", SHA256: "pino"}, Provides: []string{"logger"}, DefaultFor: []string{"logger"}},
		{Component: catalog.Component{ID: "log-ringbuffer", Version: "2.0.0", Package: "@kb-labs/adapters-log-ringbuffer", SHA256: "ring"}, Provides: []string{"logRingBuffer"}},
		{Component: catalog.Component{ID: "log-document", Version: "2.0.0", Package: "@kb-labs/adapters-log-document", SHA256: "logs"}, Provides: []string{"logPersistence"}},
		{Component: catalog.Component{ID: "service-transport", Version: "2.0.0", Package: "@kb-labs/adapters-service-transport-http", SHA256: "transport"}, Provides: []string{"serviceTransport"}},
	}
	requires := make([]catalog.Requirement, len(capabilities))
	for index, capability := range capabilities {
		requires[index] = catalog.Requirement{Capability: capability, RequiredBy: "platform"}
	}
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}}, Requires: requires,
		}},
		Adapters: providers,
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, binding := range plan.ProviderBindings {
		got[binding.Capability] = binding.Package
	}
	want := map[string]string{
		"storage": "@kb-labs/adapters-fs", "cache": "@kb-labs/adapters-state-broker",
		"eventBus":         "@kb-labs/adapters-eventbus-cache",
		"documentDatabase": "@kb-labs/adapters-sqlite", "kvStore": "@kb-labs/adapters-sqlite",
		"analytics": "@kb-labs/adapters-analytics-sqlite", "logger": "@kb-labs/adapters-pino",
		"logRingBuffer": "@kb-labs/adapters-log-ringbuffer", "logPersistence": "@kb-labs/adapters-log-document",
		"serviceTransport": "@kb-labs/adapters-service-transport-http",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("fresh platform provider bindings = %#v, want %#v", got, want)
	}
}

func TestExplicitAdapterSelectionDoesNotConstrainOtherCapabilities(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
			Requires: []catalog.Requirement{{Capability: "serviceTransport"}},
		}},
		Adapters: []catalog.Adapter{
			{Component: catalog.Component{ID: "state-broker", Version: "1", Package: "@kb/state", SHA256: "state"}, Provides: []string{"cache"}},
			{Component: catalog.Component{ID: "service-transport-http", Version: "1", Package: "@kb/transport", SHA256: "transport"}, Provides: []string{"serviceTransport"}},
		},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{
		PlatformRoot:        "/tmp/x",
		Adapters:            []contracts.ComponentRequest{{ID: "state-broker"}},
		ProviderPreferences: map[string]string{"cache": "state-broker"},
	}, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ProviderBindings) != 1 || plan.ProviderBindings[0].Capability != "serviceTransport" || plan.ProviderBindings[0].AdapterID != "service-transport-http" {
		t.Fatalf("provider bindings = %#v", plan.ProviderBindings)
	}
}

func TestPlanProjectsSecretOnlyAsEnvironmentReference(t *testing.T) {
	source := catalog.Catalog{Digest: "release-digest", Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "serve"}}}}, Config: []catalog.ConfigRequirement{{ID: "openai.apiKey", Secret: true, Required: true, Env: "OPENAI_API_KEY", Services: []string{"gateway"}}}}}}
	sealed, err := sealedFixtureCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x", SecretInputs: []string{"openai.apiKey"}}, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ReleaseDigest != sealed.Digest {
		t.Fatalf("release digest = %q", plan.ReleaseDigest)
	}
	if len(plan.ConfigPatches) != 2 || plan.ConfigPatches[1].Environment != "OPENAI_API_KEY" {
		t.Fatalf("patches = %#v", plan.ConfigPatches)
	}
	encoded := plan.ConfigPatches[1]
	if encoded.Value != "" || encoded.JSON != "" || strings.Contains(fmt.Sprint(plan), "OPENAI_API_KEY=") {
		t.Fatalf("secret escaped plan: %#v", plan)
	}
}

// case: S-054.15
func TestPlanAllowsMissingOptionalSecretAndRetainsWarning(t *testing.T) {
	requirement := catalog.ConfigRequirement{ID: "openai.apiKey", Path: "/platform/adapterOptions/llm/apiKey", Secret: true, Required: true, Optional: true, Severity: "warning", Env: "OPENAI_API_KEY", Services: []string{"gateway"}, Action: "set OPENAI_API_KEY to enable LLM features"}
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "serve"}}}}, Config: []catalog.ConfigRequirement{requirement}}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatalf("optional secret blocked plan resolution: %v", err)
	}
	if len(plan.ConfigPatches) != 1 {
		t.Fatalf("missing optional secret must not create an environment patch: %#v", plan.ConfigPatches)
	}
	if len(plan.Artifacts) == 0 || len(plan.Artifacts[0].Config) != 1 || plan.Artifacts[0].Config[0].Severity != "warning" || !plan.Artifacts[0].Config[0].Optional || plan.Artifacts[0].Config[0].Action != requirement.Action {
		t.Fatalf("resolved plan lost optional warning metadata: %#v", plan.Artifacts)
	}
}

func TestPlanStillRejectsMissingRequiredSecret(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "serve"}}}}, Config: []catalog.ConfigRequirement{{ID: "gateway.token", Secret: true, Required: true, Env: "GATEWAY_TOKEN", Services: []string{"gateway"}}}}}}
	_, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if launcherErr, ok := err.(*diag.Diag); !ok || launcherErr.Code != contracts.CodeInputRequired {
		t.Fatalf("missing required secret error = %T %#v", err, err)
	}
}

// case: S-038.4
func TestPlanProjectsGeneratedSecretWithoutUserInput(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway"}, {ID: "rest"}, {ID: "marketplace-registry"}}}},
			Config:   []catalog.ConfigRequirement{{ID: "gateway.internalSecret", Secret: true, Generate: true, Env: "GATEWAY_INTERNAL_SECRET", Services: []string{"gateway", "rest", "marketplace-registry"}}},
		}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Request.SecretInputs) != 0 {
		t.Fatalf("kb-create must not ask the user to supply the generated secret: %v", plan.Request.SecretInputs)
	}
	if len(plan.ConfigPatches) != 2 || plan.ConfigPatches[1].Environment != "GATEWAY_INTERNAL_SECRET" {
		t.Fatalf("generated secret env patch = %#v", plan.ConfigPatches)
	}
	if !reflect.DeepEqual(plan.ConfigPatches[1].Services, []string{"gateway", "rest", "marketplace-registry"}) {
		t.Fatalf("generated secret service targets = %v", plan.ConfigPatches[1].Services)
	}
}

func TestPlanPreservesScenarioProvenance(t *testing.T) {
	source := catalog.Catalog{Digest: "release", Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}}
	sealed, err := sealedFixtureCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x", ScenarioID: "custom", ScenarioStateDigest: "state"}, sealed)
	if err != nil || plan.ReleaseDigest != sealed.Digest || plan.ScenarioStateDigest != "state" {
		t.Fatalf("plan/error = %#v / %v", plan, err)
	}
}

func TestPlanInstallsPlatformMembersAtomically(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Members: []catalog.Component{{ID: "gateway", Version: "2.0.0", Package: "@kb/gateway", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}}, Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	member := false
	for _, artifact := range plan.Artifacts {
		member = member || artifact.Kind == "platform-member" && artifact.ID == "gateway"
	}
	if err != nil || len(plan.Artifacts) != 2 || !member {
		t.Fatalf("plan/error = %#v / %v", plan, err)
	}
}

func TestPlanKeepsPlatformPackageOnceWhenAlsoSelectedAsMemberAdapter(t *testing.T) {
	component := catalog.Component{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform"}
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: component.ID, Version: component.Version, Package: component.Package, Tarball: component.Tarball, SHA256: component.SHA256,
			Members:  []catalog.Component{component},
			Requires: []catalog.Requirement{{Capability: "platform-runtime"}},
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		Adapters: []catalog.Adapter{{Component: component, Provides: []string{"platform-runtime"}, DefaultFor: []string{"platform-runtime"}}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir()}, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Artifacts) != 1 || plan.Artifacts[0].Kind != "platform" || plan.Artifacts[0].Registry != "adapter" {
		t.Fatalf("platform/member/adapter roles did not resolve to one platform artifact: %#v", plan.Artifacts)
	}
	if err := contracts.ValidatePlanArtifactIdentities(plan); err != nil {
		t.Fatalf("resolved plan has duplicate artifact identity: %v", err)
	}
}

func bundledSDKCatalog() catalog.Catalog {
	sdk := catalog.Component{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk-2.0.0.tgz", SHA256: "sdk-2.0.0"}
	return catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Members:  []catalog.Component{sdk},
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		SDKs: []catalog.Component{sdk, {ID: "sdk", Version: "2.1.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk-2.1.0.tgz", SHA256: "sdk-2.1.0"}},
	}
}

// case: S-053.1
func TestPlanRecordsBundledSDKOnceUnderItsSelectedRole(t *testing.T) {
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir(), SDK: contracts.VersionSelector{Version: "2.0.0"}}, bundledSDKCatalog())
	if err != nil {
		t.Fatal(err)
	}
	var records []contracts.Artifact
	for _, item := range plan.Artifacts {
		if item.Package == "@kb/sdk" {
			records = append(records, item)
		}
	}
	sdkArchive := testfixtures.PackageTarball("@kb/sdk", "2.0.0", nil)
	sdkDigest := sha256.Sum256(sdkArchive)
	if len(records) != 1 || records[0].Kind != "sdk" || records[0].Version != "2.0.0" || records[0].SHA256 != hex.EncodeToString(sdkDigest[:]) {
		t.Fatalf("bundled SDK selected by the request must be one sdk record, got %#v", records)
	}
	unselected, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir()}, bundledSDKCatalog())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range unselected.Artifacts {
		if item.Package == "@kb/sdk" && item.Kind != "platform-member" {
			t.Fatalf("bundled SDK without an SDK selector must stay a platform member, got %#v", item)
		}
	}
}

func TestPlanIncludesSDKSelectedByPlatformReleaseWhenRequestOmitsSDK(t *testing.T) {
	sdk := catalog.Component{ID: "sdk", Version: "2.0.0", Package: "@kb/sdk", Tarball: "https://example.test/sdk-2.0.0.tgz", SHA256: "sdk-2.0.0"}
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			SDKRange: "2.0.0",
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		SDKs: []catalog.Component{sdk},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: []catalog.CompatibilityLabel{
			{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []catalog.CompatibilityRelation{{Label: "sdk@2.0.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}},
			{ID: "sdk@2.0.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.0.0", Status: "prepared", ValidatedBy: []string{"stage"}},
		}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir()}, source)
	if err != nil {
		t.Fatal(err)
	}
	var selected []contracts.Artifact
	for _, artifact := range plan.Artifacts {
		if artifact.Package == sdk.Package {
			selected = append(selected, artifact)
		}
	}
	if len(selected) != 1 || selected[0].Kind != "sdk" || selected[0].Version != sdk.Version {
		t.Fatalf("selected SDK artifacts = %#v, want one %s@%s SDK", selected, sdk.Package, sdk.Version)
	}
}

func TestPlanRefusesAnSDKVersionThatDiffersFromTheBundledOne(t *testing.T) {
	_, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: t.TempDir(), SDK: contracts.VersionSelector{Version: "2.1.0"}}, bundledSDKCatalog())
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeIncompatibleComponents ||
		!strings.Contains(failure.Message, "platform 2.0.0 bundles @kb/sdk 2.0.0") {
		t.Fatalf("expected a compatibility refusal naming the bundled SDK, got %v", err)
	}
}

// TestPlanKeepsPlatformMembersThatShareACatalogID verifies that distinct npm
// packages stay distinct even when the release index assigns them the same ID.
func TestPlanKeepsPlatformMembersThatShareACatalogID(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{
		ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
		Members: []catalog.Component{
			{ID: "shared-member", Version: "2.0.0", Package: "@kb-labs/member-a", Tarball: "https://example.test/member-a.tgz", SHA256: "a"},
			{ID: "shared-member", Version: "2.0.0", Package: "@kb-labs/member-b", Tarball: "https://example.test/member-b.tgz", SHA256: "b"},
		},
		Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
	}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	packages := map[string]bool{}
	for _, artifact := range plan.Artifacts {
		if artifact.Kind == "platform-member" {
			packages[artifact.Package] = true
		}
	}
	if !packages["@kb-labs/member-a"] || !packages["@kb-labs/member-b"] {
		t.Fatalf("expected both same-ID members to survive dedup, got artifacts = %#v", plan.Artifacts)
	}
}

// case: PC-001.8, S-181.4, S-023.2
func TestStableFixturePlansHaveUniqueArtifactIdentitiesAcrossProfilesAndScenarios(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "e2e", "platform", "fixtures", "release-index-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	source, err := catalog.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	platform, ok := findPlatform(source.Platforms, source.Channels[contracts.ChannelStable])
	if !ok {
		t.Fatal("stable channel platform is absent")
	}
	for profile := range platform.Profiles {
		for _, scenario := range []string{"commit", "custom"} {
			t.Run(profile+"/"+scenario, func(t *testing.T) {
				plan, err := planWithFixtureProvenance(contracts.InstallRequest{
					PlatformRoot: t.TempDir(), ServiceProfile: profile, ScenarioID: scenario,
					Policy: contracts.PolicyCompatible,
				}, source)
				if err != nil {
					t.Fatal(err)
				}
				if err := contracts.ValidatePlanArtifactIdentities(plan); err != nil {
					t.Fatalf("resolved plan has duplicate artifact identities: %v", err)
				}
				active := contracts.InstallReceipt{Plan: plan}
				summary, err := SummarizeUpdate(active, plan, source)
				if err != nil {
					t.Fatalf("summarize install-to-plan round trip: %v", err)
				}
				if summary.DownloadBytes != 0 || len(summary.AddedPackages) != 0 || len(summary.RemovedPackages) != 0 {
					t.Fatalf("same-plan update summary reports changes: %#v", summary)
				}
			})
		}
	}
}

// case: S-023.6
func TestPlanHashIsStableForPlatformMembersThatShareCatalogIDs(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Members: []catalog.Component{
				{ID: "shared-member", Version: "2.0.0", Package: "@kb-labs/member-a", Tarball: "https://example.test/member-a.tgz", SHA256: "a"},
				{ID: "shared-member", Version: "2.0.0", Package: "@kb-labs/member-b", Tarball: "https://example.test/member-b.tgz", SHA256: "b"},
				{ID: "workflow", Version: "2.0.0", Package: "@kb-labs/workflow-daemon", Tarball: "https://example.test/workflow-daemon.tgz", SHA256: "daemon"},
				{ID: "workflow", Version: "2.0.0", Package: "@kb-labs/workflow-entry", Tarball: "https://example.test/workflow-entry.tgz", SHA256: "entry"},
			},
			Host:     &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"},
			Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		Plugins: []catalog.Component{
			{ID: "workflow", Version: "2.0.0", Package: "@kb-labs/workflow-entry", Tarball: "https://example.test/workflow-entry.tgz", SHA256: "entry"},
		},
	}
	request := contracts.InstallRequest{PlatformRoot: "/tmp/x"}
	first, err := planWithFixtureProvenance(request, source)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 64; attempt++ {
		repeated, planErr := planWithFixtureProvenance(request, source)
		if planErr != nil {
			t.Fatal(planErr)
		}
		if repeated.PlanHash != first.PlanHash {
			t.Fatalf("plan hash changed across identical resolutions: first %s, repeated %s", first.PlanHash, repeated.PlanHash)
		}
	}
}

func TestPlanTargetsReleaseManagedBinaryByLogicalID(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelCanary: "2.0.0-canary.abc123456"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0-canary.abc123456", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}, Binaries: []catalog.Binary{{ID: "kb-dev", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-dev-linux-amd64", Filename: "kb-dev-linux-amd64", SHA256: "binary"}}}}}
	plan, err := planWithFixtureProvenanceOptions(contracts.InstallRequest{PlatformRoot: "/tmp/x", Platform: contracts.VersionSelector{Channel: contracts.ChannelCanary}}, source, Options{OS: "linux", Arch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	for _, artifact := range plan.Artifacts {
		if artifact.Kind == "binary" && artifact.ID == "kb-dev" && artifact.Target != "kb-dev" {
			t.Fatalf("binary target = %q, want logical id kb-dev", artifact.Target)
		}
	}
}

// case: S-284.10
func TestPlanRejectsUnsupportedOperatingSystemWithCataloguedPlatformError(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelCanary: "2.0.0-canary.abc123456"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0-canary.abc123456", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}, Binaries: []catalog.Binary{{ID: "kb-create", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-create-linux-amd64", Filename: "kb-create-linux-amd64", SHA256: "binary"}}}}}
	_, err := planWithFixtureProvenanceOptions(contracts.InstallRequest{PlatformRoot: "/tmp/x", Platform: contracts.VersionSelector{Channel: contracts.ChannelCanary}}, source, Options{OS: "windows", Arch: "amd64"})
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeUnsupportedPlatform {
		t.Fatalf("unsupported platform diagnostic = %#v, %v", failure, err)
	}
	if failure.Message != "windows/amd64 is not a supported platform." || !strings.Contains(failure.Hint, "Linux or macOS") {
		t.Fatalf("unsupported platform message or hint = %q / %q", failure.Message, failure.Hint)
	}
}

func TestPlanCarriesServiceHealthCheckIntoServiceGraph(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "serve", Port: 4000, HealthCheck: "/health"}}}}}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ServiceGraph.Services) != 1 || plan.ServiceGraph.Services[0].HealthCheck != "/health" {
		t.Fatalf("service graph = %#v", plan.ServiceGraph.Services)
	}
}

func TestPlanRejectsConflictingManifestRequirementOwnership(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}, Config: []catalog.ConfigRequirement{{ID: "shared", Path: "/platform/shared"}}}}, Plugins: []catalog.Component{{ID: "plugin", Version: "1", Package: "@kb/plugin", SHA256: "plugin", Config: []catalog.ConfigRequirement{{ID: "shared", Path: "/plugin/shared"}}}}}
	_, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x", Plugins: []contracts.ComponentRequest{{ID: "plugin"}}}, source)
	if value, ok := err.(*diag.Diag); !ok || value.Code != contracts.CodeConfigRequired {
		t.Fatalf("error = %#v", err)
	}
}

// case: S-023.12
func TestMissingRequiredConfigurationUsesCataloguedOperationFailure(t *testing.T) {
	var source catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON("2.0.0", "2.0.0", stdruntime.GOOS, stdruntime.GOARCH), &source); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{
		ID: "gatewayMode", Path: "platform.gateway.mode", Required: true,
	}}
	_, err := planWithFixtureProvenance(contracts.InstallRequest{
		PlatformRoot: t.TempDir(), Platform: contracts.VersionSelector{Version: "2.0.0"},
	}, source)
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodeConfigRequired {
		t.Fatalf("required configuration failure = %#v, want %s diagnostic", err, contracts.CodeConfigRequired)
	}
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("required configuration violated its catalogued detail contract: %v", err)
	}
	if got := diag.ExitCode(failure).Code(); got != 1 {
		t.Fatalf("required configuration exit code = %d, want operation-failure status 1", got)
	}
}

func TestPlanIncludesSDKAndResolvedAdapterArtifacts(t *testing.T) {
	var source catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON("2.0.0", "2.1.0", stdruntime.GOOS, stdruntime.GOARCH), &source); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].SDKRange = "^2.0.0"
	source.Platforms[0].Requires = []catalog.Requirement{{Capability: "logs"}}
	source.Adapters = []catalog.Adapter{{Component: catalog.Component{ID: "pino", Version: "1.0.0", Package: "@kb/pino", SHA256: "pino"}, Provides: []string{"logs"}}}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x", SDK: contracts.VersionSelector{Version: "2.1.0"}}, source)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, item := range plan.Artifacts {
		got[item.Kind+":"+item.ID] = true
	}
	if !got["sdk:sdk"] || !got["adapter:pino"] {
		t.Fatalf("missing selected artifacts: %#v", plan.Artifacts)
	}
}

func TestPlanMarksPlatformMembersThatAreCatalogPluginsOrAdapters(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{
		ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
		Members: []catalog.Component{
			{ID: "workflow", Version: "2.0.0", Package: "@kb/workflow-entry", Tarball: "t", SHA256: "a"},
			{ID: "logger", Version: "2.0.0", Package: "@kb/adapter-logger", Tarball: "t", SHA256: "b"},
			{ID: "gateway", Version: "2.0.0", Package: "@kb/gateway", Tarball: "t", SHA256: "c"},
		},
		Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
	}},
		Plugins:  []catalog.Component{{ID: "workflow", Version: "2.0.0", Package: "@kb/workflow-entry", Tarball: "t", SHA256: "a"}},
		Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "logger", Version: "2.0.0", Package: "@kb/adapter-logger", Tarball: "t", SHA256: "b"}}},
	}
	plan, err := planWithFixtureProvenance(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range plan.Artifacts {
		if a.Kind == "platform-member" {
			got[a.Package] = a.Registry
		}
	}
	if got["@kb/workflow-entry"] != "plugin" || got["@kb/adapter-logger"] != "adapter" || got["@kb/gateway"] != "" {
		t.Fatalf("registry kinds = %v", got)
	}
}

// case: S-222.13
func TestSecretInputIDsMustBelongToSelectedSecretRequirements(t *testing.T) {
	artifacts := []contracts.Artifact{{Config: []contracts.ConfigRequirement{
		{ID: "gateway.jwtSecret", Secret: true},
		{ID: "gateway.access.mode", Secret: false},
	}}}
	if err := ValidateSecretInputIDs(artifacts, []string{"gateway.jwtSecret"}); err != nil {
		t.Fatalf("declared secret requirement was refused: %v", err)
	}
	for _, id := range []string{"gateway.bootstrap.generated", "gateway.bootstrap.disclosed", "unknown.requirement", "gateway.access.mode"} {
		err := ValidateSecretInputIDs(artifacts, []string{id})
		if err == nil || !strings.Contains(err.Error(), id) {
			t.Fatalf("undeclared/non-secret requirement %q was not refused with its safe ID: %v", id, err)
		}
	}
}
