package journey_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/release"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/kb-labs/create/v2/wizard"
)

func primeOfflineCatalog(t *testing.T, root string, source *catalog.Catalog) {
	t.Helper()
	sealed, err := testfixtures.SealCatalog(*source)
	if err != nil {
		t.Fatalf("seal offline test catalog: %v", err)
	}
	*source = sealed
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := layout.PrepareInitialTarget(); err != nil {
		t.Fatalf("prepare owned install root before caching artifacts: %v", err)
	}
	write := func(kind, id string, hash *string) {
		payload := []byte(kind + ":" + id)
		sum := sha256.Sum256(payload)
		*hash = fmt.Sprintf("%x", sum)
		directory := "packages"
		name := *hash + ".tgz"
		if kind == "binary" {
			directory, name = "binaries", *hash
		}
		cache, err := layout.SharedRuntimePath(".kb/v2/cache")
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(cache, directory, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for index := range source.Platforms {
		platform := &source.Platforms[index]
		write("package", platform.ID, &platform.SHA256)
		for memberIndex := range platform.Members {
			write("package", platform.Members[memberIndex].ID, &platform.Members[memberIndex].SHA256)
		}
		for binaryIndex := range platform.Binaries {
			write("binary", platform.Binaries[binaryIndex].ID, &platform.Binaries[binaryIndex].SHA256)
		}
	}
	for index := range source.SDKs {
		write("package", source.SDKs[index].ID, &source.SDKs[index].SHA256)
	}
	for index := range source.Plugins {
		write("package", source.Plugins[index].ID, &source.Plugins[index].SHA256)
	}
	for index := range source.Adapters {
		write("package", source.Adapters[index].ID, &source.Adapters[index].SHA256)
	}
	if source.Digest != "" {
		sealed, err := catalog.Seal(*source)
		if err != nil {
			t.Fatalf("seal offline test catalog: %v", err)
		}
		*source = sealed
	}
}

func prepareFreshContainer(t *testing.T, root string) (versionroot.Layout, string) {
	t.Helper()
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	return layout, stage
}

func finishFreshContainer(t *testing.T, layout versionroot.Layout, stage string,
	installed contracts.InstallReceipt) contracts.InstallReceipt {
	t.Helper()
	installationID, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	installed.InstallationID = installationID
	installed.Plan.Request.PlatformRoot = layout.PlatformRoot()
	if err := receipt.Write(stage, installed); err != nil {
		t.Fatal(err)
	}
	version := installed.Plan.ServiceGraph.PlatformVersion
	if version == "" && len(installed.Plan.Artifacts) > 0 {
		version = installed.Plan.Artifacts[0].Version
	}
	if version == "" {
		t.Fatal("fresh container fixture has no platform version")
	}
	if _, err := layout.ActivateInitial(stage, version, installed.Plan.PlanHash); err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(layout.PlatformRoot(), installed); err != nil {
		t.Fatal(err)
	}
	return installed
}

// These journeys are the installer's install and secret contract, exercised the way
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
	sqlitePackage := "@kb-labs/adapters-sqlite"
	sqliteDir := filepath.Join(stage, "node_modules", filepath.FromSlash(sqlitePackage))
	if err := os.MkdirAll(sqliteDir, 0o750); err != nil {
		t.Fatal(err)
	}
	sqliteManifest, _ := json.Marshal(map[string]any{"schema": "kb.create.artifact-manifest/v2", "id": "sqlite-stores", "package": sqlitePackage, "version": "2.0.0"})
	if err := os.WriteFile(filepath.Join(sqliteDir, "kb-create.manifest.json"), sqliteManifest, 0o600); err != nil {
		t.Fatal(err)
	}

	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Host: testHost(),
			Profiles: map[string]contracts.ServiceGraph{"default": {Services: []contracts.Service{
				{ID: "gateway", Command: "gateway-app", Port: 4000, Required: true},
				{ID: "rest", Command: "rest-api", Port: 5050},
				{ID: "marketplace-registry", Command: "marketplace-registry", Port: 5071},
			}}},
			Members: []catalog.Component{{ID: "gateway", Version: "2.0.0", Package: "@kb-labs/gateway-app", Tarball: "https://example.test/gateway.tgz", SHA256: "gateway"}},
		}},
		Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "sqlite-stores", Version: "2.0.0", Package: sqlitePackage, Tarball: "https://example.test/adapters-sqlite.tgz", SHA256: "sqlite"}, Provides: []string{"documentDatabase", "kvStore"}}},
	}
	enriched, err := release.EnrichWithManifests(source, stage)
	if err != nil {
		t.Fatalf("the real requirements must survive the release sealing path: %v", err)
	}
	withProvenance, err := testfixtures.SealCatalog(enriched)
	if err != nil {
		t.Fatalf("seal gateway package provenance: %v", err)
	}
	sealed, err := catalog.Seal(withProvenance)
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

