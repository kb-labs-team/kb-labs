package supervisor

import (
	"context"
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/versionroot"
)

type stubRunner struct{ calls []string }

func (r *stubRunner) Name() string { return "stub" }
func (r *stubRunner) Start(context.Context) (host.Info, error) {
	r.calls = append(r.calls, "start")
	return host.Info{Runner: "stub"}, nil
}
func (r *stubRunner) Stop(context.Context) (host.StopResult, error) {
	r.calls = append(r.calls, "stop")
	return host.StopResult{Runner: "stub"}, nil
}
func (r *stubRunner) Status(context.Context) (host.Status, error) {
	return host.Status{Runner: "stub", State: host.StateRunning, Healthy: true}, nil
}

func installedRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: &contracts.HostSpec{Command: "host", HealthURL: "http://127.0.0.1:4000/health"},
		ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway"}}}}
	if err := receipt.Write(stage, contracts.InstallReceipt{ID: "test-receipt", InstallationID: installationID, Plan: plan}); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "test-plan"); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestRunPublishesControlChannelAndStopsHostOnCancel(t *testing.T) {
	token, err := host.NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(host.ProcessIdentityEnv, token)
	state := host.State{Dir: t.TempDir()}
	root := installedRoot(t)
	runner := &stubRunner{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- (&Supervisor{Runner: runner, State: state, PlatformRoot: root, Version: "t"}).Run(ctx) }()

	deadline := time.Now().Add(5 * time.Second)
	var client *control.Client
	for {
		var err error
		if client, err = control.Connect(state); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("control channel never appeared: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, err := client.Status(context.Background()); err != nil || status.Host.State != host.StateRunning {
		t.Fatalf("status: %+v %v", status, err)
	}
	installationID, err := versionroot.InstallationIDForPath(root)
	if err != nil {
		t.Fatal(err)
	}
	if record, ok := readRecordFile(state); !ok || record.InstallationID != installationID {
		t.Fatalf("supervisor record identity = %#v, %t; want %q", record, ok, installationID)
	}
	// A second supervisor for the same state home must refuse to start.
	err = (&Supervisor{Runner: &stubRunner{}, State: state, PlatformRoot: root}).Run(context.Background())
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("second supervisor: %v", err)
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := runner.calls; len(got) != 2 || got[0] != "start" || got[1] != "stop" {
		t.Fatalf("runner calls: %v", got)
	}
	for _, path := range []string{state.Control(), state.SupervisorPID()} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s should be removed on shutdown", path)
		}
	}
}

