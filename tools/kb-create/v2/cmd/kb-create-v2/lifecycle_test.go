//go:build !windows

package v2cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
)

type snapshotRestoreRecorder struct {
	artifacts []contracts.Artifact
	calls     int
}

func (r *snapshotRestoreRecorder) Restore(artifacts []contracts.Artifact) error {
	r.artifacts = append(r.artifacts, artifacts...)
	r.calls++
	return nil
}

// case: S-024.3
func TestRollbackRestoresSnapshotFilesAfterCommandPackageRestore(t *testing.T) {
	root := t.TempDir()
	previousArtifact := contracts.Artifact{ID: "host", Kind: "package", Package: "@kb-labs/host", Version: "1.0.0"}
	previous := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "before", InstallationID: "installation-stable", Plan: contracts.ResolvedInstallPlan{PlanHash: "old", Artifacts: []contracts.Artifact{previousArtifact}}}
	if err := receipt.Write(root, previous); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, ".kb", "kb.config.jsonc")
	if err := os.WriteFile(config, []byte("original config bytes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	secretStore := secrets.Store{PlatformRoot: root}
	if err := secretStore.Put("GATEWAY_INTERNAL_SECRET", "generated-value"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := receipt.CreateSnapshot(root, filepath.Join(root, "snapshots"), time.Unix(4, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := secretStore.Put("GATEWAY_INTERNAL_SECRET", "updated-value"); err != nil {
		t.Fatal(err)
	}
	if err := receipt.Write(root, contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: "after", InstallationID: "installation-stable"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("updated config bytes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	installer := &snapshotRestoreRecorder{}
	if _, err := lifecycle.Rollback(root, filepath.Join(root, "snapshots"), snapshot.ID, restoreReceiptArtifacts(installer)); err != nil {
		t.Fatal(err)
	}
	if installer.calls != 1 || !reflect.DeepEqual(installer.artifacts, []contracts.Artifact{previousArtifact}) {
		t.Fatalf("restored packages = %#v, calls = %d", installer.artifacts, installer.calls)
	}
	got, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original config bytes\n" {
		t.Fatalf("config after rollback = %q, want original snapshot bytes", got)
	}
	for _, data := range snapshot.Files {
		if bytes.Contains(data, []byte("generated-value")) || bytes.Contains(data, []byte("updated-value")) {
			t.Fatal("recovery snapshot captured private installation secret bytes")
		}
	}
	if value, present, err := secretStore.Get("GATEWAY_INTERNAL_SECRET"); err != nil || !present || value != "updated-value" {
		t.Fatal("rollback restored a stale shared secret-state record")
	}
	restored, err := receipt.Read(root)
	if err != nil || restored.ID != "before" {
		t.Fatalf("receipt after rollback = %#v, %v", restored, err)
	}
}

func TestRecoveryRequiresYesWithoutTTY(t *testing.T) {
	root := t.TempDir()
	receiptPath := receipt.Path(root)
	if err := os.MkdirAll(filepath.Dir(receiptPath), 0o750); err != nil {
		t.Fatal(err)
	}
	wantReceipt := []byte("active receipt must survive refused uninstall\n")
	if err := os.WriteFile(receiptPath, wantReceipt, 0o600); err != nil {
		t.Fatal(err)
	}

	registry := "https://registry.example.test"
	payload, code, raw := invoke(t, operationTestSetup{Operation: "uninstall", PlatformRoot: root, Registry: registry, JSON: true})
	wantHint := "rerun `" + contracts.ShellCommand("kb-create", "uninstall", "--platform-root", root, "--registry", registry, "--json", "--yes") + "`"
	errorPayload, _ := payload["error"].(map[string]any)
	if code != 2 || errorCode(payload) != "KB_INSTALL_CONFIRMATION_REQUIRED" || errorPayload["hint"] != wantHint {
		t.Fatalf("unexpected confirmation envelope: %d %s", code, raw)
	}
	if gotReceipt, err := os.ReadFile(receiptPath); err != nil || string(gotReceipt) != string(wantReceipt) {
		t.Fatalf("receipt changed after refused uninstall: got %q, err %v", gotReceipt, err)
	}
}

// case: S-050.4, S-024.4, S-100.2, S-203.12
func TestDestructiveOperationsRequireExplicitNonTTYConfirmation(t *testing.T) {
	for _, test := range []struct {
		operation string
		recover   bool
	}{{"uninstall", false}, {"rollback", false}} {
		operation := test.operation
		t.Run(operation, func(t *testing.T) {
			root := t.TempDir()
			writeVersionedReceipt(t, root, contracts.InstallReceipt{ID: "receipt", InstallationID: "installation-test",
				Plan: contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}})
			for _, jsonMode := range []bool{false, true} {
				input := operationTestSetup{Operation: operation, PlatformRoot: root, Recover: recoverRequest{Enabled: test.recover, JSON: jsonMode}, JSON: jsonMode}
				payload, code, _ := invoke(t, input)
				if code != 2 {
					t.Fatalf("non-TTY confirmation exit = %d, want 2", code)
				}
				if errorCode(payload) != "KB_INSTALL_CONFIRMATION_REQUIRED" ||
					!strings.Contains(fmt.Sprint(payload["error"]), "--yes") {
					t.Fatalf("non-TTY confirmation error lacks exact rerun hint: %#v", payload)
				}
			}
		})
	}
}

func TestRecoveryWithYesPassesConfirmationGate(t *testing.T) {
	root := t.TempDir()
	writeVersionedReceipt(t, root, contracts.InstallReceipt{ID: "receipt", InstallationID: "installation-test",
		Plan: contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}})
	if err := os.Remove(receipt.Path(platformRootForTest(t, root))); err != nil {
		t.Fatal(err)
	}
	payload, code, raw := invoke(t, operationTestSetup{Operation: "uninstall", PlatformRoot: root, Yes: true})
	if code != 1 || errorCode(payload) != contracts.CodeReceiptUnavailable {
		t.Fatalf("--yes did not proceed to receipt validation: %d %s", code, raw)
	}
}

// These tests run the real launcher binary as the supervisor and a real child
// process as the host; only the artifact swap (pnpm) is replaced by rewriting
// the receipt, which is what an update changes as far as the host is concerned.

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

func (i installation) hostState(t *testing.T) (state string, healthURL string) {
	t.Helper()
	status, _, raw := i.run("status", "--json")
	hostStatus, _ := status["host"].(map[string]any)
	if hostStatus == nil {
		t.Fatalf("status: %s", raw)
	}
	url, _ := hostStatus["healthUrl"].(string)
	return hostStatus["state"].(string), url
}

func TestUpdateKeepsTheOldHostServingUntilExplicitRestart(t *testing.T) {
	inst := newInstallation(t)
	started, code, raw := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start: %s", raw)
	}
	before := started["host"].(map[string]any)["pid"].(float64)
	if _, code, raw := inst.update(t, updatePlan(t, inst.root, inst.port), &recordingInstaller{}); code != 0 {
		t.Fatalf("update: %d %s", code, raw)
	}
	state, healthURL := inst.hostState(t)
	if state != "running" || healthURL != fmt.Sprintf("http://127.0.0.1:%d/health", inst.port) {
		t.Fatalf("the old host must keep serving until restart: %s %s", state, healthURL)
	}
	if conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", inst.port), 200*time.Millisecond); dialErr != nil {
		t.Fatalf("old host stopped serving after update: %v", dialErr)
	} else {
		_ = conn.Close()
	}
	status, _, _ := inst.run("status", "--json")
	if pid := status["host"].(map[string]any)["pid"].(float64); pid != before {
		t.Fatal("update replaced the host without an explicit restart")
	}
	if installation, _ := status["installation"].(map[string]any); installation["platformVersion"] != "2.0.0" {
		t.Fatalf("status must report the installed version: %v", status["installation"])
	}
	if status["pendingRestart"] == nil {
		t.Fatal("status did not report the pending restart")
	}
}

func TestUnhealthyUpdatedHostRestoresPreviousVersionAtExplicitRestart(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	broken := updatePlan(t, inst.root, inst.port, "-exit", "5")
	broken.ServiceGraph.PlatformVersion, broken.PlanHash = "2.0.0", "explicit-restart-unhealthy"
	if _, code, raw := inst.update(t, broken, &recordingInstaller{}); code != 0 {
		t.Fatalf("update must finish before host health is checked: %d %s", code, raw)
	}
	if _, code, raw := inst.run("restart", "--json"); code != 1 || errorCodeFromOutput(raw) != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("unhealthy target restart did not return its catalogued recovery result: %d %s", code, raw)
	}
	state, healthURL := inst.hostState(t)
	if state != "running" || healthURL != fmt.Sprintf("http://127.0.0.1:%d/health", inst.port) {
		t.Fatalf("the previous host must be running again: %s %s", state, healthURL)
	}
	active, readErr := receipt.Read(platformRootForTest(t, inst.root))
	if readErr != nil || active.Plan.ServiceGraph.PlatformVersion != "1.0.0" {
		t.Fatalf("the previous receipt must be active again: %#v, %v", active, readErr)
	}
}

