//go:build !windows

package v2cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/swap"
)

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

// versionedReceipt is the receipt of one platform version whose host is the
// fake host on the given port.
func versionedReceipt(t *testing.T, version string, port int, hostArgs ...string) contracts.InstallReceipt {
	t.Helper()
	_, fakehost := binaries(t)
	spec := &contracts.HostSpec{
		Command: fakehost, Args: append([]string{"-port", fmt.Sprint(port)}, hostArgs...),
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 5,
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, ServiceGraph: contracts.ServiceGraph{PlatformVersion: version}, Host: spec}
	return contracts.InstallReceipt{ID: "receipt-" + version, Plan: plan}
}

func (i installation) lifecycleHost() lifecycleHost {
	return lifecycleHost{command: hostCommand{PlatformRoot: i.root, Executable: i.launcher, Version: "test"}, state: host.State{Dir: i.state}}
}

// swapTo replaces the installation with next around the host, the way
// runUpdate does, and returns swap's outcome.
func (i installation) swapTo(t *testing.T, next contracts.InstallReceipt) (swap.Outcome, error) {
	t.Helper()
	return swap.Run(context.Background(), i.lifecycleHost(), swap.Operation{
		Name: "update", PreviousVersion: "1.0.0",
		Change: func(context.Context, bool) (string, error) {
			snapshot, err := lifecycle.Mutate(i.root, time.Now().UTC(), func() error { return receipt.Write(i.root, next) }, nil, nil)
			return snapshot.ID, err
		},
		Restore: func(_ context.Context, id string) error {
			_, err := lifecycle.Rollback(i.root, id, nil)
			return err
		},
	})
}

func (i installation) hostState(t *testing.T) (state string, healthURL string) {
	t.Helper()
	status, _, raw := i.run("status")
	hostStatus, _ := status["host"].(map[string]any)
	if hostStatus == nil {
		t.Fatalf("status: %s", raw)
	}
	url, _ := hostStatus["healthUrl"].(string)
	return hostStatus["state"].(string), url
}

func launcherCode(err error) string {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return ""
}

func TestUpdateStopsSwapsAndRestartsTheHostWithoutManualSteps(t *testing.T) {
	inst := newInstallation(t)
	started, code, raw := inst.run("start", "--json")
	if code != 0 {
		t.Fatalf("start: %s", raw)
	}
	before := started["host"].(map[string]any)["pid"].(float64)
	newPort := freeLoopbackPort(t)

	outcome, err := inst.swapTo(t, versionedReceipt(t, "2.0.0", newPort))
	if err != nil || !outcome.WasRunning || outcome.RecoveryPoint == "" {
		t.Fatalf("swap: %#v, %v", outcome, err)
	}
	state, healthURL := inst.hostState(t)
	if state != "running" || healthURL != fmt.Sprintf("http://127.0.0.1:%d/health", newPort) {
		t.Fatalf("the host must run the new version: %s %s", state, healthURL)
	}
	if conn, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", inst.port), 200*time.Millisecond); dialErr == nil {
		_ = conn.Close()
		t.Fatal("the previous host must be gone")
	}
	status, _, _ := inst.run("status")
	if pid := status["host"].(map[string]any)["pid"].(float64); pid == before {
		t.Fatal("the host process must have been replaced")
	}
	if installation, _ := status["installation"].(map[string]any); installation["platformVersion"] != "2.0.0" {
		t.Fatalf("status must report the installed version: %v", status["installation"])
	}
}