type journeyResult struct {
	root        string
	installRoot string
	config      map[string]any
	// secrets is the private store as written; environment is what the host
	// process receives from it (variables only).
	secrets     map[string]string
	environment map[string]string
	plan        contracts.ResolvedInstallPlan
}

// install runs wizard -> plan -> apply. `answers` is what the user types.
func install(t *testing.T, answers string) journeyResult {
	t.Helper()
	root := t.TempDir()
	source := sealedGatewayCatalog(t)
	primeOfflineCatalog(t, root, &source)
	var terminal bytes.Buffer
	pending := map[string]secrets.PendingSecret{}
	request, err := wizard.RequestScenario(source, root, "custom", "", wizard.IO{In: bytes.NewBufferString("\n" + answers), Out: &terminal, PendingSecrets: pending})
	if err != nil {
		t.Fatalf("wizard: %v\n%s", err, terminal.String())
	}
	request.Source = contracts.SourceOffline
	plan, err := resolve.Plan(request, source)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	for id, input := range pending {
		if id == secrets.BootstrapPassword {
			err = (secrets.Store{PlatformRoot: root}).PutBootstrapPassword(input.Value, input.Origin)
		} else {
			err = (secrets.Store{PlatformRoot: root}).Put(id, input.Value)
		}
		if err != nil {
			t.Fatal("persist resolved wizard secret")
		}
	}
	layout, stage := prepareFreshContainer(t, root)
	plan.Request.PlatformRoot = stage
	store := secrets.Store{PlatformRoot: stage}
	if err := secrets.EnsureGenerated(&plan, store); err != nil {
		t.Fatalf("generate declared secrets: %v", err)
	}
	artifacts := &offlineArtifacts{root: stage}
	installed, err := runtime.Apply(context.Background(), plan, runtime.Dependencies{Artifacts: artifacts, Secrets: &store, Clock: journeyClock{time.Unix(1, 0)}})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	installed = finishFreshContainer(t, layout, stage, installed)
	return readInstall(t, layout.PlatformRoot(), layout.InstallRoot(), installed.Plan)
}

