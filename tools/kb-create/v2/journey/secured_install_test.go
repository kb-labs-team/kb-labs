package journey_test

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/release"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/wizard"
)

// These journeys are the installer's "Studio access" contract, exercised the way
// a user reaches it: the wizard (or a machine request) -> resolver -> runtime
// apply -> files on disk. The gateway's requirements are NOT restated here: the
// real services/gateway/app/kb-create.requirements.json is staged exactly as
// the release tooling stages it and sealed through the real release package, so
// a drifted id, path or env name in that file breaks these tests.

const (
	gatewayRequirementsFile = "../../../../services/gateway/app/kb-create.requirements.json"
	adminPassword           = "Live-Admin-Pass-42"
)

// sealedGatewayCatalog builds a release index whose gateway member carries the
// real declared requirements.
func sealedGatewayCatalog(t *testing.T) catalog.Catalog {
	t.Helper()
	data, err := os.ReadFile(gatewayRequirementsFile)
	if err != nil {
		t.Fatalf("the gateway must ship its requirements file: %v", err)
	}
	var declared struct {
		Schema       string            `json:"schema"`
		Requirements []json.RawMessage `json:"requirements"`
	}
	if err := json.Unmarshal(data, &declared); err != nil || declared.Schema != "kb.create.requirements/v1" {
		t.Fatalf("requirements file: schema %q, err %v", declared.Schema, err)
	}
	// What prepare-release-index writes into the staged package.
	stage := t.TempDir()
	packageDir := filepath.Join(stage, "node_modules", "@kb-labs", "gateway-app")
	if err := os.MkdirAll(packageDir, 0o750); err != nil {
		t.Fatal(err)
	}
	manifest, _ := json.Marshal(map[string]any{
		"schema": "kb.create.artifact-manifest/v2", "id": "gateway", "package": "@kb-labs/gateway-app", "version": "2.0.0",
		"requirements": declared.Requirements,
	})
	if err := os.WriteFile(filepath.Join(packageDir, "kb-create.manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	platformDir := filepath.Join(stage, "node_modules", "@kb", "platform")
	if err := os.MkdirAll(platformDir, 0o750); err != nil {
		t.Fatal(err)
	}
	platformManifest, _ := json.Marshal(map[string]any{"schema": "kb.create.artifact-manifest/v2", "id": "platform", "package": "@kb/platform", "version": "2.0.0"})
	if err := os.WriteFile(filepath.Join(platformDir, "kb-create.manifest.json"), platformManifest, 0o600); err != nil {
		t.Fatal(err)
	}

	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{{ID: "gateway", Command: "gateway-app", Port: 4000, Required: true}}}},
			Members:  []catalog.Component{{ID: "gateway", Version: "2.0.0", Package: "@kb-labs/gateway-app", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}},
		}},
	}
	enriched, err := release.EnrichWithManifests(source, stage)
	if err != nil {
		t.Fatalf("the real requirements must survive the release sealing path: %v", err)
	}
	sealed, err := catalog.Seal(enriched)
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

type journeyResult struct {
	root    string
	config  map[string]any
	devsvcs string
	secrets map[string]string
	plan    contracts.ResolvedInstallPlan
}

// install runs wizard -> plan -> apply. `answers` is what the user types.
func install(t *testing.T, answers string) journeyResult {
	t.Helper()
	root := t.TempDir()
	source := sealedGatewayCatalog(t)
	var terminal bytes.Buffer
	request, err := wizard.RequestScenario(source, root, "custom", wizard.IO{In: bytes.NewBufferString(answers), Out: &terminal})
	if err != nil {
		t.Fatalf("wizard: %v\n%s", err, terminal.String())
	}
	request.Source = contracts.SourceOffline
	plan, err := resolve.Plan(request, source)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	store := secrets.Store{PlatformRoot: root}
	artifacts := &offlineArtifacts{}
	services := &lifecycleServices{status: status{{ID: "gateway", State: "alive"}}}
	if _, err := runtime.Apply(plan, runtime.Dependencies{Artifacts: artifacts, Status: services, Activator: services, Secrets: &store, Clock: journeyClock{time.Unix(1, 0)}}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	return readInstall(t, root, plan)
}

func readInstall(t *testing.T, root string, plan contracts.ResolvedInstallPlan) journeyResult {
	t.Helper()
	result := journeyResult{root: root, plan: plan, secrets: map[string]string{}}
	config, err := os.ReadFile(filepath.Join(root, ".kb", "kb.config.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(config, &result.config); err != nil {
		t.Fatal(err)
	}
	devsvcs, err := os.ReadFile(filepath.Join(root, ".kb", "devservices.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	result.devsvcs = string(devsvcs)
	if data, err := os.ReadFile(filepath.Join(root, ".kb", "v2", "secrets.env")); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if key, value, ok := strings.Cut(line, "="); ok {
				result.secrets[key] = value
			}
		}
	}
	return result
}

func gatewaySection(t *testing.T, result journeyResult) map[string]any {
	t.Helper()
	gateway, ok := result.config["gateway"].(map[string]any)
	if !ok {
		t.Fatalf("no gateway section in %v", result.config)
	}
	return gateway
}

// everywhereExcept returns the files under root that contain value, other than
// the private secret store.
func everywhereExcept(t *testing.T, root, value string) []string {
	t.Helper()
	var hits []string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.HasSuffix(path, filepath.Join(".kb", "v2", "secrets.env")) {
			return nil
		}
		if data, readErr := os.ReadFile(path); readErr == nil && bytes.Contains(data, []byte(value)) {
			hits = append(hits, path)
		}
		return nil
	})
	return hits
}

