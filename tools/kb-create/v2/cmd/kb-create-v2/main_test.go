package v2cli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/stream"
	sharedtoolchain "github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
)

// case: S-285.1
func TestPlanLoadsInstallerSavedIndex(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".local", "share", "kb-create", "release-index.json")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"invalid":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, failure := resolvePlan(planInput{Operation: "plan", Direct: directRequest{PlatformRoot: t.TempDir()}})
	if failure == nil || failure.Message == "--index and either --input or --platform-root are required" {
		t.Fatalf("saved index was not read: %#v", failure)
	}
}

// case: S-285.1
func TestJSONInstallLoadsInstallerSavedIndex(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".local", "share", "kb-create", "release-index.json")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"invalid":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, _, code, output := executeForTest(t, operationTestSetup{Operation: "install", PlatformRoot: filepath.Join(home, "platform"), JSON: true})
	if code == 0 || strings.Contains(output, "install needs a release index and an install request") {
		t.Fatalf("saved index was not read: %s", output)
	}
}

// case: S-285.3
func TestScenarioHelpListsCatalog(t *testing.T) {
	root := newRootCommand()
	cmd, _, err := root.Find([]string{"install"})
	if err != nil {
		t.Fatal(err)
	}
	usage := cmd.Flags().Lookup("scenario").Usage
	if !strings.Contains(usage, "custom") || !strings.Contains(usage, "explore") {
		t.Fatalf("scenario help lacks catalog IDs: %s", usage)
	}
}

// case: S-285.3
func TestUnknownScenarioListsCatalog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	_, failure := resolvePlan(planInput{Operation: "plan", Index: index, Direct: directRequest{PlatformRoot: filepath.Join(home, "platform")}, ScenarioID: "local"})
	if failure == nil || !strings.Contains(failure.Hint, "custom") || !strings.Contains(failure.Hint, "explore") {
		t.Fatalf("failure=%#v", failure)
	}
}

func TestRequestWithGeneratedSecretsAddsOnlyDeclaredGeneratedSecretInputs(t *testing.T) {
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: t.TempDir()}
	artifacts := []contracts.Artifact{{Config: []contracts.ConfigRequirement{
		{ID: "gateway.jwtSecret", Secret: true, Generate: true},
		{ID: "gateway.bootstrap.password", Secret: true},
	}}}
	got, changed, err := requestWithGeneratedSecrets(request, artifacts)
	if err != nil || !changed || len(got.SecretInputs) != 1 || got.SecretInputs[0] != "gateway.jwtSecret" {
		t.Fatalf("request/changed/error = %#v / %v / %v", got, changed, err)
	}
	got, changed, err = requestWithGeneratedSecrets(got, artifacts)
	if err != nil || changed || len(got.SecretInputs) != 1 {
		t.Fatalf("second request/changed/error = %#v / %v / %v", got, changed, err)
	}
}

func TestMissingSecretDiagnosticOmitsEnvironmentVariableName(t *testing.T) {
	const environment = "KB_TEST_SECRET_ENV_NAME_MUST_NOT_APPEAR"
	t.Setenv(environment, "")
	err := populateSecrets(secrets.Store{PlatformRoot: t.TempDir()}, "gateway.apiKey="+environment)
	if err == nil || strings.Contains(err.Error(), environment) {
		t.Fatal("missing secret diagnostic exposed its environment-variable name")
	}
}

// case: S-005.6
func TestClientStatusAndDoctorAreHealthyWithoutHost(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema,
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.0.0", Profile: "client"}}
	writeVersionedReceipt(t, root, contracts.InstallReceipt{ID: "client-r1", InstallationID: "installation-client", Plan: plan})
	statusResult, statusFailure, statusCode, _ := executeForTest(t, operationTestSetup{Operation: "status", PlatformRoot: root, JSON: true})
	if statusCode != 0 || statusFailure != nil {
		t.Fatalf("status exit = %d, failure=%v", statusCode, statusFailure)
	}
	statusData := statusResult.(map[string]any)
	if statusData["profile"] != "client" || statusData["installed"] != true || statusData["running"] != false {
		t.Fatalf("client status = %#v", statusData)
	}

	diagnosis, doctorFailure, doctorCode, _ := executeForTest(t, operationTestSetup{Operation: "doctor", PlatformRoot: root, JSON: true})
	if doctorCode != 0 || doctorFailure != nil {
		t.Fatalf("doctor exit = %d, failure=%v", doctorCode, doctorFailure)
	}
	diagnosisBytes, err := json.Marshal(diagnosis)
	if err != nil {
		t.Fatal(err)
	}
	var diagnosisData map[string]any
	if err := json.Unmarshal(diagnosisBytes, &diagnosisData); err != nil {
		t.Fatal(err)
	}
	if diagnosisData["profile"] != "client" || diagnosisData["ok"] != true || diagnosisData["running"] != false {
		t.Fatalf("client doctor = %#v", diagnosisData)
	}
}

func TestVersionJSONIncludesBuildCommit(t *testing.T) {
	previousVersion, previousCommit := buildVersion, buildCommit
	t.Cleanup(func() { buildVersion, buildCommit = previousVersion, previousCommit })
	SetVersionInfo("2.3.4", "abc1234", "2026-10-06")
	var stdout, stderr bytes.Buffer
	if code := clikitcommand.Execute(newRootCommand(), []string{"version", "--json"}, &stdout, &stderr); code.Code() != 0 {
		t.Fatalf("version command exit = %d: %s", code.Code(), stderr.String())
	}
	var payload struct {
		OK   bool              `json:"ok"`
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatalf("version JSON is invalid: %s (%v)", stdout.String(), err)
	}
	if !payload.OK || payload.Data["version"] != "2.3.4" || payload.Data["commit"] != "abc1234" {
		t.Fatalf("version identity = %#v", payload)
	}
}

