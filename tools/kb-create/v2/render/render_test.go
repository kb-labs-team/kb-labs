package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/testworkspace"
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

func TestBuildOwnsLocalDeploymentTopology(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = []contracts.ConfigPatch{{
		Path:  "/platform/deployment/topology",
		JSON:  `"cloud"`,
		Owner: "manifest:platform.deployment.topology",
	}}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Platform struct {
			Deployment struct {
				Topology string `json:"topology"`
			} `json:"deployment"`
		} `json:"platform"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	if config.Platform.Deployment.Topology != "local" {
		t.Fatalf("topology = %q, want local; config: %s", config.Platform.Deployment.Topology, output.Config)
	}
}

func TestBuildPersistsMarketplaceSourceOrderAndSecretReferences(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.Request.MarketplaceSources = &contracts.MarketplaceSources{
		RegistryURL: "https://registry.example.test", SigningPublicKeyEnv: "KB_REGISTRY_PUBLIC_KEY",
		RegistryTokenEnv: "KB_REGISTRY_TOKEN", NpmURL: "https://npm-mirror.example.test",
	}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Marketplace struct {
			Sources []map[string]string `json:"sources"`
		} `json:"marketplace"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Marketplace.Sources) != 2 || config.Marketplace.Sources[0]["kind"] != "registry" || config.Marketplace.Sources[1]["kind"] != "npm" {
		t.Fatalf("marketplace source order = %#v", config.Marketplace.Sources)
	}
	if config.Marketplace.Sources[0]["signingPublicKey"] != "${KB_REGISTRY_PUBLIC_KEY}" || config.Marketplace.Sources[0]["authToken"] != "${KB_REGISTRY_TOKEN}" {
		t.Fatalf("secret references were not kept literal in config: %#v", config.Marketplace.Sources[0])
	}
	if strings.Contains(string(output.Config), "secret-value") {
		t.Fatalf("resolved secret value entered generated config: %s", output.Config)
	}
}

// case: S-268.12
func TestBuildPersistsNpmOnlyMarketplaceMirror(t *testing.T) {
	testworkspace.Require(t)
	plan := testPlan(t.TempDir())
	plan.Request.MarketplaceSources = &contracts.MarketplaceSources{NpmURL: "http://verdaccio:4873"}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Marketplace struct {
			Sources []map[string]string `json:"sources"`
		} `json:"marketplace"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Marketplace.Sources) != 1 || config.Marketplace.Sources[0]["kind"] != "npm" || config.Marketplace.Sources[0]["url"] != "http://verdaccio:4873" {
		t.Fatalf("npm-only mirror config = %#v, want one npm source at Verdaccio", config.Marketplace.Sources)
	}
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate render test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../.."))
	validateRenderedMarketplaceSources(t, root, output.Config)
}

func TestGoRenderedMarketplaceSourcesValidateAgainstCoreConfigSchema(t *testing.T) {
	testworkspace.Require(t)
	plan := testPlan(t.TempDir())
	plan.Request.MarketplaceSources = &contracts.MarketplaceSources{
		RegistryURL: "https://registry.example.test", SigningPublicKeyEnv: "KB_REGISTRY_PUBLIC_KEY",
		RegistryTokenEnv: "KB_REGISTRY_TOKEN", NpmURL: "https://npm-mirror.example.test",
	}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate render test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../.."))
	validateRenderedMarketplaceSources(t, root, output.Config)
}

// case: S-268.9
func TestDefaultInstallRendersReleaseMarketplaceSourcesAndBootsMarketplace(t *testing.T) {
	testworkspace.Require(t)
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate render test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../.."))
	defaultSourcesJSON := releaseMarketplaceSources(t, root)
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = append(plan.ConfigPatches, contracts.ConfigPatch{
		Path: "/marketplace/sources", JSON: string(defaultSourcesJSON), Owner: "release:marketplace.sources",
	})
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Request.MarketplaceSources != nil {
		t.Fatal("default install unexpectedly received Marketplace source flags")
	}
	var config struct {
		Marketplace struct {
			Sources []map[string]string `json:"sources"`
		} `json:"marketplace"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Marketplace.Sources) != 1 || config.Marketplace.Sources[0]["kind"] != "npm" || config.Marketplace.Sources[0]["url"] != "https://registry.npmjs.org" {
		t.Fatalf("default Marketplace sources = %#v; want the release-declared npm source", config.Marketplace.Sources)
	}
	validateRenderedMarketplaceSources(t, root, output.Config)

	platformRoot := plan.Request.PlatformRoot
	configDir := filepath.Join(platformRoot, ".kb")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "kb.config.jsonc"), output.Config, 0o600); err != nil {
		t.Fatal(err)
	}
	bootScript := fmt.Sprintf(`import { setup } from %q;
import { NoOpLogger } from %q;
const stop = await setup({ logger: new NoOpLogger(), port: 0, host: "127.0.0.1", platformRoot: process.argv[1] });
try { /* setup returning a stop function proves the service listened successfully. */ } finally { await stop(); }`,
		"file://"+filepath.ToSlash(filepath.Join(root, "services/marketplace/app/dist/index.js")),
		"file://"+filepath.ToSlash(filepath.Join(root, "core/platform/dist/noop/index.js")))
	bootCommand := exec.Command("node", "--input-type=module", "-e", bootScript, platformRoot)
	bootCommand.Dir = root
	if result, err := bootCommand.CombinedOutput(); err != nil {
		t.Fatalf("Marketplace bootstrap rejected the default rendered config: %v: %s", err, result)
	}
}