func TestSecuredWizardInstallDeliversTheGatewayItsAdminAndSecrets(t *testing.T) {
	// channel, profile, Studio access, admin email, password + confirmation, blank => generated signing secret
	result := install(t, "\n\nsecured\nadmin@example.com\n\n"+adminPassword+"\n"+adminPassword+"\n\n")

	gateway := gatewaySection(t, result)
	if access, _ := gateway["access"].(map[string]any); access["mode"] != "secured" {
		t.Fatalf("gateway.access = %v", gateway["access"])
	}
	bootstrap := gateway["auth"].(map[string]any)["bootstrap"].(map[string]any)
	if bootstrap["adminEmail"] != "admin@example.com" {
		t.Fatalf("gateway.auth.bootstrap = %v", bootstrap)
	}
	// No tenant answered: none may be written. Config beats GATEWAY_BOOTSTRAP_TENANT_ID,
	// so a default here would put the admin in the wrong tenant for every env-configured
	// deployment (found by the docker auth e2e).
	if _, present := bootstrap["tenantId"]; present {
		t.Fatalf("an unanswered tenant must not be written: %v", bootstrap)
	}

	// The service env references the secrets by variable name only.
	for _, variable := range []string{"GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", "GATEWAY_JWT_SECRET"} {
		if !strings.Contains(result.devsvcs, variable+": ${"+variable+"}") {
			t.Fatalf("service env must reference ${%s}:\n%s", variable, result.devsvcs)
		}
	}

	// kb-dev resolves ${VAR} by NAME against the private store. Every variable the
	// generated env references must therefore exist there, with the right value:
	// the requirement-ID key alone is what used to leave the gateway unable to start.
	for _, reference := range regexp.MustCompile(`\$\{([A-Z0-9_]+)\}`).FindAllStringSubmatch(result.devsvcs, -1) {
		if result.secrets[reference[1]] == "" {
			t.Fatalf("${%s} is referenced by the service env but not resolvable from the secret store (keys: %v)", reference[1], keysOf(result.secrets))
		}
	}
	if result.secrets["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"] != adminPassword {
		t.Fatal("the password the user typed must be what the gateway will receive")
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(result.secrets["GATEWAY_JWT_SECRET"]) {
		t.Fatalf("the signing secret must be a generated 256-bit value, got %q", result.secrets["GATEWAY_JWT_SECRET"])
	}
	// ... and the requirement IDs stay verifiable for update / doctor.
	if result.secrets["gateway.bootstrap.password"] != adminPassword || result.secrets["gateway.jwtSecret"] == "" {
		t.Fatalf("requirement-ID keys missing: %v", keysOf(result.secrets))
	}

	// Secret values live in exactly one file.
	for _, value := range []string{adminPassword, result.secrets["GATEWAY_JWT_SECRET"]} {
		if hits := everywhereExcept(t, result.root, value); len(hits) != 0 {
			t.Fatalf("a secret leaked outside the private store: %v", hits)
		}
	}
	info, err := os.Stat(filepath.Join(result.root, ".kb", "v2", "secrets.env"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("secret store must be private: %v / %v", info, err)
	}
}

func TestSecuredInstallWithoutAnAdminPasswordStillSecuresSessions(t *testing.T) {
	// email and password skipped; the signing secret is still generated.
	result := install(t, "\n\nsecured\n\n\n\n\n")

	if !strings.Contains(result.devsvcs, "GATEWAY_JWT_SECRET: ${GATEWAY_JWT_SECRET}") {
		t.Fatalf("the signing secret must still reach the gateway:\n%s", result.devsvcs)
	}
	if strings.Contains(result.devsvcs, "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD") {
		t.Fatalf("no admin password was given, none may be wired:\n%s", result.devsvcs)
	}
	// Nothing answered, nothing defaulted: the gateway config carries no auth block at all.
	if auth, present := gatewaySection(t, result)["auth"]; present {
		t.Fatalf("a secured install with no admin identity must not write gateway.auth: %v", auth)
	}
}

func TestLocalInstallNeedsNoSecretsAndConfiguresNoLoginAccess(t *testing.T) {
	result := install(t, "\n\nlocal\n")

	gateway := gatewaySection(t, result)
	if access, _ := gateway["access"].(map[string]any); access["mode"] != "local" {
		t.Fatalf("gateway.access = %v", gateway["access"])
	}
	if strings.Contains(result.devsvcs, "${") {
		t.Fatalf("a local install references no secrets:\n%s", result.devsvcs)
	}
	if len(result.secrets) != 0 {
		t.Fatalf("a local install stores no secrets: %v", keysOf(result.secrets))
	}
	// auth.bootstrap.tenantId is written by default; it must not switch login back on.
	if auth, _ := gateway["auth"].(map[string]any); auth != nil {
		if _, explicit := auth["enabled"]; explicit {
			t.Fatalf("the installer must not write auth.enabled (it would override access.mode): %v", auth)
		}
	}
}

// The regression this whole change exists for: against a real index the default
// scenario used to fail with KB_INSTALL_CONFIG_REQUIRED ("gateway.access.mode is
// not declared by selected manifests").
func TestDefaultScenarioPlansAgainstTheRealGatewayRequirements(t *testing.T) {
	source := sealedGatewayCatalog(t)
	for _, id := range []string{"custom"} {
		definition, err := scenario.Load(id)
		if err != nil {
			t.Fatal(err)
		}
		state, err := scenario.New(definition)
		if err != nil {
			t.Fatal(err)
		}
		request, err := scenario.Compile(definition, state, contracts.InstallRequest{PlatformRoot: t.TempDir(), Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, ServiceProfile: "default", Source: contracts.SourceOffline, Policy: contracts.PolicyCompatible})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := resolve.Plan(request, source); err != nil {
			t.Fatalf("scenario %q with defaults must plan against the real requirements: %v", id, err)
		}
	}
}

// Non-interactive: values arrive as a request plus secrets already in the store
// (what --secret-env does). Same delivery guarantees as the wizard.
func TestMachineRequestSecuredInstallDeliversSecretsThroughTheSameStore(t *testing.T) {
	root := t.TempDir()
	source := sealedGatewayCatalog(t)
	store := secrets.Store{PlatformRoot: root}
	if err := store.Put("gateway.bootstrap.password", adminPassword); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("gateway.jwtSecret", strings.Repeat("k", 64)); err != nil {
		t.Fatal(err)
	}
	plan, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: root, Source: contracts.SourceOffline, ServiceProfile: "default",
		Values:       map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.com"`},
		SecretInputs: []string{"gateway.bootstrap.password", "gateway.jwtSecret"},
	}, source)
	if err != nil {
		t.Fatal(err)
	}
	services := &lifecycleServices{status: status{{ID: "gateway", State: "alive"}}}
	if _, err := runtime.Apply(plan, runtime.Dependencies{Artifacts: &offlineArtifacts{}, Status: services, Activator: services, Secrets: &store}); err != nil {
		t.Fatal(err)
	}
	result := readInstall(t, root, plan)
	if result.secrets["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"] != adminPassword || result.secrets["GATEWAY_JWT_SECRET"] != strings.Repeat("k", 64) {
		t.Fatalf("secrets not deliverable by variable name: %v", keysOf(result.secrets))
	}
}