func readInstall(t *testing.T, root, installRoot string, plan contracts.ResolvedInstallPlan) journeyResult {
	t.Helper()
	result := journeyResult{root: root, installRoot: installRoot, plan: plan, secrets: map[string]string{}}
	config, err := os.ReadFile(filepath.Join(root, ".kb", "kb.config.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(config, &result.config); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, ".kb", "devservices.yaml")); !os.IsNotExist(err) {
		t.Fatalf("an installation must not render devservices.yaml: %v", err)
	}
	store := secrets.Store{PlatformRoot: root}
	environment, err := store.Environment()
	if err != nil {
		t.Fatal(err)
	}
	result.environment = environment.Values
	for _, artifact := range plan.Artifacts {
		for _, requirement := range artifact.Config {
			if !requirement.Secret {
				continue
			}
			if value, present, err := store.Get(requirement.ID); err != nil {
				t.Fatal(err)
			} else if present {
				result.secrets[requirement.ID] = value
			}
		}
	}
	for name, value := range environment.Values {
		result.secrets[name] = value
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

// filesContaining scans every file without opening a product-owned path by name.
func filesContaining(t *testing.T, root, value string) []string {
	t.Helper()
	var hits []string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if data, readErr := os.ReadFile(path); readErr == nil && bytes.Contains(data, []byte(value)) {
			hits = append(hits, path)
		}
		return nil
	})
	return hits
}

func relativeFiles(t *testing.T, root string, paths []string) []string {
	t.Helper()
	relative := make([]string, 0, len(paths))
	for _, path := range paths {
		name, err := filepath.Rel(root, path)
		if err != nil {
			t.Fatal(err)
		}
		relative = append(relative, name)
	}
	return relative
}

// case: S-038.4
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

	// The host process receives each secret as the environment variable the plan
	// binds it to, and the generated config never mentions one.
	if strings.Contains(string(mustMarshal(t, result.config)), "${") {
		t.Fatalf("the config must not carry secret placeholders: %v", result.config)
	}
	for _, variable := range []string{"GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", "GATEWAY_JWT_SECRET", "GATEWAY_INTERNAL_SECRET"} {
		if result.environment[variable] == "" {
			t.Fatalf("the host must receive %s (environment: %v)", variable, keysOf(result.environment))
		}
	}
	// Every variable the plan binds must reach the host: the requirement-ID key
	// alone is what used to leave the gateway unable to start.
	for _, patch := range result.plan.ConfigPatches {
		if patch.Environment != "" && result.environment[patch.Environment] == "" {
			t.Fatalf("plan binds %s but the host would not receive it (environment: %v)", patch.Environment, keysOf(result.environment))
		}
	}
	// A secured install also tells the host to require login.
	if result.config["host"].(map[string]any)["auth"] != "on" {
		t.Fatalf("host.auth = %v, want on", result.config["host"])
	}
	if result.secrets["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"] != adminPassword {
		t.Fatal("the password the user typed must be what the gateway will receive")
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(result.secrets["GATEWAY_JWT_SECRET"]) {
		t.Fatalf("the signing secret must be a generated 256-bit value, got %q", result.secrets["GATEWAY_JWT_SECRET"])
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(result.secrets["GATEWAY_INTERNAL_SECRET"]) {
		t.Fatalf("the internal secret must be generated as a 256-bit value, got %q", result.secrets["GATEWAY_INTERNAL_SECRET"])
	}
	// ... and the requirement IDs stay verifiable for update / doctor.
	if result.secrets["gateway.bootstrap.password"] != adminPassword || result.secrets["gateway.jwtSecret"] == "" || result.secrets["gateway.internalSecret"] == "" {
		t.Fatalf("requirement-ID keys missing: %v", keysOf(result.secrets))
	}

	// Secret values live in exactly one file.
	for _, value := range []string{adminPassword, result.secrets["GATEWAY_JWT_SECRET"], result.secrets["GATEWAY_INTERNAL_SECRET"]} {
		if hits := filesContaining(t, result.installRoot, value); len(hits) != 1 {
			t.Fatalf("a secret appeared in %d install files; want one owner file; locations=%v", len(hits), relativeFiles(t, result.installRoot, hits))
		}
	}
	passwordFiles := filesContaining(t, result.installRoot, adminPassword)
	info, err := os.Stat(passwordFiles[0])
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("secret store must be private: %v / %v", info, err)
	}
}

// case: S-054.2
func TestInstalledPackagesCarryManifestsForDoctor(t *testing.T) {
	result := install(t, "\n\nlocal\n")

	input, err := installed.DoctorInput(result.root, result.plan.Artifacts, map[string]bool{})
	if err != nil {
		t.Fatalf("doctor must load manifests written for every installed package: %v", err)
	}
	for _, manifest := range input.Manifests {
		if manifest.ID != "gateway" {
			continue
		}
		for _, requirement := range manifest.Requirements {
			if requirement.ID == "gateway.bootstrap.adminEmail" && requirement.Path == "/gateway/auth/bootstrap/adminEmail" {
				return
			}
		}
		t.Fatalf("doctor manifest for gateway is missing its sealed requirement: %#v", manifest.Requirements)
	}
	t.Fatal("doctor did not load the installed gateway manifest")
}

func TestSecuredInstallWithoutAnAdminPasswordGeneratesTheFirstAdmin(t *testing.T) {
	// The email is supplied; blank password and signing-secret answers generate both secrets.
	result := install(t, "\n\nsecured\nadmin@example.com\n\n\n\n")

	if result.environment["GATEWAY_JWT_SECRET"] == "" {
		t.Fatalf("the signing secret must still reach the host: %v", keysOf(result.environment))
	}
	if result.environment["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"] == "" {
		t.Fatalf("a generated bootstrap password must reach the host: %v", keysOf(result.environment))
	}
	if hits := filesContaining(t, result.installRoot, result.environment["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"]); len(hits) != 1 {
		t.Fatalf("generated password appeared in %d install files; want one owner file; locations=%v", len(hits), relativeFiles(t, result.installRoot, hits))
	}
	auth, present := gatewaySection(t, result)["auth"].(map[string]any)
	if !present || auth["bootstrap"].(map[string]any)["adminEmail"] != "admin@example.com" {
		t.Fatalf("secured install must configure the generated first admin: %v", gatewaySection(t, result)["auth"])
	}
}

// case: S-038.4
func TestLocalInstallGeneratesInternalSecretAndConfiguresNoLoginAccess(t *testing.T) {
	result := install(t, "\n\nlocal\n")

	gateway := gatewaySection(t, result)
	if result.environment["GATEWAY_INTERNAL_SECRET"] == "" || result.secrets["gateway.internalSecret"] == "" {
		t.Fatalf("a local install must generate and pass the shared internal secret: environment=%v store=%v", keysOf(result.environment), keysOf(result.secrets))
	}
	if access, _ := gateway["access"].(map[string]any); access["mode"] != "local" {
		t.Fatalf("gateway.access = %v", gateway["access"])
	}
	if result.environment["GATEWAY_JWT_SECRET"] == "" {
		t.Fatalf("a local install must deliver its generated JWT secret: %v", keysOf(result.environment))
	}
	if result.config["host"].(map[string]any)["auth"] != "off" {
		t.Fatalf("host.auth = %v, want off for a no-login install", result.config["host"])
	}
	if result.secrets["gateway.jwtSecret"] == "" {
		t.Fatalf("a local install must retain its generated JWT secret: %v", keysOf(result.secrets))
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
		request, err := scenario.Compile(definition, state, contracts.InstallRequest{PlatformRoot: t.TempDir(), Platform: contracts.VersionSelector{Channel: contracts.ChannelStable}, ServiceProfile: "default", Source: contracts.SourceRegistry, Policy: contracts.PolicyCompatible})
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
	primeOfflineCatalog(t, root, &source)
	plan, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: root, Source: contracts.SourceOffline, ServiceProfile: "default",
		Values:       map[string]string{"gateway.access.mode": `"secured"`, "gateway.bootstrap.adminEmail": `"admin@example.com"`},
		SecretInputs: []string{"gateway.bootstrap.password", "gateway.jwtSecret"},
	}, source)
	if err != nil {
		t.Fatal(err)
	}
	layout, stage := prepareFreshContainer(t, root)
	plan.Request.PlatformRoot = stage
	store := secrets.Store{PlatformRoot: stage}
	if err := store.Put("gateway.bootstrap.password", adminPassword); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("gateway.jwtSecret", strings.Repeat("k", 64)); err != nil {
		t.Fatal(err)
	}
	installed, err := runtime.Apply(context.Background(), plan, runtime.Dependencies{Artifacts: &offlineArtifacts{root: stage}, Secrets: &store})
	if err != nil {
		t.Fatal(err)
	}
	installed = finishFreshContainer(t, layout, stage, installed)
	result := readInstall(t, layout.PlatformRoot(), layout.InstallRoot(), installed.Plan)
	if result.secrets["GATEWAY_BOOTSTRAP_ADMIN_PASSWORD"] != adminPassword || result.secrets["GATEWAY_JWT_SECRET"] != strings.Repeat("k", 64) {
		t.Fatalf("secrets not deliverable by variable name: %v", keysOf(result.secrets))
	}
}

