package resolve

import (
	"fmt"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"strings"
	"testing"
)

func TestAmbiguousProviderFailsFast(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{Version: "2.0.0", Profiles: map[string]contracts.ServiceGraph{"default": {}}, Requires: []catalog.Requirement{{Capability: "logs"}}}}, Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "a", Version: "1"}, Provides: []string{"logs"}}, {Component: catalog.Component{ID: "b", Version: "1"}, Provides: []string{"logs"}}}}
	_, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err == nil {
		t.Fatal("expected error")
	}
	if value, ok := err.(*contracts.LauncherError); !ok || value.Code != contracts.CodeProviderAmbiguous {
		t.Fatalf("%T %#v", err, err)
	}
}

func TestPlanProjectsSecretOnlyAsEnvironmentReference(t *testing.T) {
	source := catalog.Catalog{Digest: "release-digest", Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "serve"}}}}, Config: []catalog.ConfigRequirement{{ID: "openai.apiKey", Secret: true, Required: true, Env: "OPENAI_API_KEY", Services: []string{"gateway"}}}}}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x", SecretInputs: []string{"openai.apiKey"}}, source)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ReleaseDigest != "release-digest" {
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

func TestPlanPreservesScenarioProvenance(t *testing.T) {
	source := catalog.Catalog{Digest: "release", Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {}}}}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x", ScenarioID: "custom", ScenarioStateDigest: "state"}, source)
	if err != nil || plan.ReleaseDigest != "release" || plan.ScenarioStateDigest != "state" {
		t.Fatalf("plan/error = %#v / %v", plan, err)
	}
}

func TestPlanInstallsPlatformMembersAtomically(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Members: []catalog.Component{{ID: "gateway", Version: "2.0.0", Package: "@kb/gateway", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	member := false
	for _, artifact := range plan.Artifacts {
		member = member || artifact.Kind == "platform-member" && artifact.ID == "gateway"
	}
	if err != nil || len(plan.Artifacts) != 2 || !member {
		t.Fatalf("plan/error = %#v / %v", plan, err)
	}
}

// TestPlanKeepsPlatformMembersThatShareACatalogID guards against a real
// regression found in the v2.119.0-binaries release: prepare-release-index.mjs
// derives a member's catalog ID either from its declared service id (e.g.
// @kb-labs/marketplace-app -> "marketplace") or, for non-service packages,
// from its npm package name with a trailing "-entry" stripped (e.g.
// @kb-labs/marketplace-entry -> "marketplace"). Two unrelated packages can
// therefore legitimately share one catalog ID. uniqueArtifacts used to key
// solely on Kind+ID+Version, so the second package silently vanished from
// the resolved plan and its service never got installed — reproduced locally
// against the real published release-index.json, where @kb-labs/marketplace-app
// and @kb-labs/workflow-daemon were dropped in favor of @kb-labs/marketplace-entry
// and @kb-labs/workflow-entry.
func TestPlanKeepsPlatformMembersThatShareACatalogID(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{
		ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
		Members: []catalog.Component{
			{ID: "marketplace", Version: "2.0.0", Package: "@kb-labs/marketplace-app", Tarball: "https://example.test/marketplace-app.tgz", SHA256: "app"},
			{ID: "marketplace", Version: "2.0.0", Package: "@kb-labs/marketplace-entry", Tarball: "https://example.test/marketplace-entry.tgz", SHA256: "entry"},
		},
		Profiles: map[string]contracts.ServiceGraph{"default": {}},
	}}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	packages := map[string]bool{}
	for _, artifact := range plan.Artifacts {
		if artifact.Kind == "platform-member" {
			packages[artifact.Package] = true
		}
	}
	if !packages["@kb-labs/marketplace-app"] || !packages["@kb-labs/marketplace-entry"] {
		t.Fatalf("expected both same-ID members to survive dedup, got artifacts = %#v", plan.Artifacts)
	}
}

func TestPlanTargetsReleaseManagedBinaryByLogicalID(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelCanary: "2.0.0-canary.abc123456"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0-canary.abc123456", Package: "@kb/platform", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {}}, Binaries: []catalog.Binary{{ID: "kb-dev", OS: "linux", Arch: "amd64", URL: "https://example.test/kb-dev-linux-amd64", Filename: "kb-dev-linux-amd64", SHA256: "binary"}}}}}
	plan, err := PlanWith(contracts.InstallRequest{PlatformRoot: "/tmp/x", Platform: contracts.VersionSelector{Channel: contracts.ChannelCanary}}, source, Options{OS: "linux", Arch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	for _, artifact := range plan.Artifacts {
		if artifact.Kind == "binary" && artifact.ID == "kb-dev" && artifact.Target != "kb-dev" {
			t.Fatalf("binary target = %q, want logical id kb-dev", artifact.Target)
		}
	}
}

func TestPlanCarriesServiceHealthCheckIntoServiceGraph(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "serve", Port: 4000, HealthCheck: "/health"}}}}}}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.ServiceGraph.Services) != 1 || plan.ServiceGraph.Services[0].HealthCheck != "/health" {
		t.Fatalf("service graph = %#v", plan.ServiceGraph.Services)
	}
}

func TestPlanRejectsConflictingManifestRequirementOwnership(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {}}, Config: []catalog.ConfigRequirement{{ID: "shared", Path: "/platform/shared"}}}}, Plugins: []catalog.Component{{ID: "plugin", Version: "1", Package: "@kb/plugin", SHA256: "plugin", Config: []catalog.ConfigRequirement{{ID: "shared", Path: "/plugin/shared"}}}}}
	_, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x", Plugins: []contracts.ComponentRequest{{ID: "plugin"}}}, source)
	if value, ok := err.(*contracts.LauncherError); !ok || value.Code != contracts.CodeConfigRequired {
		t.Fatalf("error = %#v", err)
	}
}

func TestPlanIncludesSDKAndResolvedAdapterArtifacts(t *testing.T) {
	source := catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: []catalog.CompatibilityLabel{{ID: "platform@2.0.0", Kind: "platform", ArtifactID: "platform", Version: "2.0.0", Requires: []catalog.CompatibilityRelation{{Label: "sdk@2.1.0"}}, Status: "prepared", ValidatedBy: []string{"stage"}}, {ID: "sdk@2.1.0", Kind: "sdk", ArtifactID: "sdk", Version: "2.1.0", Status: "prepared", ValidatedBy: []string{"stage"}}}}, Platforms: []catalog.PlatformBundle{{Version: "2.0.0", SDKRange: "^2.0.0", Profiles: map[string]contracts.ServiceGraph{"default": {}}, Requires: []catalog.Requirement{{Capability: "logs"}}}}, SDKs: []catalog.Component{{ID: "sdk", Version: "2.1.0", Package: "@kb/sdk", SHA256: "sdk"}}, Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "pino", Version: "1.0.0", Package: "@kb/pino", SHA256: "pino"}, Provides: []string{"logs"}}}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x", SDK: contracts.VersionSelector{Version: "2.1.0"}}, source)
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
		Profiles: map[string]contracts.ServiceGraph{"default": {}},
	}},
		Plugins:  []catalog.Component{{ID: "workflow", Version: "2.0.0", Package: "@kb/workflow-entry", Tarball: "t", SHA256: "a"}},
		Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "logger", Version: "2.0.0", Package: "@kb/adapter-logger", Tarball: "t", SHA256: "b"}}},
	}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, source)
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