func TestGatewayURLFlagProducesAPlanForTheDeclaredGateway(t *testing.T) {
	listener := testListenerWithPortHeadroom(t, 100)
	port := listener.Addr().(*net.TCPAddr).Port
	gatewayURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: 4000}}}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "platform.adapterOptions", Path: "/platform/adapterOptions",
		Default: `{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:4000"}}}}`}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	encoded, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"plan", "--json", "--index", indexPath,
		"--platform-root", filepath.Join(t.TempDir(), "platform"), "--gateway-url", gatewayURL}
	var busyOutput, busyError bytes.Buffer
	busyCode := clikitcommand.Execute(newRootCommand(), args, &busyOutput, &busyError)
	var busyPayload map[string]any
	if err := json.Unmarshal(busyOutput.Bytes(), &busyPayload); err != nil {
		t.Fatal(err)
	}
	if busyCode != diag.ExitCode(diag.New(contracts.CodeGatewayIndexUnavailable, "unavailable")) || errorCode(busyPayload) != contracts.CodePortInUse {
		t.Fatalf("occupied Gateway plan = code %d, error %s: %s", busyCode.Code(), errorCode(busyPayload), busyOutput.String())
	}
	errorEnvelope := busyPayload["error"].(map[string]any)
	if !strings.Contains(errorEnvelope["hint"].(string), "--gateway-url") {
		t.Fatalf("occupied Gateway plan hint omits --gateway-url: %#v", errorEnvelope)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), args, &stdout, &stderr)
	if code.Code() != 0 {
		t.Fatalf("plan exit = %d: %s", code.Code(), stdout.String()+stderr.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Data.Plan.Request.GatewayURL != gatewayURL || payload.Data.Plan.Host.HealthURL != gatewayURL+"/health" ||
		payload.Data.Plan.ServiceGraph.Services[0].Port != port {
		t.Fatalf("declared Gateway was not applied to plan: %#v", payload.Data.Plan)
	}
}

// case: S-268.9, PC-001.7, PC-002.2, S-040.3
func TestExecuteInstallThenStatusUsesTheInstallRootIdentity(t *testing.T) {
	launcherBinary, fakehost := binaries(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(host.KBHomeEnv, filepath.Join(home, ".kb"))
	root := filepath.Join(home, "kb-platform")
	registerTestHostProcessTreeCleanup(t, root)
	hostBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(home, ".local", "bin", "kb-create")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nexit 0\n"), 0o750); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(home, "release-index.json")
	port := freeAllocatedGatewayPortWithOffsets(t, 0)
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = &contracts.HostSpec{Command: hostBinary, Args: []string{"-test.run=^TestHostExecLauncher$"},
		Env:       map[string]string{"KB_TEST_FAKEHOST": fakehost, "KB_TEST_FAKEHOST_PORT": fmt.Sprint(port)},
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: port}}}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`},
		{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:%d"}}}}`, port)}}
	source.Adapters = append(source.Adapters, catalog.Adapter{Component: catalog.Component{
		ID: "state-broker", Version: "2.0.0", Package: "@kb-labs/state-broker", Tarball: "https://example.test/state-broker.tgz", SHA256: "state-broker",
	}, Provides: []string{"cache"}})
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	verified, err := catalog.VerifyCatalog(release)
	if err != nil {
		t.Fatal(err)
	}
	deps := commandDependencies{NodeCheck: func() error { return nil }, ArtifactRunner: operationLogTestRunner{}, Executable: launcher,
		Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verified}, Host: installedHostStarter{root: root, executable: launcherBinary}}}
	commandFactory := func(cmd *cobra.Command) commandDependencies {
		deps.Command = cmd
		return deps
	}
	var installOutput, installError bytes.Buffer
	installCode := clikitcommand.Execute(newRootCommandWithDependencyFactory(commandFactory), []string{"install", "--json", "--index", indexPath,
		"--platform-root", root, "--service-profile", "default", "--scenario", "commit"}, &installOutput, &installError)
	if installCode.Code() != 0 {
		state, _ := host.StateForRoot(root)
		hostLog, _ := os.ReadFile(state.HostLog())
		supervisorLog, _ := os.ReadFile(state.SupervisorLog())
		t.Fatalf("install argv exit=%d: stdout=%s stderr=%s hostLog=%s supervisorLog=%s", installCode.Code(), installOutput.String(), installError.String(), hostLog, supervisorLog)
	}
	installedReceipt, err := receipt.Read(platformRootForTest(t, root))
	if err != nil || installedReceipt.Plan.Request.PlatformRoot != root {
		t.Fatalf("install receipt request root = %q, error=%v; want selected install root %q", installedReceipt.Plan.Request.PlatformRoot, err, root)
	}
	if len(installedReceipt.MarketplaceInstalls) != 1 || installedReceipt.MarketplaceInstalls[0].Spec != "@kb-labs/commit" || installedReceipt.MarketplaceInstalls[0].ID != "@kb-labs/commit" ||
		installedReceipt.MarketplaceInstalls[0].Version != "1.0.0" || installedReceipt.MarketplaceInstalls[0].Source != "registry" ||
		installedReceipt.MarketplaceInstalls[0].SignatureStatus != "verified" {
		t.Fatalf("install receipt Marketplace results = %#v; want @kb-labs/commit", installedReceipt.MarketplaceInstalls)
	}
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	physicalRoot, err := layout.Active()
	if err != nil {
		t.Fatal(err)
	}
	for _, spelling := range []string{root, layout.PlatformRoot(), physicalRoot} {
		var stdout, stderr bytes.Buffer
		code := clikitcommand.Execute(newRootCommandWithDependencyFactory(commandFactory), []string{"status", "--platform-root", spelling, "--json"}, &stdout, &stderr)
		var response struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
			t.Fatalf("status for %q was not JSON: %v; stdout=%s stderr=%s", spelling, err, stdout.String(), stderr.String())
		}
		if code.Code() != 0 || response.Data["installed"] != true || response.Data["running"] != true || response.Data["reachable"] != true {
			t.Fatalf("status for %q after Execute install: code=%d data=%#v stdout=%s stderr=%s", spelling, code.Code(), response.Data, stdout.String(), stderr.String())
		}
		shimState, ok := response.Data["shim"].(map[string]any)
		if !ok || shimState["linked"] != true || shimState["owner"] != layout.InstallRoot() {
			t.Fatalf("status for %q did not report the canonical kb command owner: %#v", spelling, response.Data["shim"])
		}
	}
	registryPath := gateway.RegistryPath(home)
	activeReceiptPath := receipt.Path(physicalRoot)
	receiptBefore, err := os.ReadFile(activeReceiptPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registryPath, []byte(`{"schema":1,"roots":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"plan", "apply", "status", "doctor", "uninstall"} {
		args := []string{operation, "--platform-root", root, "--json"}
		if operation == "plan" || operation == "apply" {
			args = append(args, "--index", indexPath)
		}
		if operation == "uninstall" {
			args = append(args, "--yes")
		}
		var stdout, stderr bytes.Buffer
		code := clikitcommand.Execute(newRootCommandWithDependencyFactory(commandFactory), args, &stdout, &stderr)
		if code != diag.ExitCode(diag.New(contracts.CodeGatewayIndexUnavailable, "unavailable")) {
			t.Fatalf("schema-1 %s exit=%d, want %d: stdout=%s stderr=%s", operation, code.Code(), diag.ExitCode(diag.New(contracts.CodeGatewayIndexUnavailable, "unavailable")).Code(), stdout.String(), stderr.String())
		}
		var failureRecord struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &failureRecord); err != nil {
			t.Fatalf("schema-1 %s failure is not one JSON document: %v; %s", operation, err, stdout.String())
		}
		if failureRecord.Error.Code != contracts.CodeGatewayIndexUnavailable {
			t.Fatalf("schema-1 %s code = %q, want %s: %s", operation, failureRecord.Error.Code, contracts.CodeGatewayIndexUnavailable, stdout.String())
		}
		if current, err := os.ReadFile(registryPath); err != nil || string(current) != `{"schema":1,"roots":[]}` {
			t.Fatalf("schema-1 %s changed the read-only index: %s (%v)", operation, current, err)
		}
		if current, err := os.ReadFile(activeReceiptPath); err != nil || !bytes.Equal(current, receiptBefore) {
			t.Fatalf("schema-1 %s changed the installation receipt: %s (%v)", operation, current, err)
		}
	}
	var planOut, planErr bytes.Buffer
	planCode := clikitcommand.Execute(newRootCommand(), []string{"plan", "--json", "--index", indexPath, "--platform-root", root}, &planOut, &planErr)
	var failedPlan struct {
		Error struct {
			Code, Message, Hint string
		} `json:"error"`
	}
	if err := json.Unmarshal(planOut.Bytes(), &failedPlan); err != nil || planCode != diag.ExitCode(diag.New(contracts.CodeGatewayIndexUnavailable, "unavailable")) || failedPlan.Error.Code != contracts.CodeGatewayIndexUnavailable {
		t.Fatalf("schema-1 plan result code=%d output=%s stderr=%s decode=%v", planCode.Code(), planOut.String(), planErr.String(), err)
	}
	removeCommand := contracts.ShellCommand("rm", "--", registryPath)
	repairCommand := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root)
	if !strings.Contains(failedPlan.Error.Message, registryPath) || !strings.Contains(failedPlan.Error.Message, "unsupported schema 1") ||
		!strings.Contains(failedPlan.Error.Hint, removeCommand) || !strings.Contains(failedPlan.Error.Hint, repairCommand) {
		t.Fatalf("schema-1 diagnostic message/hint = %q / %q", failedPlan.Error.Message, failedPlan.Error.Hint)
	}
	before, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	var humanOut, humanErr bytes.Buffer
	if code := clikitcommand.Execute(newRootCommand(), []string{"plan", "--index", indexPath, "--platform-root", root}, &humanOut, &humanErr); code != diag.ExitCode(diag.New(contracts.CodeGatewayIndexUnavailable, "unavailable")) ||
		!strings.Contains(humanOut.String()+humanErr.String(), registryPath) || !strings.Contains(humanOut.String()+humanErr.String(), "unsupported schema 1") || !strings.Contains(humanOut.String()+humanErr.String(), repairCommand) {
		t.Fatalf("human schema-1 plan code/output/stderr = %d / %s / %s", code.Code(), humanOut.String(), humanErr.String())
	}
	after, err := os.ReadFile(registryPath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("read-only plan changed unsupported index: read error=%v", err)
	}
	if err := exec.Command("rm", "--", registryPath).Run(); err != nil {
		t.Fatalf("execute rendered recovery command %q: %v", removeCommand, err)
	}
	var repairOut, repairErr bytes.Buffer
	repairArgs := []string{"doctor", "--fix", "--platform-root", root, "--json"}
	if code := clikitcommand.Execute(newRootCommand(), repairArgs, &repairOut, &repairErr); code.Code() != 0 {
		t.Fatalf("execute rendered recovery command %q: exit=%d output=%s stderr=%s", repairCommand, code.Code(), repairOut.String(), repairErr.String())
	}
	roots, err := (gateway.Registry{Path: registryPath}).Read()
	active, receiptErr := receipt.Read(physicalRoot)
	if err != nil || receiptErr != nil || len(roots) != 1 || roots[0].InstallationID != active.InstallationID || roots[0].URL != fmt.Sprintf("http://127.0.0.1:%d", port) {
		t.Fatalf("Gateway index after rendered recovery = %#v, error=%v receipt=%v; want the installed row", roots, err, receiptErr)
	}
}

func TestPlanAutomaticallyAllocatesGatewayFromInstalledRootIndex(t *testing.T) {
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	rootA, rootB := filepath.Join(t.TempDir(), "platform-a"), filepath.Join(t.TempDir(), "platform-b")
	writeVersionedReceipt(t, rootA, contracts.InstallReceipt{ID: "registered-gateway-root",
		Plan: contracts.ResolvedInstallPlan{Host: &contracts.HostSpec{HealthURL: "http://127.0.0.1:4000/health"},
			ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"}}})
	registry := gateway.Registry{Path: filepath.Join(data, "kb-create", "gateway-roots.json")}
	if err := registry.Writer(gateway.Apply).Register(rootA, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: 4000}}}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "platform.adapterOptions", Path: "/platform/adapterOptions",
		Default: `{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:4000"}}}}`}}
	release, err := sealTestCatalog(t, source)
	if err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(t.TempDir(), "release-index.json")
	encoded, err := json.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(registry.Path)
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), []string{"plan", "--json", "--index", indexPath,
		"--platform-root", rootB}, &stdout, &stderr)
	after, err := os.ReadFile(registry.Path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("plan wrote registry: %v", err)
	}
	if code.Code() != 0 {
		t.Fatalf("automatic Gateway plan exit=%d: %s", code.Code(), stdout.String()+stderr.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	var statusOut, statusErr bytes.Buffer
	statusCode := clikitcommand.Execute(newRootCommand(), []string{"status", "--json", "--platform-root", rootA}, &statusOut, &statusErr)
	if statusCode.Code() != 0 {
		t.Fatalf("status failed: %s %s", statusOut.String(), statusErr.String())
	}
	afterStatus, err := os.ReadFile(registry.Path)
	if err != nil || !bytes.Equal(before, afterStatus) {
		t.Fatalf("status wrote registry: %v", err)
	}
	plan := payload.Data.Plan
	if plan.Request.GatewayURL != "http://127.0.0.1:4100" || plan.Host.HealthURL != "http://127.0.0.1:4100/health" ||
		plan.ServiceGraph.Services[0].Port != 4100 {
		t.Fatalf("automatic Gateway address not applied: %#v", plan)
	}
}

func TestRecordedGatewayURLKeepsUpdateAddressFromReceipt(t *testing.T) {
	active := contracts.InstallReceipt{Verification: contracts.Verification{HostHealthURL: "http://127.0.0.1:4100/health"}}
	if got := recordedGatewayURL(active); got != "http://127.0.0.1:4100" {
		t.Fatalf("receipt Gateway URL = %q", got)
	}
	active.Plan.Request.GatewayURL = "http://127.0.0.1:4200"
	if got := recordedGatewayURL(active); got != "http://127.0.0.1:4200" {
		t.Fatalf("request Gateway URL = %q, want stored origin", got)
	}
}

func TestHumanReleaseIndexFailurePrintsLoaderReason(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	path := filepath.Join(t.TempDir(), "missing-release-index.json")
	_, err := catalog.LoadFile(path)
	if err == nil {
		t.Fatal("expected release index read failure")
	}
	var output, stderr bytes.Buffer
	clikitcommand.Execute(newRootCommand(), []string{"install", "--index", path}, &output, &stderr)
	if !strings.Contains(output.String()+stderr.String(), "Release index read failed for "+path) {
		t.Fatalf("human output omitted loader reason: %s %s", output.String(), stderr.String())
	}
}

func TestReceiptArtifactIdentityFailureGivesExactReinstallCommand(t *testing.T) {
	index := filepath.Join(t.TempDir(), "release index.json")
	platformRoot := filepath.Join(t.TempDir(), "installed platform")
	original := diag.New(contracts.CodeArtifactIdentityInvalid, "the active receipt contains repeated artifacts")
	failure := receiptArtifactIdentityFailure(original, index, platformRoot)
	if failure == nil || failure.Code != contracts.CodeArtifactIdentityInvalid {
		t.Fatalf("identity failure = %#v", failure)
	}
	want := "Reinstall this platform with `" + contracts.ShellCommand("kb-create", "apply", "--index", index, "--platform-root", platformRoot) + "`."
	if failure.Hint != want {
		t.Fatalf("hint = %q, want %q", failure.Hint, want)
	}
}

// case: S-214.1
func TestWriteIndexFailureSerializesCanonicalDetails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-release-index.json")
	_, err := catalog.LoadFile(path)
	if err == nil {
		t.Fatal("expected release index read failure")
	}
	failure := indexFailure(err, "supply a valid index")
	if failure.Code != contracts.CodeReleaseIndexUnreadable || failure.Meta["gate"] != "read" ||
		failure.Meta["path"] != path || !strings.Contains(failure.Cause, "no such file or directory") {
		t.Fatalf("failure envelope omitted loader diagnostics: %#v", failure)
	}
}

// case: PC-001.4
func TestShimFailureNamesPathReasonAndRepairCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bin", "kb")
	failure := shimFailure(contracts.CodeApplyFailed, "/tmp/platform root", &shim.Failure{
		Path: path, Reason: "permission denied", Cause: os.ErrPermission,
	})
	if failure.Code != contracts.CodeApplyFailed || failure.Meta["path"] != path || failure.Meta["reason"] != "permission denied" {
		t.Fatalf("shim failure omitted its code, path, or filesystem reason: %#v", failure)
	}
	if !strings.Contains(failure.Hint, contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", "/tmp/platform root")) {
		t.Fatalf("shim failure omitted its repair command: %#v", failure)
	}
	if !strings.Contains(failure.Cause, path) || !strings.Contains(failure.Cause, "permission denied") {
		t.Fatalf("shim failure omitted its path and filesystem reason: %#v", failure)
	}
}

