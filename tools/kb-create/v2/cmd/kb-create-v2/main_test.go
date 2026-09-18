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