func releaseMarketplaceSources(t *testing.T, root string) []byte {
	t.Helper()
	script := fmt.Sprintf(`import { readPlatformReleaseConfig } from %q;
const config = readPlatformReleaseConfig(%q);
process.stdout.write(JSON.stringify(config.marketplaceSources));`,
		"file://"+filepath.ToSlash(filepath.Join(root, "tools/kb-create/scripts/platform-release-config.mjs")),
		filepath.Join(root, "tools/kb-create/config/platform-release.jsonc"))
	command := exec.Command("node", "--input-type=module", "-e", script)
	command.Dir = root
	data, err := command.Output()
	if err != nil {
		t.Fatalf("read release-declared Marketplace sources: %v", err)
	}
	return data
}

func validateRenderedMarketplaceSources(t *testing.T, root string, config []byte) {
	t.Helper()
	schemaPath := filepath.Join(root, "core/config/dist/index.js")
	if _, err := os.Stat(schemaPath); err != nil {
		t.Fatalf("core-config schema build precondition %s: %v; run from workspace root: corepack pnpm --filter @kb-labs/core-config build", schemaPath, err)
	}
	validate := fmt.Sprintf(`import { validateProductConfig } from %q;
let input = '';
for await (const chunk of process.stdin) input += chunk;
const result = validateProductConfig('marketplace', JSON.parse(input).marketplace);
if (!result.ok) { process.stderr.write(JSON.stringify(result.errors)); process.exit(1); }`, "file://"+filepath.ToSlash(schemaPath))
	cmd := exec.Command("node", "--input-type=module", "-e", validate)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(config)
	if result, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Go-rendered Marketplace config failed core-config schema validation: %v: %s", err, result)
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
		"local install has no login":          {[]contracts.ConfigPatch{{Path: "/gateway/access/mode", JSON: `"local"`, Owner: "manifest:gateway.access.mode"}}, "off"},
		"secured install requires login":      {[]contracts.ConfigPatch{{Path: "/gateway/access/mode", JSON: `"secured"`, Owner: "manifest:gateway.access.mode"}}, "on"},
		"no answer is the secured default":    {nil, "on"},
		"host auth follows the selected mode": {[]contracts.ConfigPatch{{Path: "/gateway/access/mode", JSON: `"local"`, Owner: "manifest:a"}, {Path: "/host/auth", JSON: `"on"`, Owner: "manifest:b"}}, "off"},
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

// Static gateway routes belong to the host, which creates routes only for its
// internal modules. REST and workflow are project-runtime services; the host
// starts them lazily behind project routing. Other legacy service packages
// are not started by the host. Package presence cannot create direct routes.
func TestBuildDoesNotRenderLegacyServiceGraphAsGatewayUpstreams(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ServiceGraph.Services = append(plan.ServiceGraph.Services,
		contracts.Service{ID: "rest", Command: "serve", Port: 5050},
		contracts.Service{ID: "workflow", Command: "serve", Port: 7778},
	)
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	if _, ok := config["gateway"]; ok {
		t.Fatalf("renderer emitted static gateway config for host-managed services: %s", output.Config)
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

// case: S-054.1
func TestBuildPreservesResolvedAdapterExportSubpath(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = []contracts.ConfigPatch{
		{Path: "/platform/adapters/kvStore", Value: "@kb-labs/adapters-sqlite@2.0.0", Owner: "adapter:sqlite-stores"},
		{Path: "/platform/adapters", JSON: `{"kvStore":"@kb-labs/adapters-sqlite/kv"}`, Owner: "manifest:platform.adapters"},
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
	if got := config.Platform.Adapters["kvStore"]; got != "@kb-labs/adapters-sqlite/kv" {
		t.Fatalf("rendered kvStore module specifier = %q, want package export subpath", got)
	}
}

// case: S-179.10
func TestBuildNeverRendersTheWorkspaceDevelopmentModeMarker(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.ConfigPatches = []contracts.ConfigPatch{{Path: "/platform/mode", JSON: `"development"`, Owner: "manifest:platform.mode"}}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	platformConfig, _ := config["platform"].(map[string]any)
	if mode, ok := platformConfig["mode"]; ok {
		t.Fatalf("installed platform config must not contain workspace development mode, got %v", mode)
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

func TestWritePreservesSharedConfigLinkAndUpdatesItsInstallRootTarget(t *testing.T) {
	installRoot := t.TempDir()
	versionRoot := filepath.Join(installRoot, "versions", "v1")
	if err := os.MkdirAll(filepath.Join(versionRoot, ".kb"), 0o700); err != nil {
		t.Fatal(err)
	}
	stateRoot := filepath.Join(installRoot, "state")
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	configLink := filepath.Join(versionRoot, ".kb", ConfigFilename)
	configTarget := filepath.Join(stateRoot, ConfigFilename)
	relativeTarget, err := filepath.Rel(filepath.Dir(configLink), configTarget)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(relativeTarget, configLink); err != nil {
		t.Fatal(err)
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema,
		Request:      contracts.InstallRequest{PlatformRoot: versionRoot},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"},
		Host:         &contracts.HostSpec{Command: "host", HealthURL: "http://127.0.0.1:4000/health"}}
	if _, err := Write(plan); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(configLink)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("shared config link was replaced: info=%v err=%v", info, err)
	}
	if _, err := os.Stat(configTarget); err != nil {
		t.Fatalf("shared install-root config was not created: %v", err)
	}
}

func TestWriteNeverCreatesFilesInSelectedProject(t *testing.T) {
	platformRoot, projectRoot := t.TempDir(), t.TempDir()
	plan := testPlan(platformRoot)
	plan.Request.ProjectRoot = projectRoot
	if _, err := Write(plan); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".kb")); !os.IsNotExist(err) {
		t.Fatalf("installer created project files: %v", err)
	}
}

func testPlan(root string) contracts.ResolvedInstallPlan {
	return contracts.ResolvedInstallPlan{
		Schema:       contracts.ResolvedPlanSchema,
		Request:      contracts.InstallRequest{PlatformRoot: root},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Command: "serve", Port: 4000}}},
	}
}

