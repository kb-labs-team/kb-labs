package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestBuildRejectsDuplicatePorts(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ServiceGraph.Services = append(plan.ServiceGraph.Services, contracts.Service{ID: "duplicate", Command: "serve", Port: 4000})
	if _, err := Build(plan); err == nil {
		t.Fatal("expected duplicate-port validation error")
	}
}

func TestBuildProjectsSecretAsPlaceholderOnly(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = []contracts.ConfigPatch{{Owner: "manifest:token", Environment: "TOKEN", Services: []string{"gateway"}}}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	value := output.Devservices.Services["gateway"].Env["TOKEN"]
	if value != "${TOKEN}" || strings.Contains(string(output.Config), "TOKEN") {
		t.Fatalf("secret projection = %q / %s", value, output.Config)
	}
}

func TestBuildRendersHealthCheckAsAbsoluteLocalhostURL(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ServiceGraph.Services[0].HealthCheck = "/health"
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	if got := output.Devservices.Services["gateway"].HealthCheck; got != "http://localhost:4000/health" {
		t.Fatalf("health check = %q", got)
	}
}

// Regression coverage: kb-dev's config loader derives its Groups map (used to
// resolve `kb-dev start backend`) from each service's own `group` field in
// devservices.yaml — a rendered file with no `group` anywhere silently drops
// every group, including "backend", breaking any caller that starts services
// by group name. gateway is a known "backend" member (mirroring
// .kb/devservices.dev.yaml's hand-authored groups); an unrecognized service
// ID must render with no group at all, not a guessed one.
func TestBuildAssignsConventionalServiceGroups(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ServiceGraph.Services = append(plan.ServiceGraph.Services, contracts.Service{ID: "state-daemon", Command: "serve", Port: 7777})
	plan.ServiceGraph.Services = append(plan.ServiceGraph.Services, contracts.Service{ID: "mcp-daemon", Command: "serve", Port: 7779})
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	if got := output.Devservices.Services["gateway"].Group; got != "backend" {
		t.Fatalf("gateway group = %q, want backend", got)
	}
	if got := output.Devservices.Services["state-daemon"].Group; got != "infra" {
		t.Fatalf("state-daemon group = %q, want infra", got)
	}
	if got := output.Devservices.Services["mcp-daemon"].Group; got != "" {
		t.Fatalf("mcp-daemon group = %q, want unset (no known conventional group yet)", got)
	}
}

// Regression coverage: gateway.upstreams (services/gateway/contracts/src/config.ts's
// UpstreamConfigSchema) defaults to {} when absent from rendered config —
// distinct from platform.adapterOptions.serviceTransport.services, which V2
// already renders and which only supplies per-service RPC URLs, not HTTP
// proxy routing. Without any gateway.upstreams entries, /ready's single
// required check (the "rest" upstream) can never turn "up", so the gateway
// never becomes ready. Only routes whose target service is actually part of
// this install's resolved service graph should render — a route pointing at
// an uninstalled service is not just unnecessary but silently wrong.
func TestBuildRendersGatewayUpstreamsForInstalledServicesOnly(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ServiceGraph.Services = append(plan.ServiceGraph.Services,
		contracts.Service{ID: "rest", Command: "serve", Port: 5050},
		contracts.Service{ID: "workflow", Command: "serve", Port: 7778},
	)
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Gateway struct {
			Upstreams map[string]struct {
				ServiceID string `json:"serviceId"`
				Prefix    string `json:"prefix"`
			} `json:"upstreams"`
		} `json:"gateway"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	rest, ok := config.Gateway.Upstreams["rest"]
	if !ok || rest.ServiceID != "rest" || rest.Prefix != "/api/v1" {
		t.Fatalf("rest upstream = %+v, ok=%v", rest, ok)
	}
	if _, ok := config.Gateway.Upstreams["workflow"]; !ok {
		t.Fatal("expected workflow upstream to render (workflow service is installed)")
	}
	if _, ok := config.Gateway.Upstreams["marketplace"]; ok {
		t.Fatal("marketplace upstream should not render — marketplace service is not part of this plan")
	}
}

// Regression: the platform bundle ships a manifest default for
// /platform/adapters (a JSON patch, only serviceTransport), while the resolver
// separately binds capabilities that plugins require (cache, storage). The
// render used a typed map[string]string for the resolved side, so merging the
// map[string]any default degraded from a deep merge to a replacement and the
// resolved cache/storage bindings vanished from the rendered config.
func TestBuildKeepsResolvedAdapterBindingsAlongsideManifestDefault(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = []contracts.ConfigPatch{
		{Path: "/platform/adapters/cache", Value: "@kb-labs/adapters-state-broker@2.0.0", Owner: "adapter:state-broker"},
		{Path: "/platform/adapters/storage", Value: "@kb-labs/data-store@2.0.0", Owner: "adapter:disk-io-storage"},
		{Path: "/platform/adapters", JSON: `{"serviceTransport":"@kb-labs/adapters-service-transport-http","cache":"@kb-labs/adapters-redis"}`, Owner: "manifest:platform.adapters"},
	}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Platform struct {
			Adapters map[string]string `json:"adapters"`
		} `json:"platform"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	got := config.Platform.Adapters
	if got["serviceTransport"] != "@kb-labs/adapters-service-transport-http" {
		t.Fatalf("manifest default lost: %v", got)
	}
	if got["storage"] != "@kb-labs/data-store@2.0.0" {
		t.Fatalf("resolved storage binding lost: %v", got)
	}
	if got["cache"] != "@kb-labs/adapters-state-broker@2.0.0" {
		t.Fatalf("resolved cache binding must win over a manifest default on the same key, got %q (all: %v)", got["cache"], got)
	}
}

func TestWriteProducesCompleteV2Projections(t *testing.T) {
	root := t.TempDir()
	if _, err := Write(testPlan(root)); err != nil {
		t.Fatal(err)
	}
	for _, relative := range []string{".kb/kb.config.jsonc", ".kb/devservices.yaml"} {
		data, err := os.ReadFile(filepath.Join(root, relative))
		if err != nil || len(data) == 0 {
			t.Fatalf("%s = %q, %v", relative, data, err)
		}
		if _, err := os.Stat(filepath.Join(root, relative+".tmp")); !os.IsNotExist(err) {
			t.Fatalf("temporary projection remains for %s", relative)
		}
	}
}

func TestWriteCreatesProjectPointerWithoutOverwritingUserConfig(t *testing.T) {
	platformRoot, projectRoot := t.TempDir(), t.TempDir()
	plan := testPlan(platformRoot)
	plan.Request.ProjectRoot = projectRoot
	if _, err := Write(plan); err != nil {
		t.Fatal(err)
	}
	pointer := filepath.Join(projectRoot, ".kb", ConfigFilename)
	data, err := os.ReadFile(pointer)
	if err != nil || !strings.Contains(string(data), platformRoot) {
		t.Fatalf("project pointer = %s, error = %v", data, err)
	}
	if err := os.WriteFile(pointer, []byte(`{"platform":{"dir":"user-owned"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(plan); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(pointer)
	if err != nil || !strings.Contains(string(data), "user-owned") {
		t.Fatalf("user config was overwritten: %s / %v", data, err)
	}
}

func testPlan(root string) contracts.ResolvedInstallPlan {
	return contracts.ResolvedInstallPlan{
		Schema:       contracts.ResolvedPlanSchema,
		Request:      contracts.InstallRequest{PlatformRoot: root},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Command: "serve", Port: 4000}}},
	}
}
