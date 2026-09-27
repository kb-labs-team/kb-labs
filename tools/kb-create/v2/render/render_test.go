package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestBuildKeepsSecretValuesOutOfConfigAndChecksTheirServices(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = []contracts.ConfigPatch{{Owner: "manifest:token", Environment: "TOKEN", Services: []string{"gateway"}}}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output.Config), "TOKEN") {
		t.Fatalf("the config must not mention a secret variable: %s", output.Config)
	}
	plan.ConfigPatches[0].Services = []string{"missing"}
	if _, err := Build(plan); err == nil {
		t.Fatal("a secret bound to a service that is not in the plan must be rejected")
	}
}

func hostSection(t *testing.T, config []byte) map[string]any {
	t.Helper()
	var parsed struct {
		Host map[string]any `json:"host"`
	}
	if err := json.Unmarshal(config, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed.Host
}

// The host's policy overrides gateway access with host.auth, so the installer
// must write the value that matches the selected access mode: a "local" install
// is no-login (off); everything else, including no answer, is the gateway's
// secured default (on).
func TestBuildDerivesHostAuthFromTheAccessMode(t *testing.T) {
	cases := map[string]struct {
		patches []contracts.ConfigPatch
		want    string
	}{
		"local install has no login":       {[]contracts.ConfigPatch{{Path: "/gateway/access/mode", JSON: `"local"`, Owner: "manifest:gateway.access.mode"}}, "off"},
		"secured install requires login":   {[]contracts.ConfigPatch{{Path: "/gateway/access/mode", JSON: `"secured"`, Owner: "manifest:gateway.access.mode"}}, "on"},
		"no answer is the secured default": {nil, "on"},
		"an explicit host.auth is kept":    {[]contracts.ConfigPatch{{Path: "/gateway/access/mode", JSON: `"local"`, Owner: "manifest:a"}, {Path: "/host/auth", JSON: `"on"`, Owner: "manifest:b"}}, "on"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			plan := testPlan(t.TempDir())
			plan.ConfigPatches = testCase.patches
			output, err := Build(plan)
			if err != nil {
				t.Fatal(err)
			}
			if got := hostSection(t, output.Config)["auth"]; got != testCase.want {
				t.Fatalf("host.auth = %v, want %s\n%s", got, testCase.want, output.Config)
			}
		})
	}
}

// Regression coverage: gateway.upstreams (services/gateway/contracts/src/config.ts's
// UpstreamConfigSchema) defaults to {} when absent from rendered config —
// distinct from platform.adapterOptions.serviceTransport.services, which V2
// never renders at all (the host/project runtime generate it in-process from
// their actual bound ports, ADR-0043 B8) and which only supplies per-service
// RPC URLs, not HTTP proxy routing. Without any gateway.upstreams entries, /ready's single
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

// Resolved bindings carry exact "pkg@version" specs (plan/receipt
// reproducibility) but the runtime adapter loader resolves the configured
// value as a module name from node_modules; a version suffix made every
// service fail at boot with "Failed to load adapter module pkg@version".
//
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
	if got["storage"] != "@kb-labs/data-store" {
		t.Fatalf("resolved storage binding lost or not a bare module name: %v", got)
	}
	if got["cache"] != "@kb-labs/adapters-state-broker" {
		t.Fatalf("resolved cache binding must win over a manifest default on the same key, got %q (all: %v)", got["cache"], got)
	}
}

func TestWriteProducesTheRuntimeConfigAndNoServiceManagerFile(t *testing.T) {
	root := t.TempDir()
	if _, err := Write(testPlan(root)); err != nil {
		t.Fatal(err)
	}
	relative := ".kb/kb.config.jsonc"
	data, err := os.ReadFile(filepath.Join(root, relative))
	if err != nil || len(data) == 0 {
		t.Fatalf("%s = %q, %v", relative, data, err)
	}
	if _, err := os.Stat(filepath.Join(root, relative+".tmp")); !os.IsNotExist(err) {
		t.Fatalf("temporary projection remains for %s", relative)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "devservices.yaml")); !os.IsNotExist(err) {
		t.Fatalf("the user path must not render devservices.yaml: %v", err)
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