// case: S-285.14
func TestBuildUsesRegistryForDefaultMarketplaceNpmSource(t *testing.T) {
	plan := testPlan(t.TempDir())
	plan.Registry = "http://127.0.0.1:4873"
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate release configuration")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../.."))
	var index catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON("2.0.0", "2.0.0", runtime.GOOS, runtime.GOARCH), &index); err != nil {
		t.Fatal(err)
	}
	index.Platforms[0].Config = append(index.Platforms[0].Config, catalog.ConfigRequirement{ID: "marketplace.sources", Path: "/marketplace/sources", Default: string(releaseMarketplaceSources(t, root))})
	index = testfixtures.MustSealCatalog(index)
	if _, err := catalog.VerifyCatalog(index); err != nil {
		t.Fatal(err)
	}
	for _, item := range index.Platforms[0].Config {
		if item.Path == "/marketplace/sources" {
			plan.ConfigPatches = append(plan.ConfigPatches, contracts.ConfigPatch{Path: item.Path, JSON: item.Default})
		}
	}
	if len(plan.ConfigPatches) == 0 {
		t.Fatal("fixture index does not declare Marketplace sources")
	}
	output, err := Build(plan)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Marketplace struct {
			Sources []struct {
				Kind string `json:"kind"`
				URL  string `json:"url"`
			} `json:"sources"`
		} `json:"marketplace"`
	}
	if err := json.Unmarshal(output.Config, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Marketplace.Sources) != 1 || config.Marketplace.Sources[0].URL != plan.Registry {
		t.Fatalf("Marketplace sources = %+v, want registry %s", config.Marketplace.Sources, plan.Registry)
	}
}