func TestUpdateLeavesAStoppedHostStopped(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.update(t, updatePlan(t, inst.root, freeLoopbackPort(t)), &recordingInstaller{}); code != 0 {
		t.Fatalf("update: %d %s", code, raw)
	}
	if state, _ := inst.hostState(t); state != "stopped" {
		t.Fatalf("an update must not start a host that was stopped, state = %s", state)
	}
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("output is not one JSON document: %v\n%s", err, data)
	}
	return parsed
}

// invoke runs one non-host command and returns its JSON output and status.
func mapValue(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(encoded, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed
}

func diagValue(t *testing.T, failure *diag.Diag) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(result.FailureEnvelope(failure))
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(encoded, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestRollbackWithoutASnapshotIsRefusedWithTheCatalogError(t *testing.T) {
	inst := newInstallation(t)
	payload, code, raw := invoke(t, operationTestSetup{Operation: "rollback", PlatformRoot: inst.root, Yes: true})
	if code != 1 || errorCode(payload) != contracts.CodeUpdateNoSnapshot {
		t.Fatalf("rollback: %d %s", code, raw)
	}
	failure := payload["error"].(map[string]any)
	if failure["message"] != "There is no snapshot to roll back to." || failure["hint"] == "" {
		t.Fatalf("error = %v", failure)
	}
}

// case: S-025.6
func TestRollbackFailureIncludesOperationLogAndDiagnosticDossier(t *testing.T) {
	inst := newInstallation(t)
	payload, code, raw := invoke(t, operationTestSetup{Operation: "rollback", PlatformRoot: inst.root,
		Snapshot: "fixture-missing-snapshot", Yes: true, JSON: true})
	if code != 1 || errorCode(payload) != contracts.CodeUpdateApplyFailed {
		t.Fatalf("rollback failure: %d %s", code, raw)
	}
	errorEnvelope, _ := payload["error"].(map[string]any)
	details, _ := errorEnvelope["details"].(map[string]any)
	logPath, _ := details["logPath"].(string)
	diagnosticPath, _ := details["diagnosticPath"].(string)
	if logPath == "" || diagnosticPath == "" {
		t.Fatalf("rollback failure omitted its log or dossier path: %s", raw)
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("rollback operation log is not available: %v", err)
	}
	if _, err := os.Stat(diagnosticPath); err != nil {
		t.Fatalf("rollback diagnostic dossier is not available: %v", err)
	}
}

// case: S-223.3
func TestLifecycleCommandsNeedAnInstallation(t *testing.T) {
	t.Setenv(host.KBHomeEnv, t.TempDir())
	for _, test := range []struct{ operation, code string }{{"rollback", contracts.CodeInstallLayoutUnsupported}, {"uninstall", contracts.CodeInstallLayoutUnsupported}} {
		payload, code, raw := invoke(t, operationTestSetup{Operation: test.operation, PlatformRoot: t.TempDir(), Yes: true})
		if code != 1 || errorCode(payload) != test.code {
			t.Fatalf("%s: %d %s", test.operation, code, raw)
		}
	}
}

// case: S-222.7
func TestStatusReportsTheHostAndTheInstalledVersion(t *testing.T) {
	inst := newInstallation(t)
	payload, code, raw := invoke(t, operationTestSetup{Operation: "status", PlatformRoot: inst.root, JSON: true})
	if code != 0 || payload["host"].(map[string]any)["state"] != "stopped" || payload["bootstrapCompleted"] != false {
		t.Fatalf("status: %d %s", code, raw)
	}
	if err := (secrets.Store{PlatformRoot: platformRootForTest(t, inst.root)}).MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	payload, code, raw = invoke(t, operationTestSetup{Operation: "status", PlatformRoot: inst.root, JSON: true})
	if code != 0 || payload["bootstrapCompleted"] != true {
		t.Fatalf("status after bootstrap completion: %d %s", code, raw)
	}
}

func TestDoctorSeparatesTheInstallationFromThePlatform(t *testing.T) {
	inst := newInstallation(t)
	if err := os.MkdirAll(filepath.Join(platformRootForTest(t, inst.root), ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(platformRootForTest(t, inst.root), ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Stopped host: the installation is fine, the platform is not running.
	payload, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, JSON: true})
	if code != 0 || payload["ok"] != false {
		t.Fatalf("doctor: %d %s", code, raw)
	}
	if payload["installation"].(map[string]any)["ok"] != true || payload["platform"].(map[string]any)["ok"] != false {
		t.Fatalf("the two questions must be answered separately: %s", raw)
	}
	platformChecks := payload["platform"].(map[string]any)["checks"].([]any)
	var adapterCheck map[string]any
	for _, item := range platformChecks {
		if check, ok := item.(map[string]any); ok && check["id"] == "adapters" {
			adapterCheck = check
		}
	}
	if adapterCheck == nil || !strings.Contains(adapterCheck["detail"].(string), "cannot be checked") ||
		adapterCheck["hint"] != fmt.Sprintf("Run `%s`.", contracts.ShellCommand("kb-create", "start", "--platform-root", inst.root)) {
		t.Fatalf("stopped doctor adapter check = %#v", adapterCheck)
	}
	textValue, textFailure, textCode, _ := executeForTest(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root})
	if textCode != 0 || textFailure != nil {
		t.Fatalf("stopped text doctor exit code = %d, failure=%v", textCode, textFailure)
	}
	textBytes := []byte(renderDoctor(textValue))
	if !strings.Contains(string(textBytes), "Adapter status cannot be checked") ||
		!strings.Contains(string(textBytes), contracts.ShellCommand("kb-create", "start", "--platform-root", inst.root)) {
		t.Fatalf("stopped text doctor omits the adapter limitation or start command: %s", textBytes)
	}

	// Running host: both are healthy.
	if _, exit, out := inst.run("start", "--json"); exit != 0 {
		t.Fatalf("start: %s", out)
	}
	payload, code, raw = invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, JSON: true})
	if code != 0 || payload["ok"] != true || payload["platform"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor on a healthy platform: %d %s", code, raw)
	}

	// A broken installation is reported as installation, whatever the platform does.
	if err := os.Remove(filepath.Join(platformRootForTest(t, inst.root), ".kb", "kb.config.jsonc")); err != nil {
		t.Fatal(err)
	}
	payload, code, raw = invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, JSON: true})
	if code != 0 || payload["installation"].(map[string]any)["ok"] != false || payload["platform"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor on a broken installation: %d %s", code, raw)
	}
}