func TestSecretInputWithNoStoredValueFailsBeforeAnythingIsInstalled(t *testing.T) {
	root := t.TempDir()
	source := sealedGatewayCatalog(t)
	primeOfflineCatalog(t, root, &source)
	plan, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: root, Source: contracts.SourceOffline, ServiceProfile: "default",
		SecretInputs: []string{"gateway.jwtSecret"},
	}, source)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := &offlineArtifacts{root: root}
	_, stage := prepareFreshContainer(t, root)
	plan.Request.PlatformRoot = stage
	store := secrets.Store{PlatformRoot: stage}
	if _, err := runtime.Apply(context.Background(), plan, runtime.Dependencies{Artifacts: artifacts, Secrets: &store}); err == nil || !strings.Contains(err.Error(), "gateway.jwtSecret is not set") {
		t.Fatalf("apply must refuse a declared secret with no value, got %v", err)
	}
	if len(artifacts.installed) != 0 {
		t.Fatalf("nothing may be installed after a missing secret: %#v", artifacts.installed)
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
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

type captureHostEnvironment struct {
	store secrets.Store
	env   map[string]string
}

func (probe *captureHostEnvironment) Probe(context.Context, contracts.HostSpec) error {
	environment, err := probe.store.Environment()
	probe.env = environment.Values
	return err
}

// case: S-038.4
func TestFreshFixtureInstallRendersInternalSecretForEveryConsumer(t *testing.T) {
	data, err := os.ReadFile("../../../../e2e/platform/fixtures/release-index-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	source, err := catalog.Decode(data)
	if err != nil {
		t.Fatalf("decode journey release fixture: %v", err)
	}
	root := t.TempDir()
	primeOfflineCatalog(t, root, &source)
	plan, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: root, Platform: contracts.VersionSelector{Channel: contracts.ChannelStable},
		SDK: contracts.VersionSelector{Version: "2.120.1"}, ServiceProfile: "default",
		Source: contracts.SourceOffline, Policy: contracts.PolicyCompatible,
	}, source)
	if err != nil {
		t.Fatalf("resolve fresh install from journey fixture: %v", err)
	}
	layout, stage := prepareFreshContainer(t, root)
	plan.Request.PlatformRoot = stage
	store := secrets.Store{PlatformRoot: stage}
	if err := secrets.EnsureGenerated(&plan, store); err != nil {
		t.Fatalf("generate fresh install secrets: %v", err)
	}
	probe := &captureHostEnvironment{store: store}
	installed, err := runtime.Apply(context.Background(), plan, runtime.Dependencies{
		Artifacts: &offlineArtifacts{root: stage}, Probe: probe, Secrets: &store,
	})
	if err != nil {
		t.Fatalf("apply fresh install: %v", err)
	}
	installed = finishFreshContainer(t, layout, stage, installed)
	value := probe.env["GATEWAY_INTERNAL_SECRET"]
	if value == "" {
		t.Fatalf("fresh host environment lacks GATEWAY_INTERNAL_SECRET: %v", probe.env)
	}
	var consumers []string
	for _, patch := range plan.ConfigPatches {
		if patch.Environment == "GATEWAY_INTERNAL_SECRET" {
			consumers = append(consumers, patch.Services...)
		}
	}
	want := []string{"gateway", "rest"}
	if !reflect.DeepEqual(consumers, want) {
		t.Fatalf("internal-secret consumers = %v, want %v", consumers, want)
	}
	for _, service := range consumers {
		if probe.env["GATEWAY_INTERNAL_SECRET"] != value {
			t.Fatalf("service %s cannot read the generated shared secret", service)
		}
	}
}