func TestUpdateThatBreaksTheHostRestoresAndRestartsThePreviousVersion(t *testing.T) {
	inst := newInstallation(t)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	broken := versionedReceipt(t, "2.0.0", freeLoopbackPort(t), "-exit", "5")

	outcome, err := inst.swapTo(t, broken)
	if launcherCode(err) != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("err = %v", err)
	}
	var typed *contracts.LauncherError
	errors.As(err, &typed)
	if !strings.Contains(typed.Message, "previous version 1.0.0 was restored") || outcome.RecoveryPoint == "" {
		t.Fatalf("error = %#v, outcome = %#v", typed, outcome)
	}
	if problems := typed.Validate(); len(problems) != 0 {
		t.Fatalf("the error must be a valid catalog envelope: %v", problems)
	}
	// The previous version is what runs again, and what the receipt says.
	state, healthURL := inst.hostState(t)
	if state != "running" || healthURL != fmt.Sprintf("http://127.0.0.1:%d/health", inst.port) {
		t.Fatalf("the previous host must be running again: %s %s", state, healthURL)
	}
	active, readErr := receipt.Read(inst.root)
	if readErr != nil || active.ID != "r1" {
		t.Fatalf("the previous receipt must be active again: %#v, %v", active, readErr)
	}
}

func TestUpdateLeavesAStoppedHostStopped(t *testing.T) {
	inst := newInstallation(t)
	outcome, err := inst.swapTo(t, versionedReceipt(t, "2.0.0", freeLoopbackPort(t)))
	if err != nil || outcome.WasRunning {
		t.Fatalf("swap: %#v, %v", outcome, err)
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
func invoke(t *testing.T, command invocation) (map[string]any, int, string) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	code := command.run(file)
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	_ = json.Unmarshal(data, &parsed)
	return parsed, code, string(data)
}

func TestRollbackWithoutASnapshotIsRefusedWithTheCatalogError(t *testing.T) {
	inst := newInstallation(t)
	payload, code, raw := invoke(t, invocation{Operation: "rollback", PlatformRoot: inst.root})
	if code != 1 || errorCode(payload) != contracts.CodeUpdateNoSnapshot {
		t.Fatalf("rollback: %d %s", code, raw)
	}
	failure := payload["error"].(map[string]any)
	if failure["message"] != "There is no snapshot to roll back to." || failure["hint"] == "" {
		t.Fatalf("error = %v", failure)
	}
}

func TestLifecycleCommandsNeedAnInstallation(t *testing.T) {
	t.Setenv(host.KBHomeEnv, t.TempDir())
	for _, operation := range []string{"rollback", "uninstall"} {
		payload, code, raw := invoke(t, invocation{Operation: operation, PlatformRoot: t.TempDir()})
		if code != 2 || errorCode(payload) != contracts.CodeReceiptUnavailable {
			t.Fatalf("%s: %d %s", operation, code, raw)
		}
	}
}

func TestStatusReportsTheHostAndTheInstalledVersion(t *testing.T) {
	inst := newInstallation(t)
	payload, code, raw := invoke(t, invocation{Operation: "status", PlatformRoot: inst.root})
	if code != 0 || payload["host"].(map[string]any)["state"] != "stopped" {
		t.Fatalf("status: %d %s", code, raw)
	}
}

func TestDoctorSeparatesTheInstallationFromThePlatform(t *testing.T) {
	inst := newInstallation(t)
	if err := os.MkdirAll(filepath.Join(inst.root, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inst.root, ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Stopped host: the installation is fine, the platform is not running.
	payload, code, raw := invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root})
	if code != 1 || payload["ok"] != false {
		t.Fatalf("doctor: %d %s", code, raw)
	}
	if payload["installation"].(map[string]any)["ok"] != true || payload["platform"].(map[string]any)["ok"] != false {
		t.Fatalf("the two questions must be answered separately: %s", raw)
	}

	// Running host: both are healthy.
	if _, exit, out := inst.run("start", "--json"); exit != 0 {
		t.Fatalf("start: %s", out)
	}
	payload, code, raw = invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root})
	if code != 0 || payload["ok"] != true || payload["platform"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor on a healthy platform: %d %s", code, raw)
	}

	// A broken installation is reported as installation, whatever the platform does.
	if err := os.Remove(filepath.Join(inst.root, ".kb", "kb.config.jsonc")); err != nil {
		t.Fatal(err)
	}
	payload, code, raw = invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root})
	if code != 1 || payload["installation"].(map[string]any)["ok"] != false || payload["platform"].(map[string]any)["ok"] != true {
		t.Fatalf("doctor on a broken installation: %d %s", code, raw)
	}
}