// case: S-025.4, S-025.5
func TestDoctorReportsMissingProjectionReadOnlyAndFixRestoresIt(t *testing.T) {
	inst := newInstallation(t)
	if err := os.MkdirAll(filepath.Join(platformRootForTest(t, inst.root), ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(platformRootForTest(t, inst.root), ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	artifact := contracts.Artifact{ID: "@kb/plugin", Package: "@kb/plugin", Version: "1.2.3"}
	required := contracts.Artifact{ID: "gateway", Package: "@kb/gateway", Version: "1.2.3", Config: []contracts.ConfigRequirement{{
		ID: "gateway.bootstrap.password", Path: "/gateway/bootstrap/password", Required: true, Secret: true,
	}}}
	active.Plan.Artifacts = []contracts.Artifact{artifact, required}
	active.Plan.Request.PlatformRoot = filepath.Join(inst.root, "current")
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	layout, err := versionroot.New(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	physical, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	requiredRoot := filepath.Join(physical, "node_modules", "@kb", "gateway")
	if err := os.MkdirAll(requiredRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(requiredRoot, "package.json"), []byte(`{"name":"@kb/gateway","version":"1.2.3"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installed.Write(platformRootForTest(t, inst.root), required); err != nil {
		t.Fatal(err)
	}
	packageRoot := filepath.Join(physical, "node_modules", "@kb", "plugin")
	if err := os.MkdirAll(packageRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb/plugin","version":"1.2.3"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(packageRoot, "kb-create.manifest.json")

	payload, _, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, JSON: true})
	findings, ok := payload["findings"].([]any)
	if !ok || len(findings) != 1 {
		t.Fatalf("doctor did not report the missing manifest projection: %s", raw)
	}
	finding := findings[0].(map[string]any)
	if finding["code"] != "KB_INSTALL_MANIFEST_PROJECTION_INVALID" || finding["component"] != "@kb/plugin" ||
		!strings.Contains(finding["hint"].(string), "kb-create doctor --fix") {
		t.Fatalf("unexpected projection finding: %#v", finding)
	}
	if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
		t.Fatalf("plain doctor changed the installed platform: %v", err)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start host before unresolved-input repair: %s", raw)
	}

	var fixStdout, fixStderr bytes.Buffer
	fixCode := clikitcommand.Execute(newRootCommand(), []string{"doctor", "--fix", "--platform-root", inst.root, "--json"}, &fixStdout, &fixStderr)
	fixOutput := fixStdout.String()
	if fixCode.Code() != 0 {
		t.Fatalf("doctor --fix should return the successful clikit repair result: %d %s", fixCode.Code(), fixOutput)
	}
	var response struct {
		OK   bool `json:"ok"`
		Data struct {
			Findings      []map[string]any `json:"findings"`
			HostRestarted bool             `json:"hostRestarted"`
			Repair        struct {
				RequiredInput []map[string]any `json:"requiredInput"`
			} `json:"repair"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(fixOutput), &response); err != nil {
		t.Fatalf("doctor --fix response is not JSON: %v: %s", err, fixOutput)
	}
	if !response.OK || len(response.Data.Findings) == 0 || response.Data.HostRestarted || len(response.Data.Repair.RequiredInput) != 1 ||
		response.Data.Repair.RequiredInput[0]["component"] != "gateway" ||
		response.Data.Repair.RequiredInput[0]["path"] != "/gateway/bootstrap/password" {
		t.Fatalf("doctor --fix omitted required input from the result: %#v; output=%s", response, fixOutput)
	}
	if _, err := os.Stat(manifestPath); err != nil {
		t.Fatalf("doctor --fix did not restore the projection: %v", err)
	}
	status, statusCode, statusOutput := inst.run("status", "--json")
	if statusCode != 0 || status["running"] == true {
		t.Fatalf("doctor --fix did not keep the host stopped while required input remains unresolved: %s", statusOutput)
	}
}

func TestDoctorOptionalCredentialWarningKeepsFreshInstallHealthy(t *testing.T) {
	inst := newInstallation(t)
	t.Setenv("OPENAI_API_KEY", "")
	if err := os.MkdirAll(filepath.Join(platformRootForTest(t, inst.root), ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(platformRootForTest(t, inst.root), ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	artifact := contracts.Artifact{ID: "openai", Package: "@kb-labs/adapters-openai", Version: "1.0.0", Config: []contracts.ConfigRequirement{{
		ID: "openai.apiKey", Path: "/platform/adapterOptions/llm/apiKey", Required: true, Optional: true,
		Secret: true, Env: "OPENAI_API_KEY", Services: []string{"gateway"},
		Action: "set OPENAI_API_KEY to enable LLM features", Hint: "set OPENAI_API_KEY",
	}}}
	active.Plan.Artifacts = []contracts.Artifact{artifact}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	packageRoot := filepath.Join(platformRootForTest(t, inst.root), "node_modules", filepath.FromSlash(artifact.Package))
	if err := os.MkdirAll(packageRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "package.json"), []byte(`{"name":"@kb-labs/adapters-openai","version":"1.0.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installed.Write(platformRootForTest(t, inst.root), artifact); err != nil {
		t.Fatal(err)
	}
	if _, code, output := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", output)
	}
	payload, code, output := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, JSON: true})
	findings, ok := payload["findings"].([]any)
	if code != 0 || payload["ok"] != true || !ok || len(findings) != 1 {
		t.Fatalf("optional credential warning made the fresh install unhealthy: exit=%d %s", code, output)
	}
	warning := findings[0].(map[string]any)
	if warning["code"] != doctor.CodeAdapterCredentialsMissing || warning["severity"] != doctor.SeverityWarning || warning["action"] != "set OPENAI_API_KEY to enable LLM features" || warning["path"] != "/platform/adapterOptions/llm/apiKey" {
		t.Fatalf("unexpected optional credential warning: %#v", warning)
	}
	if strings.Contains(output, "secret-value") {
		t.Fatalf("doctor exposed secret material: %s", output)
	}
	textValue, textFailure, textCode, _ := executeForTest(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root})
	if textCode != 0 || textFailure != nil {
		t.Fatalf("text doctor rejected the optional credential warning: exit=%d failure=%v", textCode, textFailure)
	}
	textBytes := []byte(renderDoctor(textValue))
	if !strings.Contains(string(textBytes), "Warnings:") || !strings.Contains(string(textBytes), "set OPENAI_API_KEY to enable LLM features") {
		t.Fatalf("text doctor omits the optional credential warning: %s", textBytes)
	}

	artifact.Config = append(artifact.Config, contracts.ConfigRequirement{ID: "gateway.mode", Path: "/platform/mode", Required: true, Hint: "configure platform mode"})
	active.Plan.Artifacts = []contracts.Artifact{artifact}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	if err := installed.Write(platformRootForTest(t, inst.root), artifact); err != nil {
		t.Fatal(err)
	}
	payload, code, output = invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, JSON: true})
	findings, ok = payload["findings"].([]any)
	if code != 0 || payload["ok"] != false || !ok || len(findings) != 2 {
		t.Fatalf("required platform configuration did not fail doctor: exit=%d %s", code, output)
	}
	if findings[1].(map[string]any)["severity"] != doctor.SeverityError {
		t.Fatalf("required platform finding is not an error: %#v", findings)
	}
}

// recoverInstallation returns an installation whose platform ships a recovery
// tool that records the arguments it was run with.
func recoverInstallation(t *testing.T, withTool bool) (installation, string) {
	t.Helper()
	inst := newInstallation(t)
	record := filepath.Join(t.TempDir(), "args.txt")
	script := filepath.Join(platformRootForTest(t, inst.root), "recover.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$RECOVER_RECORD\"\nprintf 'recovered\\n'\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RECOVER_RECORD", record)
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	if withTool {
		active.Plan.Host.Recover = &contracts.ToolSpec{Command: "./recover.sh", Args: []string{"--base"}}
	}
	if err := receipt.Write(platformRootForTest(t, inst.root), active); err != nil {
		t.Fatal(err)
	}
	return inst, record
}

// case: S-100.2
func TestDoctorRecoverRunsThePlatformRecoveryToolWithTheHostStopped(t *testing.T) {
	inst, record := recoverInstallation(t, true)
	request := recoverRequest{Enabled: true, Email: "admin@example.com", Tenant: "acme", Generate: true, Yes: true}
	_, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, Recover: request})
	if code != 0 || !strings.Contains(raw, "recovered") {
		t.Fatalf("recover: %d %q", code, raw)
	}
	args, err := os.ReadFile(record)
	if err != nil || strings.TrimSpace(string(args)) != "--base --email admin@example.com --tenant acme --generate --yes" {
		t.Fatalf("the tool must receive the operator's flags: %q, %v", args, err)
	}
}

// case: S-100.2, S-222.11
func TestGeneratedRecoveryCredentialIsShownWithoutStorage(t *testing.T) {
	inst, _ := recoverInstallation(t, true)
	root := platformRootForTest(t, inst.root)
	store := secrets.Store{PlatformRoot: root}
	if err := store.MarkBootstrapCompleted("provisioned"); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBootstrapDisclosed(); err != nil {
		t.Fatal(err)
	}
	const recoveredPassword = "recovery-output-only-test-sentinel"
	t.Setenv("RECOVER_GENERATED_PASSWORD", recoveredPassword)
	recoverScript := filepath.Join(root, "recover.sh")
	if err := os.WriteFile(recoverScript, []byte("#!/bin/sh\nprintf '%s\\n' \"$RECOVER_GENERATED_PASSWORD\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	active, err := receipt.Read(root)
	if err != nil {
		t.Fatal(err)
	}
	active.Plan.Host.Recover = &contracts.ToolSpec{Command: "./recover.sh"}
	if err := receipt.Write(root, active); err != nil {
		t.Fatal(err)
	}
	payload, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root,
		Recover: recoverRequest{Enabled: true, Email: "admin@example.com", Generate: true, Yes: true, JSON: true}})
	if code != 0 || !strings.Contains(raw, recoveredPassword) || payload["operation"] != "recover" {
		t.Fatalf("generated recovery credential was not returned to the user: status=%d operation=%v", code, payload["operation"])
	}
	for _, name := range []string{secrets.BootstrapPassword, secrets.BootstrapPasswordEnvironment} {
		if present, err := store.Exists(name); err != nil || present {
			t.Fatalf("recovery stored replacement bootstrap value under %q: present=%v err=%v", name, present, err)
		}
	}
	assertSecretAbsentFromTree(t, inst.root, recoveredPassword)
}

// case: S-100.2
func TestDoctorRecoverUsesExplicitPlatformRootWithoutARegisteredProject(t *testing.T) {
	inst, record := recoverInstallation(t, true)
	isolatedHome := t.TempDir()
	t.Setenv("HOME", isolatedHome)
	t.Setenv("KB_HOME", inst.kbHome)
	t.Setenv("KB_PLATFORM_ROOT", "")
	t.Setenv("KB_PROJECT_ROOT", "")
	t.Setenv("KB_PROJECT_ID", "")
	request := recoverRequest{Enabled: true, Email: "admin@example.com", Tenant: "acme", Generate: true, Yes: true, JSON: true}
	payload, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, Recover: request})
	if code != 0 || !strings.Contains(raw, "recovered") {
		t.Fatalf("recover with explicit platform root and no registered project: %d %s", code, raw)
	}
	if payload["operation"] != "recover" || payload["recovered"] != true {
		t.Fatalf("recovery did not return a valid recovery result: %#v", payload)
	}
	if errorCode(payload) != "" {
		t.Fatalf("recovery returned an error: %v", payload)
	}
	if _, err := os.Stat(record); err != nil {
		t.Fatalf("platform recovery tool was not run: %v", err)
	}
}

// case: S-100.4
func TestDoctorRecoverRefusesWhileTheHostRuns(t *testing.T) {
	inst, record := recoverInstallation(t, true)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	payload, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, Recover: recoverRequest{Enabled: true, Yes: true, JSON: true}})
	if code != 1 || errorCode(payload) != contracts.CodeRecoveryHostRunning {
		t.Fatalf("recover: %d %s", code, raw)
	}
	failure := payload["error"].(map[string]any)
	if failure["hint"] != "Run \"kb-create stop\", recover, then \"kb-create start\"." {
		t.Fatalf("running-host recovery hint = %v", failure["hint"])
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatal("the recovery tool must not run while the host runs")
	}
}

func TestDoctorRecoverNeedsAPlatformThatShipsARecoveryTool(t *testing.T) {
	inst, _ := recoverInstallation(t, false)
	payload, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, Recover: recoverRequest{Enabled: true, Yes: true, JSON: true}})
	if code != 1 || errorCode(payload) != contracts.CodeRecoveryUnavailable {
		t.Fatalf("recover: %d %s", code, raw)
	}
}

func TestDoctorRecoverFailureUsesCataloguedOperationStatus(t *testing.T) {
	inst, _ := recoverInstallation(t, true)
	script := filepath.Join(platformRootForTest(t, inst.root), "recover.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 4\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, code, raw := invoke(t, operationTestSetup{Operation: "doctor", PlatformRoot: inst.root, Recover: recoverRequest{Enabled: true, Yes: true}}); code != 1 {
		t.Fatalf("exit status = %d, want catalogued operation failure 1: %s", code, raw)
	}
}

// case: PC-001.10, PC-001.12, PC-001.16
func TestApplyRefusesOnlyTheRunningInstallationRoot(t *testing.T) {
	inst := newInstallation(t)
	if reused, failure := reusableApplyHost(contracts.ResolvedInstallPlan{Host: &contracts.HostSpec{}}, inst.root); failure != nil || reused != nil {
		t.Fatalf("nothing runs yet: %v", failure)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	active, err := receipt.Read(platformRootForTest(t, inst.root))
	if err != nil {
		t.Fatal(err)
	}
	reused, failure := reusableApplyHost(active.Plan, inst.root)
	if failure != nil || reused == nil || reused.ID != active.ID {
		t.Fatalf("running host was not reused: receipt=%#v failure=%#v", reused, failure)
	}
	if failure := refuseRunningHost(inst.root); failure == nil || failure.Code != "KB_HOST_ALREADY_RUNNING" || failure.Meta["pid"] == "" {
		t.Fatalf("start refusal = %#v", failure)
	}
	secondary := filepath.Join(t.TempDir(), "secondary")
	if reused, failure := reusableApplyHost(contracts.ResolvedInstallPlan{Host: &contracts.HostSpec{}}, secondary); failure != nil || reused != nil {
		t.Fatalf("a different installation root was refused: %v", failure)
	}
}

// case: S-005.7
func TestClientApplyIsAllowedBesideASupervisedHost(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	clientPlan := contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{Profile: "client"}}
	if reused, failure := reusableApplyHost(clientPlan, filepath.Join(t.TempDir(), "client")); failure != nil || reused != nil {
		t.Fatalf("client apply refused beside host: %v", failure)
	}
	hostPlan := contracts.ResolvedInstallPlan{Host: &contracts.HostSpec{}}
	if reused, failure := reusableApplyHost(hostPlan, filepath.Join(t.TempDir(), "other")); failure != nil || reused != nil {
		t.Fatalf("independent host apply refused beside another root: %#v", failure)
	}
}