func TestLivePIDRemovesStalePidFile(t *testing.T) {
	state := host.State{Dir: t.TempDir()}
	if err := os.WriteFile(state.SupervisorPID(), []byte(strconv.Itoa(2147483646)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, alive := LivePID(state, t.TempDir()); alive {
		t.Fatal("dead pid reported alive")
	}
	if _, err := os.Stat(state.SupervisorPID()); !os.IsNotExist(err) {
		t.Fatal("stale supervisor.pid must be removed")
	}
}

func TestSupervisorRejectsAReusedPIDWithoutStartingOrSignallingIt(t *testing.T) {
	token, err := host.NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(host.ProcessIdentityEnv, token)
	state := host.State{Dir: t.TempDir()}
	if err := state.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state.SupervisorPID(), []byte(`{"pid":`+strconv.Itoa(os.Getpid())+`,"processIdentity":"`+token+`","platformRoot":"/tmp/kb"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &stubRunner{}
	err = (&Supervisor{Runner: runner, State: state, PlatformRoot: "/tmp/kb"}).Run(context.Background())
	failure, ok := err.(*diag.Diag)
	if !ok || failure.Code != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("stale supervisor diagnostic = %#v", err)
	}
	if len(runner.calls) != 0 || !host.ProcessAlive(os.Getpid()) {
		t.Fatalf("stale supervisor record affected its reused PID or started a host: calls=%v", runner.calls)
	}
}

func activeWorkSupervisor(t *testing.T, activeWorkJSON string) (*Supervisor, *host.ProcessRunner) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "fakehost")
	build := exec.Command("go", "build", "-o", binary, "../internal/fakehost")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake host: %v\n%s", err, output)
	}
	port, err := freeLoopbackPort()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	layout, err := versionroot.New(root)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := layout.StageInitial()
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(stage)
	if err != nil {
		t.Fatal(err)
	}
	spec := &contracts.HostSpec{Command: binary, Args: []string{"-port", strconv.Itoa(port), "-active-work-json", activeWorkJSON}, HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: 10, StopGraceSeconds: 3}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: spec, ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "gateway"}}}}
	if err := receipt.Write(stage, contracts.InstallReceipt{ID: "active-work-test", InstallationID: installationID, Plan: plan}); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "active-work-test"); err != nil {
		t.Fatal(err)
	}
	runner, err := host.NewRunner(root)
	if err != nil {
		t.Fatal(err)
	}
	supervisor := &Supervisor{Runner: runner, State: host.State{Dir: t.TempDir()}, PlatformRoot: root}
	if err := supervisor.prepareHostStart(runner); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = supervisor.Runner.Stop(context.Background()) })
	return supervisor, runner
}

func freeLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func TestRestartRefusesActiveWorkBeforeStoppingHost(t *testing.T) {
	supervisor, previous := activeWorkSupervisor(t, `[{"kind":"workflow","id":"run-17","owningService":"workflow"}]`)
	initial, err := previous.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	pid := initial.PID
	_, err = supervisor.restart(context.Background(), false)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_RESTART_WORK_IN_FLIGHT" {
		t.Fatalf("restart error = %v, want catalogued active-work refusal", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("serialize refusal: %v", err)
	}
	items, ok := envelope.Details["items"].([]host.ActiveWorkItem)
	if !ok || len(items) != 1 || items[0].OwningService != "workflow" {
		t.Fatalf("active-work details = %#v", envelope.Details["items"])
	}
	status, err := previous.Status(context.Background())
	if err != nil || status.State != host.StateRunning || status.PID != pid {
		t.Fatalf("host after refusal = %+v, %v; want PID %d still running", status, err, pid)
	}
	for _, path := range []string{previous.State.HostPID(), previous.State.HostLog()} {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if strings.Contains(string(data), previous.ControlCredential) {
			t.Fatalf("control credential was written to %s", path)
		}
	}
}

func TestRestartQueryFailureReturnsHostUnreachableWithoutStopping(t *testing.T) {
	supervisor, previous := activeWorkSupervisor(t, `[]`)
	initial, err := previous.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	pid := initial.PID
	previous.ControlAddress = "http://127.0.0.1:1"
	_, err = supervisor.restart(context.Background(), false)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_HOST_UNREACHABLE" {
		t.Fatalf("restart error = %v, want catalogued host-unreachable", err)
	}
	status, err := previous.Status(context.Background())
	if err != nil || status.State != host.StateRunning || status.PID != pid {
		t.Fatalf("host after query failure = %+v, %v; want PID %d still running", status, err, pid)
	}
}

func TestRestartInterruptProceedsWithActiveWork(t *testing.T) {
	supervisor, previous := activeWorkSupervisor(t, `[{"kind":"workflow","id":"run-19","owningService":"workflow"}]`)
	initial, err := previous.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	oldPID := initial.PID
	response, err := supervisor.restart(context.Background(), true)
	if err != nil || !response.OK || response.Host.PID == oldPID {
		t.Fatalf("interrupt restart = %+v, %v; want a replacement host", response, err)
	}
}

func TestActiveWorkQueryRejectsWrongAndMissingCredentials(t *testing.T) {
	supervisor, runner := activeWorkSupervisor(t, `[]`)
	original := runner.ControlCredential
	for _, credential := range []string{"wrong", ""} {
		runner.ControlCredential = credential
		_, err := runner.QueryActiveWork(context.Background())
		var failure *diag.Diag
		if !errors.As(err, &failure) || failure.Code != "KB_HOST_UNREACHABLE" {
			t.Fatalf("credential %q query error = %v, want host-unreachable", credential, err)
		}
	}
	runner.ControlCredential = original
	if _, err := supervisor.Runner.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
}