// case: PC-001.8
func TestPlanLeavesPlatformRootByteIdentical(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, "platform")
	if err := os.MkdirAll(root, 0o750); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(home, "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}
	source.Platforms[0].Host = testHostOnFreePort(t)
	release, err := sealTestCatalog(t, source)
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
	before := snapshotTree(t, root)
	_, failure, code, _ := executeForTest(t, operationTestSetup{Operation: "plan", Index: index, Direct: directRequest{PlatformRoot: root,
		PlatformVersion: "2.0.0", Policy: string(contracts.PolicyCompatible)}, JSON: true})
	if code != 0 || failure != nil {
		t.Fatalf("plan exit code = %d: %v", code, failure)
	}
	if after := snapshotTree(t, root); !bytes.Equal(before, after) {
		t.Fatalf("plan changed the platform root: before %q, after %q", before, after)
	}
	foreign := filepath.Join(root, "user-owned.txt")
	if err := os.WriteFile(foreign, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreignBefore := snapshotTree(t, root)
	_, failure, code, _ = executeForTest(t, operationTestSetup{Operation: "plan", Index: index, Direct: directRequest{PlatformRoot: root,
		PlatformVersion: "2.0.0", Policy: string(contracts.PolicyCompatible)}, JSON: true})
	if code == 0 || failure == nil || failure.Code != contracts.CodeInstallLayoutUnsupported {
		t.Fatalf("plan on a non-empty foreign root = code %d, diagnostic %#v", code, failure)
	}
	if after := snapshotTree(t, root); !bytes.Equal(foreignBefore, after) {
		t.Fatalf("plan changed a foreign target: before %q, after %q", foreignBefore, after)
	}
}

// case: PC-001.8
func TestUpdatePlanPreservesLivePlatformDatabaseFiles(t *testing.T) {
	inst := newInstallation(t)
	projection := contracts.PlatformDataRootPath()
	dataRoot := filepath.Join(inst.root, filepath.FromSlash(projection.StatePath))
	database := filepath.Join(dataRoot, "journey-plan.sqlite")
	files := startLiveSQLiteDatabase(t, database)
	before := make(map[string][]byte, len(files))
	for _, path := range files {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = content
	}

	index := filepath.Join(t.TempDir(), "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}
	source.Platforms[0].Host = testHostOnFreePort(t)
	release, err := sealTestCatalog(t, source)
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
	_, failure, code, output := executeForTest(t, operationTestSetup{Operation: "plan", Index: index, Direct: directRequest{
		PlatformRoot: inst.root, PlatformVersion: "2.0.0", Policy: string(contracts.PolicyCompatible),
	}, JSON: true})
	if code != 0 || failure != nil {
		t.Fatalf("update plan failed with live platform data: code=%d diagnostic=%#v output=%s", code, failure, output)
	}
	for _, path := range files {
		content, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(content, before[path]) {
			t.Errorf("planning changed %s: read error %v", filepath.Base(path), err)
		}
		if strings.Contains(output, filepath.Base(path)) {
			t.Errorf("plan reported platform data file %s as a change: %s", filepath.Base(path), output)
		}
	}
	err = filepath.WalkDir(filepath.Join(inst.root, "versions"), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil
		}
		for _, name := range files {
			if filepath.Base(path) == filepath.Base(name) {
				t.Errorf("plan copied platform data file into version root: %s", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func startLiveSQLiteDatabase(t *testing.T, database string) []string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(database), 0o700); err != nil {
		t.Fatal(err)
	}
	script := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("CREATE TABLE entries (value TEXT)")
c.execute("INSERT INTO entries VALUES ('live')")
c.commit()
print("READY", flush=True)
sys.stdin.readline()
c.close()`
	command := exec.Command("python3", "-u", "-c", script, database)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = io.WriteString(stdin, "stop\n")
		_ = stdin.Close()
		if err := command.Wait(); err != nil {
			t.Errorf("SQLite fixture process failed: %v; stderr: %s", err, stderr.String())
		}
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "READY" {
		t.Fatalf("SQLite fixture did not become ready: line=%q err=%v stderr=%s", line, err, stderr.String())
	}
	files := []string{database, database + "-wal", database + "-shm"}
	for _, path := range files {
		if info, err := os.Stat(path); err != nil || info.Size() == 0 {
			t.Fatalf("live SQLite file %s is missing or empty: %v", path, err)
		}
	}
	return files
}

func snapshotTree(t *testing.T, root string) []byte {
	t.Helper()
	var snapshot bytes.Buffer
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		fmt.Fprintf(&snapshot, "%s:%t:%o\n", relative, info.IsDir(), info.Mode())
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			snapshot.WriteString(target)
		}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			snapshot.Write(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot.Bytes()
}

func verifiedFixtureCatalog(t *testing.T, release catalog.Catalog) catalog.Verified {
	t.Helper()
	verified, err := catalog.VerifyCatalog(release)
	if err != nil {
		t.Fatal(err)
	}
	return verified
}

func verifiedFixtureCatalogFile(t *testing.T, path string) catalog.Verified {
	t.Helper()
	source, err := catalog.LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return verifiedFixtureCatalog(t, source)
}

type installArtifacts struct {
	root    string
	release catalog.Verified
}

func (a installArtifacts) Prepare(items []contracts.Artifact) (contracts.PreparedArtifacts, error) {
	return installPreparedArtifacts{install: func(progress func(string, bool) error) error {
		return a.InstallWithProgress(items, progress)
	}}, nil
}

type installPreparedArtifacts struct {
	install func(func(string, bool) error) error
}

func (p installPreparedArtifacts) Install(progress func(string, bool) error) error {
	return p.install(progress)
}
func (installPreparedArtifacts) Close() error { return nil }

func (a installArtifacts) Install(items []contracts.Artifact) error {
	return a.InstallWithProgress(items, nil)
}
func (a installArtifacts) InstallWithProgress(items []contracts.Artifact, progress func(string, bool) error) error {
	root, err := a.installRoot()
	if err != nil {
		return err
	}
	layout, err := versionroot.New(a.root)
	if err != nil {
		return err
	}
	cacheRoot, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		archive := testfixtures.PackageTarball(item.Package, item.Version, nil)
		archiveDigest := sha256.Sum256(archive)
		if hex.EncodeToString(archiveDigest[:]) != item.SHA256 {
			return fmt.Errorf("test package archive for %s@%s differs from sealed fixture sha256", item.Package, item.Version)
		}
		path := filepath.Join(cacheRoot, "packages", item.SHA256+".tgz")
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return err
		}
		if err := os.WriteFile(path, archive, 0o600); err != nil {
			return err
		}
	}
	if progress != nil {
		if err := progress("Download and verify artifacts", true); err != nil {
			return err
		}
		if err := progress("Download and verify artifacts", false); err != nil {
			return err
		}
		if err := progress("Install packages", true); err != nil {
			return err
		}
	}
	pnpm := artifacts.Pnpm{Root: root, CacheRoot: cacheRoot, PackageManagerRoot: layout.PackageManagerStateDir(), ReleaseCatalog: a.release}
	err = pnpm.Install(items)
	if progress != nil {
		progress("Install packages", false)
	}
	return err
}

func (a installArtifacts) installRoot() (string, error) {
	versions := filepath.Join(a.root, "versions")
	entries, err := os.ReadDir(versions)
	if os.IsNotExist(err) {
		return a.root, nil
	}
	if err != nil {
		return "", err
	}
	stages := make([]string, 0, 1)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".stage-") && entry.IsDir() {
			stages = append(stages, filepath.Join(versions, entry.Name()))
		}
	}
	if len(stages) == 1 {
		return stages[0], nil
	}
	return a.root, nil
}
func (installArtifacts) Restore(contracts.ResolvedInstallPlan, contracts.ResolvedInstallPlan) error {
	return nil
}

type installHost struct{}

func (installHost) Start(context.Context, contracts.HostSpec) (func() error, error) {
	return func() error { return nil }, nil
}

func installOutput(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "screen.txt")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return &bytes.Buffer{}, path
}

// case: PC-001.17, PC-001.18, S-261.7
func TestInstallCommandClassifiesInstallRootTargets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	index := filepath.Join(home, "release-index.json")
	source, err := catalog.LoadFile(filepath.Join("..", "..", "..", "..", "..", "e2e", "platform", "fixtures", "release-index-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	source.Provenance = nil
	graph := source.Platforms[0].Profiles["default"]
	defaultServices := append([]contracts.Service(nil), graph.Services...)
	baseGatewayPort := 0
	highestServicePort := 0
	for _, service := range graph.Services {
		if service.ID == "gateway" {
			baseGatewayPort = service.Port
		}
		if service.Port > highestServicePort {
			highestServicePort = service.Port
		}
	}
	if baseGatewayPort == 0 {
		t.Fatal("default service graph has no Gateway port")
	}
	source.Platforms[0].Host = testHostOnFreePortWithPortHeadroom(t, highestServicePort)
	serviceOffsets := make([]int, 0, len(graph.Services))
	for _, service := range graph.Services {
		if service.Port != 0 {
			serviceOffsets = append(serviceOffsets, service.Port-baseGatewayPort)
		}
	}
	release, err := sealTestCatalog(t, source)
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
	project := filepath.Join(home, "fresh-project")
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(home, "bin", "kb-create")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("launcher"), 0o700); err != nil {
		t.Fatal(err)
	}

	runInstall := func(t *testing.T, root string) (int, string) {
		t.Helper()
		gatewayPort := freeAllocatedGatewayPortWithOffsets(t, serviceOffsets...)
		if gatewayPort == baseGatewayPort {
			t.Fatalf("test Gateway allocation reused default port %d", baseGatewayPort)
		}
		gatewayURL := fmt.Sprintf("http://127.0.0.1:%d", gatewayPort)
		dependencyFactory := func(cmd *cobra.Command) commandDependencies {
			return commandDependencies{
				Runtime:       &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}},
				Marketplace:   recordingMarketplaceInstaller{},
				NodeCheck:     func() error { return nil },
				InstallInput:  strings.NewReader(strings.Repeat("\n", 12)),
				InstallOutput: clikitcommand.FromCommand(cmd).ProgressWriter(),
				ProjectRegistrar: func(_ string, path string) (projectRegistrationResult, error) {
					return projectRegistrationResult{ID: "prj_0123456789abcdef", CanonicalPath: path}, nil
				},
				Command: cmd, Executable: launcher,
			}
		}
		args := []string{"install", "--json", "--index", index, "--platform-root", root, "--gateway-url", gatewayURL,
			"--service-profile", "default", "--scenario", "explore", "--registry", "http://verdaccio:4873",
			"--project-root", project}
		var stdout, stderr bytes.Buffer
		code := clikitcommand.Execute(newRootCommandWithDependencyFactory(dependencyFactory), args, &stdout, &stderr)
		return code.Code(), stdout.String() + stderr.String()
	}

	for _, target := range []string{"missing", "empty"} {
		t.Run(target, func(t *testing.T) {
			root := filepath.Join(home, target)
			if target == "empty" {
				if err := os.Mkdir(root, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if code, output := runInstall(t, root); code != 0 {
				t.Fatalf("install target %s: code=%d output=%s", target, code, output)
			} else {
				layout, err := versionroot.New(root)
				if err != nil {
					t.Fatal(err)
				}
				installed, err := receipt.Read(layout.PlatformRoot())
				if err != nil {
					t.Fatal(err)
				}
				assertServicePortsAvoidDefaultGraph(t, installed.Plan.ServiceGraph, defaultServices)
			}
			layout, err := versionroot.New(root)
			if err != nil {
				t.Fatal(err)
			}
			if err := layout.Validate(); err != nil {
				t.Fatalf("install target %s did not become a valid versioned install: %v", target, err)
			}
		})
	}

	partialRoot := filepath.Join(home, "partial")
	partialLayout, err := versionroot.New(partialRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := partialLayout.StageInitial(); err != nil {
		t.Fatal(err)
	}
	if code, output := runInstall(t, partialRoot); code != 0 {
		t.Fatalf("install retry from a declared initial handoff: code=%d output=%s", code, output)
	} else {
		installedPartial, err := receipt.Read(partialLayout.PlatformRoot())
		if err != nil {
			t.Fatal(err)
		}
		assertServicePortsAvoidDefaultGraph(t, installedPartial.Plan.ServiceGraph, defaultServices)
	}
	if err := partialLayout.Validate(); err != nil {
		t.Fatalf("install retry did not recover the declared initial handoff: %v", err)
	}

	foreignRoot := filepath.Join(home, "foreign")
	if err := os.Mkdir(foreignRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	foreignFile := filepath.Join(foreignRoot, "keep.txt")
	if err := os.WriteFile(foreignFile, []byte("user data\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreignBefore := snapshotTree(t, foreignRoot)
	if code, output := runInstall(t, foreignRoot); code == 0 || !strings.Contains(output, contracts.CodeInstallLayoutUnsupported) {
		t.Fatalf("foreign target was not refused with KB_INSTALL_LAYOUT_UNSUPPORTED: code=%d output=%s", code, output)
	}
	if after := snapshotTree(t, foreignRoot); !bytes.Equal(after, foreignBefore) {
		t.Fatalf("foreign target changed: before=%q after=%q", foreignBefore, after)
	}

	for _, currentEntry := range []string{"file", "directory"} {
		t.Run("damaged-current-"+currentEntry, func(t *testing.T) {
			damagedRoot := filepath.Join(home, "damaged-"+currentEntry)
			if err := os.Mkdir(damagedRoot, 0o700); err != nil {
				t.Fatal(err)
			}
			current := filepath.Join(damagedRoot, "current")
			if currentEntry == "directory" {
				if err := os.Mkdir(current, 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(current, []byte("not a link\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			before := snapshotTree(t, damagedRoot)
			if code, output := runInstall(t, damagedRoot); code == 0 || !strings.Contains(output, contracts.CodeInstallLayoutUnsupported) {
				t.Fatalf("damaged target was not refused with KB_INSTALL_LAYOUT_UNSUPPORTED: code=%d output=%s", code, output)
			}
			if after := snapshotTree(t, damagedRoot); !bytes.Equal(after, before) {
				t.Fatalf("damaged target changed: before=%q after=%q", before, after)
			}
		})
	}
}

func TestInstallAndApplyArgvRefuseUnattributedRootsUnchanged(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	index := filepath.Join("..", "..", "..", "..", "..", "e2e", "platform", "fixtures", "release-index-v2.json")
	project := filepath.Join(home, "fresh-project")
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}

	targets := []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{"foreign preinstall scenario", func(t *testing.T, root string) {
			path := filepath.Join(root, "state", "scenarios", "foreign.json")
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("foreign bytes\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"ownership and versions without current", func(t *testing.T, root string) {
			if err := os.MkdirAll(filepath.Join(root, "versions", "1.0.0"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "ownership.json"), []byte(`{"schema":"kb.create.installation-owner/v1","installationId":"00112233445566778899aabbccddeeff"}`), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, target := range targets {
		t.Run(target.name, func(t *testing.T) {
			root := filepath.Join(home, strings.ReplaceAll(target.name, " ", "-"))
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			target.setup(t, root)
			before := snapshotTree(t, root)
			for _, operation := range []string{"install", "plan", "apply"} {
				args := []string{operation, "--json", "--index", index, "--platform-root", root,
					"--service-profile", "default", "--scenario", "commit", "--registry", "http://verdaccio:4873",
					"--project-root", project}
				var stdout, stderr bytes.Buffer
				code := clikitcommand.Execute(newRootCommand(), args, &stdout, &stderr)
				var payload map[string]any
				decodeErr := json.Unmarshal(stdout.Bytes(), &payload)
				if decodeErr != nil {
					firstRecord := strings.SplitN(stdout.String(), "\n", 2)[0]
					decodeErr = json.Unmarshal([]byte(firstRecord), &payload)
				}
				if decodeErr != nil {
					t.Fatalf("%s argv output is not JSON: %s stderr=%s: %v", operation, stdout.String(), stderr.String(), decodeErr)
				}
				if code.Code() == 0 || errorCode(payload) != contracts.CodeInstallLayoutUnsupported {
					t.Fatalf("%s argv refusal = exit %d, code %s, stdout=%s stderr=%s", operation, code.Code(), errorCode(payload), stdout.String(), stderr.String())
				}
				if after := snapshotTree(t, root); !bytes.Equal(after, before) {
					t.Fatalf("%s changed refused target: before=%q after=%q", operation, before, after)
				}
			}
		})
	}
}

// case: PC-001.10, PC-001.11, S-181.1
func TestExecuteShimOwnershipSurvivesOtherInstallationRemoval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	index := filepath.Join(home, "release-index.json")
	source, err := catalog.LoadFile(filepath.Join("..", "..", "..", "..", "..", "e2e", "platform", "fixtures", "release-index-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	source.Provenance = nil
	graph := source.Platforms[0].Profiles["default"]
	gatewayPort := 0
	for _, service := range graph.Services {
		if service.ID == "gateway" {
			gatewayPort = service.Port
		}
	}
	release, err := sealTestCatalog(t, source)
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
	launcherDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(launcherDir, 0o700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "kb-create")
	if err := os.WriteFile(launcher, []byte("test launcher"), 0o700); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(home, "project")
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	rootA := filepath.Join(home, "root-a")
	rootB := filepath.Join(home, "root-b")
	rootC := filepath.Join(home, "root-c")
	linkPath := shim.Path(launcher)
	var expectedTarget string
	run := func(root string, args ...string) string {
		t.Helper()
		depsFactory := func(cmd *cobra.Command) commandDependencies {
			var artifactRunner runtime.ArtifactInstaller
			if args[0] == "uninstall" {
				artifactRunner = &recordingInstaller{}
			} else {
				artifactRunner = installArtifacts{root: root, release: verifiedFixtureCatalogFile(t, index)}
			}
			return commandDependencies{Runtime: &runtime.Dependencies{Artifacts: artifactRunner, Host: installHost{}},
				Marketplace: recordingMarketplaceInstaller{},
				NodeCheck:   func() error { return nil }, InstallInput: strings.NewReader(strings.Repeat("\n", 12)),
				InstallOutput: clikitcommand.FromCommand(cmd).ProgressWriter(), Command: cmd, Executable: launcher,
				ProjectRegistrar: func(_ string, projectRoot string) (projectRegistrationResult, error) {
					return projectRegistrationResult{ID: "prj_fixture", CanonicalPath: projectRoot}, nil
				}}
		}
		var stdout, stderr bytes.Buffer
		code := clikitcommand.Execute(newRootCommandWithDependencyFactory(depsFactory), args, &stdout, &stderr)
		if code.Code() != 0 {
			t.Fatalf("Execute %q exited %d: stdout=%s stderr=%s", args, code.Code(), stdout.String(), stderr.String())
		}
		if root == rootA && args[0] == "uninstall" {
			if _, readErr := os.Readlink(linkPath); !os.IsNotExist(readErr) {
				t.Fatalf("owner uninstall left the kb link: %v", readErr)
			}
			return stdout.String()
		}
		if target, readErr := os.Readlink(linkPath); expectedTarget != "" && (readErr != nil || target != expectedTarget) {
			t.Fatalf("Execute %q changed kb link: before=%q after=%q error=%v", args, expectedTarget, target, readErr)
		} else if expectedTarget == "" && readErr == nil {
			expectedTarget = target
		}
		return stdout.String()
	}
	install := func(root string, linked bool, more ...string) {
		args := []string{"install", "--json", "--index", index, "--platform-root", root, "--service-profile", "default", "--scenario", "explore", "--registry", "http://127.0.0.1:4873"}
		args = append(args, more...)
		output := run(root, args...)
		layout, layoutErr := versionroot.New(rootA)
		if layoutErr != nil {
			t.Fatal(layoutErr)
		}
		canonicalOwner, canonicalErr := filepath.EvalSymlinks(layout.InstallRoot())
		if canonicalErr != nil {
			t.Fatal(canonicalErr)
		}
		if !strings.Contains(output, fmt.Sprintf(`"shim":{"linked":%t,"owner":"%s"}`, linked, canonicalOwner)) {
			t.Fatalf("install for %q did not report linked=%t and canonical owner %q: %s", root, linked, canonicalOwner, output)
		}
	}
	install(rootA, true)
	activeA, err := versionroot.New(rootA)
	if err != nil {
		t.Fatal(err)
	}
	cliEntry := filepath.Join(activeA.PlatformRoot(), "node_modules", "@kb-labs", "cli-bin", "dist", "bin.js")
	if err := os.WriteFile(cliEntry, []byte("process.stdout.write('root-a\\n')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	install(rootB, false)
	rootAReceipt, err := receipt.Read(platformRootForTest(t, rootA))
	if err != nil {
		t.Fatal(err)
	}
	rootBReceipt, err := receipt.Read(platformRootForTest(t, rootB))
	if err != nil {
		t.Fatal(err)
	}
	rootAPorts := make(map[string]int, len(rootAReceipt.Plan.ServiceGraph.Services))
	for _, service := range rootAReceipt.Plan.ServiceGraph.Services {
		rootAPorts[service.ID] = service.Port
	}
	for _, service := range rootBReceipt.Plan.ServiceGraph.Services {
		if service.Port == 0 {
			continue
		}
		if rootAPorts[service.ID] == 0 || service.Port != rootAPorts[service.ID]+100 {
			t.Fatalf("root-b service %s port = %d, root-a port = %d; registry allocation must shift the graph by 100", service.ID, service.Port, rootAPorts[service.ID])
		}
		if service.Port >= 32768 {
			t.Fatalf("root-b service %s port %d is inside the conventional Linux ephemeral range", service.ID, service.Port)
		}
	}
	var secondaryStatus struct {
		Data struct {
			Shim map[string]any `json:"shim"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(run(rootB, "status", "--platform-root", rootB, "--json")), &secondaryStatus); err != nil {
		t.Fatalf("decode secondary status: %v", err)
	}
	primaryLayout, err := versionroot.New(rootA)
	if err != nil {
		t.Fatal(err)
	}
	if secondaryStatus.Data.Shim["linked"] != false || secondaryStatus.Data.Shim["owner"] != primaryLayout.InstallRoot() {
		t.Fatalf("secondary status did not report the first install's command owner: %#v", secondaryStatus.Data.Shim)
	}
	install(rootC, false, "--gateway-url", fmt.Sprintf("http://127.0.0.1:%d", gatewayPort+200), "--project-root", project)

	activeRoot, err := activeA.Active()
	if err != nil {
		t.Fatal(err)
	}
	spellings := []string{rootA, activeA.PlatformRoot(), activeRoot}
	for _, spelling := range spellings {
		for _, operation := range []string{"plan", "update"} {
			args := []string{operation, "--json", "--index", index, "--platform-root", spelling, "--service-profile", "default", "--registry", "http://127.0.0.1:4873"}
			run(rootA, args...)
		}
	}

	ownerTarget := expectedTarget
	foreignTarget := filepath.Join(home, "unmanaged-kb-target")
	if err := os.WriteFile(foreignTarget, []byte("foreign shim target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(linkPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreignTarget, linkPath); err != nil {
		t.Fatal(err)
	}
	expectedTarget = foreignTarget
	for _, root := range []string{rootC, rootB} {
		layout, layoutErr := versionroot.New(root)
		if layoutErr != nil {
			t.Fatal(layoutErr)
		}
		spelling := layout.PlatformRoot()
		if root == rootC {
			spelling = root
		}
		args := []string{"uninstall", "--platform-root", spelling, "--yes", "--json", "--registry", "http://127.0.0.1:4873"}
		result := run(root, args...)
		if root == rootC {
			if !strings.Contains(result, `"shimAction": "left-foreign"`) || strings.Contains(result, "shimOwner") {
				t.Fatalf("uninstall did not report the unverified foreign shim without an owner claim: %s", result)
			}
			if err := os.Remove(linkPath); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(ownerTarget, linkPath); err != nil {
				t.Fatal(err)
			}
			expectedTarget = ownerTarget
		}
	}
	if target, err := os.Readlink(linkPath); err != nil || target != expectedTarget {
		t.Fatalf("owner link after secondary uninstalls = %q, %v; want %q", target, err, expectedTarget)
	}
	output, err := exec.Command(linkPath, "--help").CombinedOutput()
	if err != nil || !strings.Contains(string(output), "root-a") {
		t.Fatalf("kb did not run A after secondary uninstalls: output=%s error=%v", output, err)
	}
	ownerUninstall := []string{"uninstall", "--platform-root", activeRoot, "--yes", "--json", "--registry", "http://127.0.0.1:4873"}
	if result := run(rootA, ownerUninstall...); !strings.Contains(result, `"shimAction": "removed"`) {
		t.Fatalf("owner uninstall did not report shim removal: %s", result)
	}
}

func TestOwnershipPublicationErrorsHaveActionableEnvelopes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "kb-platform")
	conflict := unsupportedPlatformLayout(root, versionroot.ErrOwnershipPublicationConflict)
	installCommand := contracts.ShellCommand("kb-create", "install")
	if conflict.Code != contracts.CodeOperationInProgress || !strings.Contains(conflict.Hint, "Wait for the other install to finish") || !strings.Contains(conflict.Hint, installCommand) {
		t.Fatalf("publication conflict envelope = %#v", conflict)
	}
	stagingPath := filepath.Join(root, contracts.OwnershipRecordStagingPrefix()+"00112233445566778899aabbccddeeff")
	staging := unsupportedPlatformLayout(root, &versionroot.OwnershipStagingArtifactError{Path: stagingPath, Cause: errors.New("truncated record")})
	cleanupCommand := contracts.ShellCommand("rm", "--", stagingPath)
	if staging.Code != contracts.CodeInstallLayoutUnsupported || !strings.Contains(staging.Hint, stagingPath) || !strings.Contains(staging.Hint, cleanupCommand) {
		t.Fatalf("staging artifact envelope = %#v", staging)
	}
}

// case: PC-001.16, S-054.2
func TestInstallRunsInteractiveCommandWithDefaultsAndProgress(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	launcherBinary, fakehost := binaries(t)
	port := freeAllocatedGatewayPortWithOffsets(t, 100)
	root := filepath.Join(home, "kb-platform")
	index := filepath.Join(home, "release-index.json")
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = &contracts.HostSpec{Command: testExecutable, Args: []string{"-test.run=^TestHostExecLauncher$"},
		Env:       map[string]string{"KB_TEST_FAKEHOST": fakehost, "KB_TEST_FAKEHOST_PORT": fmt.Sprint(port)},
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5}
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0", Services: []contracts.Service{{ID: "gateway", Port: port}}}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`},
		{ID: "platform.adapterOptions", Path: "/platform/adapterOptions", Default: fmt.Sprintf(`{"serviceTransport":{"services":{"gateway":{"url":"http://127.0.0.1:%d"}}}}`, port)}}
	source.Plugins = []catalog.Component{{ID: "@kb-labs/commit", Version: "1.0.0", Package: "@kb/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}}
	release, err := sealTestCatalog(t, source)
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
	launcher := filepath.Join(home, "bin", "kb-create")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("launcher"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, outputPath := installOutput(t)
	var screen bytes.Buffer
	t.Cleanup(func() {
		runner, runnerErr := host.NewRunner(root)
		if runnerErr != nil {
			if _, statErr := os.Stat(filepath.Join(root, "current")); os.IsNotExist(statErr) {
				return
			}
			t.Errorf("load interactive-install test host runner: %v", runnerErr)
			return
		}
		command := hostCommand{PlatformRoot: root, Executable: launcherBinary, Version: buildVersion}
		if _, failure := command.stop(context.Background(), runner, runner.State); failure != nil {
			t.Errorf("stop interactive-install test host: %v", failure)
		}
	})
	_, failure, code, _ := executeForTest(t, operationTestSetup{Operation: "install", Index: index, Direct: directRequest{PlatformRoot: root}, Executable: launcher, InstallInput: strings.NewReader(strings.Repeat("\n", 12)), InstallOutput: &screen, RuntimeDeps: &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalogFile(t, index)}, Host: installedHostStarter{root: root, executable: launcherBinary}}, NodePreflight: func() error { return nil }})
	if code != 0 {
		t.Fatalf("exit code %d, failure=%v, screen:\n%s", code, failure, screen.String())
	}
	for _, expected := range []string{"Resolve (", "Download and verify artifacts (", "Install packages (", "Render config (", "Verify installation (", "Start host (", "Create kb shim (", "KB Labs is installed", contracts.ShellCommand("kb", "project", "add", "<path>")} {
		if !strings.Contains(screen.String(), expected) {
			t.Errorf("screen missing %q:\n%s", expected, screen.String())
		}
	}
	if strings.Contains(screen.String(), `{"ok"`) || strings.Contains(screen.String(), "goroutine ") || strings.Contains(screen.String(), "panic:") {
		t.Fatalf("human screen leaked JSON or stack trace:\n%s", screen.String())
	}
	if _, err := os.Stat(outputPath); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(filepath.Join(home, "bin", "kb")); err != nil || target != filepath.Join(platformRootForTest(t, root), ".kb", "v2", "bin", "kb") {
		t.Fatalf("kb shim target/error = %q / %v", target, err)
	}
	installedReceipt, err := receipt.Read(platformRootForTest(t, root))
	if err != nil {
		t.Fatal(err)
	}
	hasLauncherBinary := false
	for _, artifact := range installedReceipt.Plan.Artifacts {
		if artifact.Kind == "binary" && artifact.ID == "kb-create" {
			hasLauncherBinary = true
		}
	}
	if !hasLauncherBinary {
		t.Fatal("sealed install fixture did not resolve the shipped kb-create binary")
	}
	var doctorOutput, doctorError bytes.Buffer
	doctorCommand := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
		deps := productionCommandDependencies(cmd)
		deps.Executable = launcher
		return deps
	})
	doctorCode := clikitcommand.Execute(doctorCommand, []string{"doctor", "--platform-root", root, "--json"}, &doctorOutput, &doctorError)
	if doctorCode.Code() != 0 {
		t.Fatalf("automatic doctor after sealed install exited %d: stdout=%s stderr=%s", doctorCode.Code(), doctorOutput.String(), doctorError.String())
	}
	var doctorResponse struct {
		OK   bool `json:"ok"`
		Data struct {
			Findings []any `json:"findings"`
		} `json:"data"`
	}
	if err := json.Unmarshal(doctorOutput.Bytes(), &doctorResponse); err != nil || !doctorResponse.OK || len(doctorResponse.Data.Findings) != 0 {
		t.Fatalf("automatic doctor after clean sealed install should have no findings: err=%v stdout=%s", err, doctorOutput.String())
	}
	secondaryRoot := filepath.Join(home, "kb-platform-secondary")
	_, _, secondaryCode, secondaryText := executeForTest(t, operationTestSetup{Operation: "apply", Index: index,
		Direct:     directRequest{PlatformRoot: secondaryRoot, PlatformChannel: "stable", ServiceProfile: "default", Policy: "compatible"},
		Executable: launcher, RuntimeDeps: &runtime.Dependencies{Artifacts: installArtifacts{root: secondaryRoot, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}},
		NodePreflight: func() error { return nil }, JSON: true,
	})
	if secondaryCode != 0 {
		t.Fatalf("secondary no-flag apply exit %d: %s", secondaryCode, secondaryText)
	}
	secondaryReceipt, err := receipt.Read(platformRootForTest(t, secondaryRoot))
	if err != nil || secondaryReceipt.Verification.HostHealthURL != fmt.Sprintf("http://127.0.0.1:%d/health", port+100) {
		t.Fatalf("secondary receipt Gateway = %q, error=%v; want next 100-port offset", secondaryReceipt.Verification.HostHealthURL, err)
	}
	registry, err := (gateway.Registry{Path: gateway.RegistryPath(home)}).Read()
	if err != nil || len(registry) != 2 {
		t.Fatalf("registered Gateway roots = %#v, error=%v", registry, err)
	}
}