// recoverInstallation returns an installation whose platform ships a recovery
// tool that records the arguments it was run with.
func recoverInstallation(t *testing.T, withTool bool) (installation, string) {
	t.Helper()
	inst := newInstallation(t)
	record := filepath.Join(t.TempDir(), "args.txt")
	script := filepath.Join(inst.root, "recover.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$RECOVER_RECORD\"\nprintf 'recovered\\n'\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RECOVER_RECORD", record)
	active, err := receipt.Read(inst.root)
	if err != nil {
		t.Fatal(err)
	}
	if withTool {
		active.Plan.Host.Recover = &contracts.ToolSpec{Command: "./recover.sh", Args: []string{"--base"}}
	}
	if err := receipt.Write(inst.root, active); err != nil {
		t.Fatal(err)
	}
	return inst, record
}

func TestDoctorRecoverRunsThePlatformRecoveryToolWithTheHostStopped(t *testing.T) {
	inst, record := recoverInstallation(t, true)
	request := recoverRequest{Enabled: true, Email: "admin@example.com", Tenant: "acme", Generate: true, Yes: true}
	_, code, raw := invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root, Recover: request})
	if code != 0 || !strings.Contains(raw, "recovered") {
		t.Fatalf("recover: %d %q", code, raw)
	}
	args, err := os.ReadFile(record)
	if err != nil || strings.TrimSpace(string(args)) != "--base --email admin@example.com --tenant acme --generate --yes" {
		t.Fatalf("the tool must receive the operator's flags: %q, %v", args, err)
	}
}

func TestDoctorRecoverRefusesWhileTheHostRuns(t *testing.T) {
	inst, record := recoverInstallation(t, true)
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	payload, code, raw := invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root, Recover: recoverRequest{Enabled: true, JSON: true}})
	if code != 1 || errorCode(payload) != contracts.CodeRecoveryHostRunning {
		t.Fatalf("recover: %d %s", code, raw)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatal("the recovery tool must not run while the host runs")
	}
}

func TestDoctorRecoverNeedsAPlatformThatShipsARecoveryTool(t *testing.T) {
	inst, _ := recoverInstallation(t, false)
	payload, code, raw := invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root, Recover: recoverRequest{Enabled: true, JSON: true}})
	if code != 1 || errorCode(payload) != contracts.CodeRecoveryUnavailable {
		t.Fatalf("recover: %d %s", code, raw)
	}
}

func TestDoctorRecoverPropagatesTheToolsExitStatus(t *testing.T) {
	inst, _ := recoverInstallation(t, true)
	script := filepath.Join(inst.root, "recover.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 4\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, code, _ := invoke(t, invocation{Operation: "doctor", PlatformRoot: inst.root, Recover: recoverRequest{Enabled: true}}); code != 4 {
		t.Fatalf("exit status = %d, want the tool's 4", code)
	}
}

func TestFreshApplyIsRefusedWhileASupervisedHostRuns(t *testing.T) {
	inst := newInstallation(t)
	state := host.State{Dir: inst.state}
	if failure := refuseRunningHost(state); failure != nil {
		t.Fatalf("nothing runs yet: %v", failure)
	}
	if _, code, raw := inst.run("start", "--json"); code != 0 {
		t.Fatalf("start: %s", raw)
	}
	failure := refuseRunningHost(state)
	if failure == nil || failure.Code != "KB_HOST_ALREADY_RUNNING" || failure.Details["supervisorPid"] == "" {
		t.Fatalf("failure = %#v", failure)
	}
	if problems := failure.Validate(); len(problems) != 0 {
		t.Fatalf("the refusal must be a valid catalog envelope: %v", problems)
	}
}