func TestSecretInputWithNoStoredValueFailsBeforeAnythingIsInstalled(t *testing.T) {
	root := t.TempDir()
	source := sealedGatewayCatalog(t)
	plan, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: root, Source: contracts.SourceOffline, ServiceProfile: "default",
		SecretInputs: []string{"gateway.jwtSecret"},
	}, source)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := &offlineArtifacts{}
	services := &lifecycleServices{status: status{{ID: "gateway", State: "alive"}}}
	store := secrets.Store{PlatformRoot: root}
	if _, err := runtime.Apply(plan, runtime.Dependencies{Artifacts: artifacts, Status: services, Activator: services, Secrets: &store}); err == nil || !strings.Contains(err.Error(), "gateway.jwtSecret is not set") {
		t.Fatalf("apply must refuse a declared secret with no value, got %v", err)
	}
	if len(artifacts.installed) != 0 {
		t.Fatalf("nothing may be installed after a missing secret: %#v", artifacts.installed)
	}
}

func keysOf(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func TestSecuredInstallWritesTheTenantOnlyWhenTheUserChoseOne(t *testing.T) {
	result := install(t, "\n\nsecured\nadmin@example.com\nacme\n"+adminPassword+"\n"+adminPassword+"\n\n")

	bootstrap := gatewaySection(t, result)["auth"].(map[string]any)["bootstrap"].(map[string]any)
	if bootstrap["tenantId"] != "acme" || bootstrap["adminEmail"] != "admin@example.com" {
		t.Fatalf("gateway.auth.bootstrap = %v", bootstrap)
	}
}