// case: S-187.6
func TestLocalProjectRegistrationUsesHostProjectAPIWithoutCredentials(t *testing.T) {
	project := t.TempDir()
	root := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/projects" || r.Header.Get("Authorization") != "" {
			t.Errorf("request path/auth = %s / %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"ok":true,"data":{"id":"prj_0123456789abcdef","path":%q,"alreadyExisted":false}}`, project)
	}))
	defer server.Close()
	active := contracts.InstallReceipt{ID: "local-receipt", Plan: contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{Values: map[string]string{
		"gateway.access.mode": `"local"`,
	}}}, Verification: contracts.Verification{HostHealthURL: server.URL + "/health"}}
	if err := receipt.Write(root, active); err != nil {
		t.Fatal(err)
	}
	projectID, err := registerProject(root, project)
	if err != nil || projectID.ID != "prj_0123456789abcdef" || projectID.CanonicalPath != project || projectID.AlreadyExisted {
		t.Fatalf("project registration/error = %#v / %v", projectID, err)
	}
}

// case: S-187.4
func TestInstallRegistersSelectedProjectAndReportsBothResults(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	platformRoot := filepath.Join(home, "kb-platform")
	projectTarget := filepath.Join(home, "work", "project")
	projectRoot := filepath.Join(home, "work", "project-alias")
	if err := os.MkdirAll(projectTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(projectTarget, projectRoot); err != nil {
		t.Fatal(err)
	}
	selectedProjectPath, err := contracts.AbsolutePath(projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	canonicalProjectRoot, err := filepath.EvalSymlinks(projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(home, "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = testHostOnFreePort(t)
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`}}
	source.Plugins = []catalog.Component{{ID: "@kb-labs/commit", Version: "1.0.0", Package: "@kb/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}}
	release, err := sealTestCatalog(t, source)
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
	launcher := filepath.Join(home, "bin", "kb-create")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("launcher"), 0o755); err != nil {
		t.Fatal(err)
	}
	var registered string
	var screen bytes.Buffer
	installData, failure, code, _ := executeForTest(t, operationTestSetup{
		Operation: "install", Index: index, Direct: directRequest{PlatformRoot: platformRoot, ProjectRoot: projectRoot},
		Executable: launcher, InstallInput: strings.NewReader(strings.Repeat("\n", 12)), InstallOutput: &screen,
		RuntimeDeps:   &runtime.Dependencies{Artifacts: installArtifacts{root: platformRoot, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}},
		Marketplace:   recordingMarketplaceInstaller{},
		NodePreflight: func() error { return nil },
		ProjectRegistrar: func(path string) (projectRegistrationResult, error) {
			registered = path
			return projectRegistrationResult{ID: "prj_0123456789abcdef", CanonicalPath: canonicalProjectRoot}, nil
		},
	})
	if code != 0 || registered != selectedProjectPath {
		t.Fatalf("code=%d failure=%v cause=%q registered=%q screen:\n%s", code, failure, failure.Cause, registered, screen.String())
	}
	for _, expected := range []string{selectedProjectPath, canonicalProjectRoot, "prj_0123456789abcdef", "Verification: platform installed", contracts.ShellCommand("kb", "project", "show", canonicalProjectRoot)} {
		if !strings.Contains(screen.String(), expected) {
			t.Errorf("screen missing %q:\n%s", expected, screen.String())
		}
	}
	installedResult, ok := installData.(applyCommandResult)
	if !ok || installedResult.Receipt.ProjectSelectedPath != selectedProjectPath || installedResult.Receipt.ProjectID != "prj_0123456789abcdef" || installedResult.Receipt.ProjectCanonicalPath != canonicalProjectRoot {
		t.Fatalf("install result did not carry registry project identity: %#v", installData)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".kb")); !os.IsNotExist(err) {
		t.Fatalf("installer created project files: %v", err)
	}

	failedRoot := filepath.Join(home, "kb-platform-registration-failure")
	var failedScreen bytes.Buffer
	_, failure, failedCode, _ := executeForTest(t, operationTestSetup{
		Operation: "install", Index: index,
		Direct:        directRequest{PlatformRoot: failedRoot, ProjectRoot: projectRoot},
		InstallInput:  strings.NewReader(strings.Repeat("\n", 12)),
		InstallOutput: &failedScreen,
		RuntimeDeps:   &runtime.Dependencies{Artifacts: installArtifacts{root: failedRoot, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}},
		Marketplace:   recordingMarketplaceInstaller{},
		NodePreflight: func() error { return nil },
		ProjectRegistrar: func(string) (projectRegistrationResult, error) {
			return projectRegistrationResult{}, errors.New("project registry unavailable")
		},
	})
	if failedCode != 1 || failure == nil || failure.Code != contracts.CodeProjectRegistrationFailed ||
		failure.Message != "The platform is installed, but the selected project is not registered." ||
		failure.Meta["causeCode"] != contracts.CodeProjectRegistrationFailed ||
		!strings.Contains(failure.Hint, contracts.ShellCommand("kb", "project", "add", projectRoot)) {
		t.Fatalf("project registration failure = code %d, output %#v", failedCode, failure)
	}
	if _, err := os.Stat(receipt.Path(platformRootForTest(t, failedRoot))); err != nil {
		t.Fatalf("late registration failure should retain the completed platform install receipt: %v", err)
	}
}

// case: S-187.7
func TestHumanInstallRejectsMissingProjectBeforeCreatingPlatformRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	platformRoot := filepath.Join(home, "platform")
	projectRoot := filepath.Join(home, "missing-project")
	launcher := filepath.Join(home, ".local", "bin", "kb-create")
	registrarCalled := false
	_, failure, code, _ := executeForTest(t, operationTestSetup{
		Operation: "install", Index: index,
		Direct:     directRequest{PlatformRoot: platformRoot, ProjectRoot: projectRoot},
		Executable: launcher,
		ProjectRegistrar: func(string) (projectRegistrationResult, error) {
			registrarCalled = true
			return projectRegistrationResult{}, nil
		},
	})
	if code != 2 || failure == nil || failure.Code != contracts.CodeInputRequired || !strings.Contains(failure.Hint, contracts.ShellCommand("mkdir", "-p", projectRoot)) {
		t.Fatalf("install missing-project validation = exit %d, failure %#v", code, failure)
	}
	if _, err := os.Stat(platformRoot); !os.IsNotExist(err) {
		t.Fatalf("invalid project selection created platform root: %v", err)
	}
	if _, err := os.Stat(receipt.Path(platformRoot)); !os.IsNotExist(err) {
		t.Fatalf("invalid project selection created install receipt: %v", err)
	}
	if _, err := os.Lstat(shim.Path(launcher)); !os.IsNotExist(err) {
		t.Fatalf("invalid project selection created launcher shim: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".kb", "projects.json")); !os.IsNotExist(err) {
		t.Fatalf("invalid project selection created project registry state: %v", err)
	}
	if registrarCalled {
		t.Fatal("invalid project selection called the project registrar")
	}
}

// case: S-187.8
func TestApplyRejectsMissingProjectBeforeSavingScenarioAnswers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	platformRoot := filepath.Join(home, "platform")
	projectRoot := filepath.Join(home, "missing-project")
	_, failure, code, _ := executeForTest(t, operationTestSetup{
		Operation: "apply", Index: index, PlatformRoot: platformRoot,
		Direct:     directRequest{PlatformRoot: platformRoot, ProjectRoot: projectRoot},
		ScenarioID: "custom", ScenarioAnswers: `{"access.mode":"local"}`,
	})
	if code != 2 || failure == nil || failure.Code != contracts.CodeInputRequired || !strings.Contains(failure.Hint, contracts.ShellCommand("mkdir", "-p", projectRoot)) {
		t.Fatalf("apply missing-project validation = exit %d, failure %#v", code, failure)
	}
	if _, err := os.Stat(platformRoot); !os.IsNotExist(err) {
		t.Fatalf("invalid project selection saved scenario answers or created platform root: %v", err)
	}
	for _, statePath := range []string{
		filepath.Join(platformRoot, ".kb", "v2", "scenarios", "custom.json"),
		filepath.Join(platformRoot, ".kb", "v2", "scenarios", "custom.json.tmp"),
	} {
		if _, err := os.Stat(statePath); !os.IsNotExist(err) {
			t.Fatalf("invalid project selection saved scenario state at %s: %v", statePath, err)
		}
	}
}

func writeJSONInstallFixture(t *testing.T, home string) string {
	t.Helper()
	index := filepath.Join(home, "release-index.json")
	source := testReleaseCatalog(t, "2.0.0")
	source.Platforms[0].Host = testHostOnFreePortWithPortHeadroom(t, 100)
	source.Platforms[0].Profiles = map[string]contracts.ServiceGraph{"default": {PlatformVersion: "2.0.0"}}
	source.Platforms[0].Config = []catalog.ConfigRequirement{{ID: "gateway.access.mode", Path: "/gateway/access/mode", Default: `"local"`}}
	source.Adapters = []catalog.Adapter{{Component: catalog.Component{ID: "sqlite-stores", Version: "1.0.0",
		Package: "@kb/sqlite-stores", Tarball: "https://example.test/sqlite-stores.tgz", SHA256: "sqlite-stores"},
		Provides: []string{"documentDatabase"}}}
	release, err := sealTestCatalog(t, source)
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
	return index
}

// case: S-187.6
func TestJSONScenarioInstallRegistersCanonicalProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	root, project := filepath.Join(home, "platform"), filepath.Join(home, "project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := contracts.AbsolutePath(project)
	if err != nil {
		t.Fatal(err)
	}
	registry := map[string]string{}
	_, failure, code, raw := executeForTest(t, operationTestSetup{
		Operation: "install", JSON: true, Index: index, ScenarioID: "custom",
		ScenarioAnswers: `{"access.mode":"local"}`,
		Direct:          directRequest{PlatformRoot: root, ProjectRoot: project},
		RuntimeDeps:     &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}},
		NodePreflight:   func() error { return nil },
		ProjectRegistrar: func(path string) (projectRegistrationResult, error) {
			registry[path] = "prj_0123456789abcdef"
			return projectRegistrationResult{ID: registry[path], CanonicalPath: canonical}, nil
		},
	})
	if code != 0 || registry[canonical] != "prj_0123456789abcdef" {
		t.Fatalf("JSON scenario install exit=%d registry=%v failure=%v output=%s", code, registry, failure, raw)
	}
}

// case: S-039.1
func TestApplyCommandForwardsScenarioAnswersBeforeMutation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	root := filepath.Join(home, "platform")
	command := newRootCommandWithDependencyFactory(func(cmd *cobra.Command) commandDependencies {
		deps := productionCommandDependencies(cmd)
		deps.NodeCheck = func() error { return nil }
		deps.Runtime = &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}}
		return deps
	})
	var stdout, stderr bytes.Buffer
	code := clikitcommand.Execute(command, []string{"apply", "--json", "--index", index,
		"--platform-root", root, "--scenario", "commit", "--scenario-answers", "{invalid"}, &stdout, &stderr)
	var response struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Cause   string `json:"cause"`
		} `json:"error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatalf("apply scenario validation is not one JSON document: %v; stdout=%s stderr=%s", err, stdout.String(), stderr.String())
	}
	if code.Code() == 0 || response.OK || response.Error.Code != contracts.CodeScenarioInvalid ||
		!strings.Contains(response.Error.Cause, "decode scenario answers") {
		t.Fatalf("apply scenario validation exit=%d envelope=%#v stdout=%s stderr=%s", code.Code(), response, stdout.String(), stderr.String())
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("invalid scenario answers mutated platform root %q: stat error=%v", root, err)
	}
}

func TestApplyCommandBoundarySerializesOneJSONDocument(t *testing.T) {
	descriptor, ok := lookupOperationDescriptor("apply")
	if !ok || descriptor.JSONStream {
		t.Fatal("apply must use the single-document JSON boundary")
	}
	descriptor.Handler = func(context.Context, *cobra.Command, *commandFlagReader, commandDependencies) (any, *diag.Diag) {
		return applyCommandResult{Operation: "apply"}, nil
	}
	root := &cobra.Command{Use: "kb-create"}
	child := &cobra.Command{Use: "apply", RunE: func(cmd *cobra.Command, _ []string) error {
		return callDescriptor(cmd, descriptor, nil, commandDependencies{Command: cmd})
	}}
	child.Flags().Bool("json", false, "emit machine-readable output")
	root.AddCommand(child)
	var stdout, stderr bytes.Buffer
	if code := clikitcommand.Execute(root, []string{"apply", "--json"}, &stdout, &stderr); code.Code() != 0 {
		t.Fatalf("apply command boundary exit=%d stdout=%s stderr=%s", code.Code(), stdout.String(), stderr.String())
	}
	var response struct {
		OK   bool               `json:"ok"`
		Data applyCommandResult `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatalf("apply stdout is not one JSON document: %v: %s", err, stdout.String())
	}
	if !response.OK || response.Data.Operation != "apply" {
		t.Fatalf("apply JSON document is incomplete: %s", stdout.String())
	}
}

// case: S-039.4
func TestApplyRequestValidationHintUsesActualRetryArguments(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	requestPath := filepath.Join(home, "invalid request.json")
	if err := os.WriteFile(requestPath, []byte(`{"schema":"kb.create/v2","platformRoot":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"apply", "--index", index, "--input", requestPath, "--json"}
	factory := func(*cobra.Command) commandDependencies {
		return commandDependencies{NodeCheck: func() error { return nil }, Runtime: &runtime.Dependencies{Artifacts: installArtifacts{root: filepath.Join(home, "platform"), release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}}}
	}
	var output, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &output, &stderr)
	var envelope struct {
		Error struct {
			Code string `json:"code"`
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(output.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if code.Code() == 0 || envelope.Error.Code != contracts.CodeInputRequired {
		t.Fatalf("exit=%d output=%s", code.Code(), output.String())
	}
	want := contracts.ShellCommand(append([]string{"kb-create"}, args...)...)
	if !strings.Contains(envelope.Error.Hint, want) || !strings.Contains(envelope.Error.Hint, "Set `platformRoot` to a non-empty directory") {
		t.Fatalf("validation hint = %q, want validation guidance and retry %q", envelope.Error.Hint, want)
	}
}

func TestApplyRequestValidationHintDoesNotEchoCredentialValues(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	_, failure, code, output := executeForTest(t, operationTestSetup{
		Operation: "apply", Index: index, PlatformRoot: filepath.Join(home, "platform"),
		ScenarioID: "explore", ScenarioAnswers: `{"admin.password":"scenario-secret"}`,
		Direct:        directRequest{GatewayURL: "http://operator:gateway-secret@127.0.0.1:4100"},
		NodePreflight: func() error { return nil },
	})
	if failure == nil || code == 0 {
		t.Fatalf("invalid request exit=%d failure=%v output=%s", code, failure, output)
	}
	if strings.Contains(failure.Hint, "gateway-secret") || strings.Contains(failure.Hint, "scenario-secret") {
		t.Fatalf("retry hint exposed credential values: %q", failure.Hint)
	}
}

// case: S-187.6
func TestJSONRequestFileInstallRegistersCanonicalProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	index := writeJSONInstallFixture(t, home)
	root, project := filepath.Join(home, "platform"), filepath.Join(home, "project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := contracts.AbsolutePath(project)
	if err != nil {
		t.Fatal(err)
	}
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root,
		ProjectRoot: project, ServiceProfile: "default", Source: contracts.SourceRegistry}
	requestData, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(home, "request.json")
	if err := os.WriteFile(requestPath, requestData, 0o600); err != nil {
		t.Fatal(err)
	}
	registry := map[string]string{}
	_, failure, code, raw := executeForTest(t, operationTestSetup{
		Operation: "install", JSON: true, Index: index, Input: requestPath,
		RuntimeDeps:   &runtime.Dependencies{Artifacts: installArtifacts{root: root, release: verifiedFixtureCatalogFile(t, index)}, Host: installHost{}},
		NodePreflight: func() error { return nil },
		ProjectRegistrar: func(path string) (projectRegistrationResult, error) {
			registry[path] = "prj_0123456789abcdef"
			return projectRegistrationResult{ID: registry[path], CanonicalPath: canonical}, nil
		},
	})
	if code != 0 || registry[canonical] != "prj_0123456789abcdef" {
		t.Fatalf("JSON request install exit=%d registry=%v failure=%v output=%s", code, registry, failure, raw)
	}
}

func TestInstallEarlyFailuresUseDiagRendering(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, failure, code, _ := executeForTest(t, operationTestSetup{Operation: "install", Index: filepath.Join(t.TempDir(), "missing.json"), NodePreflight: func() error { return nil }})
	if code != 2 || failure == nil || failure.Code != contracts.CodeReleaseIndexUnreadable || failure.Hint == "" {
		t.Fatalf("code/failure = %d / %#v", code, failure)
	}
}

func TestInstallChecksNodeBeforeQuestions(t *testing.T) {
	_, path := installOutput(t)
	var screen bytes.Buffer
	_, failure, code, _ := executeForTest(t, operationTestSetup{Operation: "install", InstallInput: strings.NewReader("\n"), InstallOutput: &screen, NodePreflight: func() error { return errors.New("node missing") }})
	if code != 1 || failure == nil || failure.Code != "KB_INSTALL_NODE_MISSING" || strings.Contains(screen.String(), "Platform channel") {
		t.Fatalf("code/failure/output = %d / %#v / %s", code, failure, screen.String())
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestApplyReportsNodeVersionCodeBeforeResolution(t *testing.T) {
	_, failure, code, _ := executeForTest(t, operationTestSetup{Operation: "apply", NodePreflight: func() error { return sharedtoolchain.ValidateNode("v22.11.0") }})
	if failure == nil {
		t.Fatalf("expected Node version failure, exit=%d", code)
	}
	if code != 1 || failure.Code != "KB_NODE_VERSION_UNSUPPORTED" || strings.Contains(fmt.Sprint(failure), "KB_INSTALL_INPUT_REQUIRED") {
		t.Fatalf("code/output = %d / %#v", code, failure)
	}
	entry, ok := diag.LookupCatalog(failure.Code)
	if !ok {
		t.Fatal("Node policy error is absent from the catalog")
	}
	values := map[string]string{"requiredMajor": fmt.Sprint(sharedtoolchain.SupportedNodeMajor), "actualVersion": "22.11.0"}
	expected, err := diag.FromCatalog(entry.Code, values)
	if err != nil {
		t.Fatal(err)
	}
	expectedEnvelope, err := diag.ToEnvelope(expected)
	if err != nil {
		t.Fatal(err)
	}
	actualEnvelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatal(err)
	}
	if actualEnvelope.Hint != expectedEnvelope.Hint {
		t.Fatalf("hint = %q; want contract-checked catalog hint %q", actualEnvelope.Hint, expectedEnvelope.Hint)
	}
}

func TestHumanProgressUsesElapsedPhaseEvents(t *testing.T) {
	output := &bytes.Buffer{}
	p := &humanProgress{out: output, started: map[string]time.Time{}}
	p.started["Install packages"] = time.Now().Add(-time.Millisecond)
	if err := p.Emit(runtime.ProgressEvent{Phase: "Install packages"}); err != nil {
		t.Fatal(err)
	}
	data := output.String()
	if !strings.Contains(data, "Install packages") || !strings.Contains(data, "ms)") {
		t.Fatalf("progress output = %s", data)
	}
}

type writeFailure struct{ err error }

func (failure writeFailure) Write([]byte) (int, error) { return 0, failure.err }

func TestStreamProgressPropagatesWriterFailure(t *testing.T) {
	want := errors.New("closed stream")
	progress := streamProgress{writer: stream.New(writeFailure{err: want})}
	if err := progress.Emit(runtime.ProgressEvent{Phase: "Install packages", Start: true}); !errors.Is(err, want) {
		t.Fatalf("stream progress error = %v, want %v", err, want)
	}
}

func TestHumanProgressPropagatesWriterFailure(t *testing.T) {
	want := errors.New("closed terminal")
	progress := &humanProgress{out: writeFailure{err: want}, started: map[string]time.Time{}}
	if err := progress.Emit(runtime.ProgressEvent{Phase: "Install packages", Start: true}); !errors.Is(err, want) {
		t.Fatalf("human progress error = %v, want %v", err, want)
	}
}

func testHost() *contracts.HostSpec {
	return &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}
}

func testHostOnFreePort(t *testing.T) *contracts.HostSpec {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port)}
}

func testHostOnFreePortWithPortHeadroom(t *testing.T, headroom int) *contracts.HostSpec {
	t.Helper()
	listener := testListenerWithPortHeadroom(t, headroom)
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return &contracts.HostSpec{Command: "kb-host", HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port)}
}

func testListenerWithPortHeadroom(t *testing.T, headroom int) net.Listener {
	t.Helper()
	for range 128 {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		if port+headroom <= 65535 {
			return listener
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	}
	for port := 65535 - headroom; port >= 1024; port-- {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			return listener
		}
	}
	t.Fatal("could not reserve a loopback port with the required allocation headroom")
	return nil
}

func sealTestCatalog(t *testing.T, source catalog.Catalog) (catalog.Catalog, error) {
	t.Helper()
	withProvenance, err := testfixtures.SealCatalog(source)
	if err != nil {
		return catalog.Catalog{}, err
	}
	sealed, err := catalog.Seal(withProvenance)
	if err != nil {
		return catalog.Catalog{}, err
	}
	return sealed, nil
}

func testReleaseCatalog(t *testing.T, platformVersion string) catalog.Catalog {
	t.Helper()
	data := testfixtures.ReleaseIndexJSON(platformVersion, platformVersion, goruntime.GOOS, goruntime.GOARCH)
	var source catalog.Catalog
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].Members = []catalog.Component{{ID: "cli-bin", Version: platformVersion, Package: "@kb-labs/cli-bin",
		Tarball: "https://example.test/cli-bin.tgz", SHA256: "cli-bin"}}
	sealed, err := testfixtures.SealCatalog(source)
	if err != nil {
		t.Fatalf("seal command release fixture: %v", err)
	}
	return sealed
}

func TestParseProvidersSupportsCommaSeparatedPreferences(t *testing.T) {
	got, err := parseProviders([]string{"storage=disk-io-storage, cache=state-broker"})
	if err != nil || got["storage"] != "disk-io-storage" || got["cache"] != "state-broker" {
		t.Fatalf("providers/error = %#v / %v", got, err)
	}
	if _, err := parseProviders([]string{"storage=disk,storage=other"}); err == nil {
		t.Fatal("expected duplicate capability to fail")
	}
}

// case: S-179.25
func TestParseProvidersRejectsEmptyItems(t *testing.T) {
	if _, err := parseProviders([]string{"", "storage=disk-io-storage"}); err == nil {
		t.Fatal("expected an empty repeated provider item to fail")
	}
	if values, err := parseProviders(nil); err != nil || len(values) != 0 {
		t.Fatalf("no provider input = %#v / %v; want an empty preference set", values, err)
	}
}

// case: S-179.25
func TestExecuteResetsRepeatedProviderFlagBetweenInvocations(t *testing.T) {
	var observed []string
	root := newRootCommandWithDependencyFactory(func(command *cobra.Command) commandDependencies {
		provider := command.Flags().Lookup("provider")
		if provider == nil {
			t.Error("actual kb-create command did not register --provider")
		} else {
			observed = append(observed, provider.Value.String())
		}
		return commandDependencies{}
	})

	for _, args := range [][]string{
		{"plan", "--provider", "storage=first", "--json"},
		{"plan", "--provider", "cache=second", "--json"},
	} {
		var stdout, stderr bytes.Buffer
		clikitcommand.Execute(root, args, &stdout, &stderr)
	}
	if !reflect.DeepEqual(observed, []string{"storage=first", "cache=second"}) {
		t.Fatalf("actual kb-create provider values by invocation = %#v; want only each invocation's non-empty values", observed)
	}
}

func TestHelpListsRegisteredCommandsAndFlags(t *testing.T) {
	root := newRootCommand()
	var output bytes.Buffer
	root.SetOut(&output)
	if err := root.Help(); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, expected := range []string{"install", "Install KB Labs interactively", "apply"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("help is missing %q: %s", expected, text)
		}
	}
	if strings.Contains(text, "--provider") {
		t.Fatalf("root help includes command-local --provider: %s", text)
	}
	install := findCommand(root, "kb-create install")
	var installHelp bytes.Buffer
	install.SetOut(&installHelp)
	if err := install.Help(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(installHelp.String(), "--provider") {
		t.Fatalf("install help is missing --provider: %s", installHelp.String())
	}
}

func TestSavedReleaseIndexUsesLauncherDataDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_DATA_HOME", "")
	if got, want := savedReleaseIndex(home), filepath.Join(home, ".local", "share", "kb-create", "release-index.json"); got != want {
		t.Fatalf("default = %q, want %q", got, want)
	}
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	if got, want := savedReleaseIndex(home), filepath.Join(data, "kb-create", "release-index.json"); got != want {
		t.Fatalf("XDG = %q, want %q", got, want)
	}
}

func TestStatusDoesNotWriteGatewayRegistry(t *testing.T) {
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	root := filepath.Join(t.TempDir(), "platform")
	writeVersionedReceipt(t, root, contracts.InstallReceipt{ID: "status-gateway-root", Plan: contracts.ResolvedInstallPlan{
		Host:         &contracts.HostSpec{HealthURL: "http://127.0.0.1:4000/health"},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0"},
	}})
	registry := gateway.Registry{Path: gateway.RegistryPath("")}
	if err := registry.Writer(gateway.Apply).Register(root, "http://127.0.0.1:4000"); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(registry.Path)
	if err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), []string{"status", "--json", "--platform-root", root}, &out, &stderr)
	if code.Code() != 0 {
		t.Fatalf("status failed: %s %s", out.String(), stderr.String())
	}
	after, err := os.ReadFile(registry.Path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("status wrote registry: %v", err)
	}
}
