package v2cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/render"
	"github.com/kb-labs/create/v2/secrets"
)

func testCompatibility(version string) *catalog.CompatibilityMatrix {
	return &catalog.CompatibilityMatrix{
		Schema: catalog.CompatibilitySchema,
		Labels: []catalog.CompatibilityLabel{{
			ID: "platform@" + version, Kind: "platform", ArtifactID: "platform", Version: version,
			Status: "prepared", ValidatedBy: []string{"test"},
		}},
	}
}

func TestRunEmitsOnlyStructuredPlan(t *testing.T) {
	dir := t.TempDir()
	index := filepath.Join(dir, "index.json")
	input := filepath.Join(dir, "request.json")
	output := filepath.Join(dir, "output.json")
	release, err := catalog.Seal(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Compatibility: testCompatibility("2.0.0"), Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "abc", Profiles: map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	releaseJSON, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, releaseJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, []byte(`{"schema":"kb.create/v2","platformRoot":"/tmp/platform","source":"offline"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(output)
	if err != nil {
		t.Fatal(err)
	}
	code := run("plan", index, input, "", "", "", "", "kb-dev", "", false, "", "", false, directRequest{}, file)
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil || decoded["ok"] != true {
		t.Fatalf("output = %s, error = %v", data, err)
	}
	plan, ok := decoded["plan"].(map[string]any)
	if !ok || plan["schema"] != "kb.create.resolved-plan/v2" {
		t.Fatalf("plan contract = %#v", decoded["plan"])
	}
}

func TestPopulateSecretsReadsEnvironmentWithoutSerialization(t *testing.T) {
	t.Setenv("KB_CREATE_TEST_SECRET", "private-value")
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	if err := populateSecrets(store, "openai.key=KB_CREATE_TEST_SECRET"); err != nil {
		t.Fatal(err)
	}
	exists, err := store.Exists("openai.key")
	if err != nil || !exists {
		t.Fatalf("exists/error = %v / %v", exists, err)
	}
}

func TestParseComponentsSupportsScopedIDsAndPins(t *testing.T) {
	components, err := parseComponents("@kb-labs/review@1.2.3,commit")
	if err != nil || len(components) != 2 || components[0].ID != "@kb-labs/review" || components[0].Version.Version != "1.2.3" || components[1].ID != "commit" {
		t.Fatalf("components/error = %#v / %v", components, err)
	}
}

func TestRunRequiresBothMachineInputs(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if code := run("plan", "", "", "", "", "", "", "kb-dev", "", false, "", "", false, directRequest{}, file); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
}

func TestRunRejectsUnknownOperation(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if code := run("destroy-everything", "", "", "", "", "", "", "kb-dev", "", false, "", "", false, directRequest{}, file); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
}

func TestRecoveryRequiresPlatformRoot(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if code := run("uninstall", "", "", "", "", "", "", "kb-dev", "", false, "", "", false, directRequest{}, file); code != 2 {
		t.Fatalf("exit code = %d", code)
	}
}

func TestDoctorReturnsStructuredManifestFindings(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "doctor.json")
	output := filepath.Join(dir, "output.json")
	if err := os.WriteFile(input, []byte(`{"manifests":[{"id":"plugin","requirements":[{"id":"plugin.token","path":"/plugin/token","secret":true,"required":true,"hint":"set token"}]}],"configured":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(output)
	if err != nil {
		t.Fatal(err)
	}
	if code := run("doctor", "", "", input, "", "", "", "kb-dev", "", false, "", "", false, directRequest{}, file); code != 1 {
		t.Fatalf("exit code = %d", code)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(data, &response); err != nil || response["ok"] != false {
		t.Fatalf("output/error = %s / %v", data, err)
	}
}

func TestDirectRequestUsesSamePlanTransport(t *testing.T) {
	dir := t.TempDir()
	index := filepath.Join(dir, "index.json")
	release, err := catalog.Seal(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Compatibility: testCompatibility("2.0.0"), Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {}}}}, Plugins: []catalog.Component{{ID: "review", Version: "1.2.0", Package: "@kb/review", Tarball: "https://example.test/review.tgz", SHA256: "review"}}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, data, 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(dir, "output.json"))
	if err != nil {
		t.Fatal(err)
	}
	if code := run("plan", index, "", "", "", "", "", "kb-dev", "", false, "", "", false, directRequest{PlatformRoot: "/tmp/platform", Plugins: "review@1.2.0", Offline: true, Policy: "strict"}, output); code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestScenarioAnswersCompileThroughManifestBoundPlan(t *testing.T) {
	dir := t.TempDir()
	index := filepath.Join(dir, "index.json")
	release, err := catalog.Seal(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Compatibility: testCompatibility("2.0.0"), Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Profiles: map[string]contracts.ServiceGraph{"default": {}}, Config: []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"secured"`}}}}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, data, 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(dir, "output.json"))
	if err != nil {
		t.Fatal(err)
	}
	code := run("plan", index, "", "", "", "", "", "kb-dev", "", false, "custom", `{"access.mode":"local"}`, false, directRequest{PlatformRoot: "/tmp/platform", Offline: true, Policy: "compatible"}, output)
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	result, err := os.ReadFile(filepath.Join(dir, "output.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(result), `"path":"/gateway/access/mode"`) || !strings.Contains(string(result), `"json":"\"local\""`) {
		t.Fatalf("plan = %s", result)
	}
}

func TestRunStatusVerifiesTheReceiptOwnedGraph(t *testing.T) {
	dir := t.TempDir()
	plan := contracts.ResolvedInstallPlan{
		Schema:       contracts.ResolvedPlanSchema,
		PlanHash:     "status-plan",
		Request:      contracts.InstallRequest{PlatformRoot: dir},
		ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "workflow", Command: "workflow", Required: true}}},
	}
	if _, err := render.Write(plan); err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(dir, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "receipt", Plan: plan}); err != nil {
		t.Fatal(err)
	}
	kbdev := filepath.Join(dir, "kb-dev")
	if err := os.WriteFile(kbdev, []byte("#!/bin/sh\nprintf '%s\\n' '{\"services\":{\"workflow\":{\"state\":\"alive\"}}}'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	output, err := os.CreateTemp(dir, "status-output")
	if err != nil {
		t.Fatal(err)
	}
	if code := runStatus(dir, kbdev, output); code != 0 {
		t.Fatalf("status exit code = %d", code)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output.Name())
	if err != nil || !strings.Contains(string(data), `"operation":"status"`) {
		t.Fatalf("status output = %s, error = %v", data, err)
	}
}

func secretsFile(t *testing.T, root string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, ".kb", "v2", "secrets.env"))
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			values[key] = value
		}
	}
	return values
}

func gatewaySecretPatches() []contracts.ConfigPatch {
	return []contracts.ConfigPatch{
		{Path: "/gateway/access/mode", JSON: `"secured"`, Owner: "manifest:gateway.access.mode"},
		{Owner: "manifest:gateway.jwtSecret", Environment: "GATEWAY_JWT_SECRET", Services: []string{"gateway"}},
		{Owner: "manifest:gateway.bootstrap.password", Environment: "GATEWAY_BOOTSTRAP_ADMIN_PASSWORD", Services: []string{"gateway"}},
	}
}

// A secret must be reachable under the environment variable name the generated
// service env references (kb-dev resolves ${GATEWAY_JWT_SECRET} by that name),
// not only under its requirement ID — whatever put it in the store.
func TestBindSecretEnvironmentsAddsTheBoundEnvironmentKey(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	// As the wizard (or --secret-env) leaves them: keyed by requirement ID only.
	if err := store.Put("gateway.jwtSecret", "jwt-value"); err != nil {
		t.Fatal(err)
	}
	if err := store.Put("gateway.bootstrap.password", "admin-value"); err != nil {
		t.Fatal(err)
	}
	if err := bindSecretEnvironments(store, gatewaySecretPatches()); err != nil {
		t.Fatal(err)
	}
	got := secretsFile(t, root)
	want := map[string]string{
		"gateway.jwtSecret":                "jwt-value",
		"GATEWAY_JWT_SECRET":               "jwt-value",
		"gateway.bootstrap.password":       "admin-value",
		"GATEWAY_BOOTSTRAP_ADMIN_PASSWORD": "admin-value",
	}
	if len(got) != len(want) {
		t.Fatalf("stored keys = %v, want %v", got, want)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %q, want %q (all: %v)", key, got[key], value, got)
		}
	}
	if exists, err := store.Exists("gateway.jwtSecret"); err != nil || !exists {
		t.Fatalf("requirement ID must stay verifiable: %v / %v", exists, err)
	}
}

func TestBindSecretEnvironmentsIsIdempotentAndSkipsWhatIsNotThere(t *testing.T) {
	root := t.TempDir()
	store := secrets.Store{PlatformRoot: root}
	if err := store.Put("gateway.jwtSecret", "jwt-value"); err != nil {
		t.Fatal(err)
	}
	patches := append(gatewaySecretPatches(),
		// bound to an env equal to its own ID: nothing to add
		contracts.ConfigPatch{Owner: "manifest:OPENAI_API_KEY", Environment: "OPENAI_API_KEY", Services: []string{"gateway"}},
		// a non-secret patch that happens to carry no environment
		contracts.ConfigPatch{Path: "/x", JSON: `1`, Owner: "platform"},
	)
	for i := 0; i < 2; i++ {
		if err := bindSecretEnvironments(store, patches); err != nil {
			t.Fatal(err)
		}
	}
	got := secretsFile(t, root)
	// gateway.bootstrap.password was never provided: no alias is invented for it.
	if len(got) != 2 || got["gateway.jwtSecret"] != "jwt-value" || got["GATEWAY_JWT_SECRET"] != "jwt-value" {
		t.Fatalf("stored keys = %v", got)
	}
}

func TestBindSecretEnvironmentsRejectsConflictingValuesForOneVariable(t *testing.T) {
	store := secrets.Store{PlatformRoot: t.TempDir()}
	_ = store.Put("a.secret", "one")
	_ = store.Put("b.secret", "two")
	patches := []contracts.ConfigPatch{
		{Owner: "manifest:a.secret", Environment: "SHARED_ENV", Services: []string{"gateway"}},
		{Owner: "manifest:b.secret", Environment: "SHARED_ENV", Services: []string{"gateway"}},
	}
	if err := bindSecretEnvironments(store, patches); err == nil {
		t.Fatal("two different values for one environment variable must be rejected, not silently last-write-wins")
	}
	_ = store.Put("b.secret", "one")
	if err := bindSecretEnvironments(store, patches); err != nil {
		t.Fatalf("identical values are not a conflict: %v", err)
	}
}
