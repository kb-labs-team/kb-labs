//go:build !windows

package host

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
)

var fakeHostBinary string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "kb-create-fakehost-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fakeHostBinary = filepath.Join(dir, "fakehost")
	if output, err := exec.Command("go", "build", "-o", fakeHostBinary, "../internal/fakehost").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build fakehost: %v\n%s", err, output)
		os.RemoveAll(dir)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// freePort returns a loopback port that was free a moment ago.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

type fixture struct {
	runner *ProcessRunner
	port   int
}

func newRunner(t *testing.T, ready, grace int, hostArgs ...string) fixture {
	t.Helper()
	port := freePort(t)
	spec, err := NewSpec(t.TempDir(), contracts.HostSpec{
		Command: fakeHostBinary, Args: append([]string{"-port", fmt.Sprint(port)}, hostArgs...),
		HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port), ReadyTimeoutSeconds: ready, StopGraceSeconds: grace,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner := &ProcessRunner{Spec: spec, State: State{Dir: filepath.Join(t.TempDir(), "state")}, PollInterval: 20 * time.Millisecond}
	t.Cleanup(func() { _, _ = runner.Stop(context.Background()) })
	return fixture{runner: runner, port: port}
}

func launcherCode(t *testing.T, err error) string {
	t.Helper()
	var typed *contracts.LauncherError
	if !errors.As(err, &typed) {
		t.Fatalf("expected a LauncherError, got %v", err)
	}
	if problems := typed.Validate(); len(problems) != 0 {
		t.Fatalf("error %s is not a valid envelope: %v", typed.Code, problems)
	}
	return typed.Code
}

func TestStartStatusStopGraceful(t *testing.T) {
	f := newRunner(t, 10, 5)
	ctx := context.Background()
	info, err := f.runner.Start(ctx)
	if err != nil || info.PID == 0 {
		t.Fatalf("start: %+v %v", info, err)
	}
	status, err := f.runner.Status(ctx)
	if err != nil || status.State != StateRunning || !status.Healthy || status.PID != info.PID {
		t.Fatalf("status: %+v %v", status, err)
	}
	result, err := f.runner.Stop(ctx)
	if err != nil || !result.WasRunning || !result.Graceful || result.Forced {
		t.Fatalf("stop: %+v %v", result, err)
	}
	if processAlive(info.PID) {
		t.Fatal("host still alive after graceful stop")
	}
	if _, err := os.Stat(f.runner.State.HostPID()); !os.IsNotExist(err) {
		t.Fatalf("pid file should be gone: %v", err)
	}
	if status, _ := f.runner.Status(ctx); status.State != StateStopped {
		t.Fatalf("status after stop: %+v", status)
	}
}

func TestPidAndLogFilesArePrivate(t *testing.T) {
	f := newRunner(t, 10, 5)
	if _, err := f.runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{f.runner.State.HostPID(), f.runner.State.HostLog()} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: mode %v err %v", path, info, err)
		}
	}
}

func TestStartWhileRunningIsAlreadyRunning(t *testing.T) {
	f := newRunner(t, 10, 5)
	if _, err := f.runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := f.runner.Start(context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("code %s", code)
	}
}

func TestPortInUse(t *testing.T) {
	f := newRunner(t, 10, 5)
	blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", f.port))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	_, err = f.runner.Start(context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_PORT_IN_USE" {
		t.Fatalf("code %s", code)
	}
	if _, statErr := os.Stat(f.runner.State.HostPID()); !os.IsNotExist(statErr) {
		t.Fatal("no process should have been spawned")
	}
}

func TestStalePidFileIsRecovered(t *testing.T) {
	f := newRunner(t, 10, 5)
	dead := exec.Command(fakeHostBinary, "-exit", "0")
	if err := dead.Run(); err != nil {
		t.Fatal(err)
	}
	if err := f.runner.State.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONFile(f.runner.State.HostPID(), pidRecord{PID: dead.Process.Pid, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	status, err := f.runner.Status(context.Background())
	if err != nil || status.State != StateStopped || !status.StalePID {
		t.Fatalf("status with stale pid: %+v %v", status, err)
	}
	// Recreate the stale file: Start must clean it and succeed.
	_ = writeJSONFile(f.runner.State.HostPID(), pidRecord{PID: dead.Process.Pid, StartedAt: time.Now()})
	if _, err := f.runner.Start(context.Background()); err != nil {
		t.Fatalf("start over stale pid: %v", err)
	}
}

func TestCorruptPidFileIsStale(t *testing.T) {
	f := newRunner(t, 10, 5)
	_ = f.runner.State.Ensure()
	_ = os.WriteFile(f.runner.State.HostPID(), []byte("not json"), 0o600)
	if _, err := f.runner.Start(context.Background()); err != nil {
		t.Fatalf("start over corrupt pid: %v", err)
	}
}

func TestForcedStopWhenTermIgnored(t *testing.T) {
	f := newRunner(t, 10, 1, "-ignore-term")
	info, err := f.runner.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	result, err := f.runner.Stop(context.Background())
	if err != nil || !result.Forced || result.Graceful {
		t.Fatalf("stop: %+v %v", result, err)
	}
	if time.Since(started) < time.Second {
		t.Fatalf("kill must wait for the grace period, took %s", time.Since(started))
	}
	if processAlive(info.PID) {
		t.Fatal("host survived the kill")
	}
}

func TestStopWhenNotRunning(t *testing.T) {
	f := newRunner(t, 10, 5)
	result, err := f.runner.Stop(context.Background())
	if err != nil || result.WasRunning {
		t.Fatalf("stop idle host: %+v %v", result, err)
	}
}

func TestStartFailureWhenHostExits(t *testing.T) {
	f := newRunner(t, 10, 5, "-exit", "7")
	_, err := f.runner.Start(context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	if _, statErr := os.Stat(f.runner.State.HostPID()); !os.IsNotExist(statErr) {
		t.Fatal("pid file must be removed after a failed start")
	}
	data, _ := os.ReadFile(f.runner.State.HostLog())
	if len(data) == 0 {
		t.Fatal("host output should be captured in the log file")
	}
}

func TestReadyTimeoutKillsHost(t *testing.T) {
	f := newRunner(t, 1, 5, "-unhealthy")
	_, err := f.runner.Start(context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	if _, dialErr := net.DialTimeout("tcp", f.runner.Spec.HealthAddress(), 200*time.Millisecond); dialErr == nil {
		t.Fatal("unhealthy host must be killed after the ready timeout")
	}
}

func TestStatusReportsUnhealthy(t *testing.T) {
	f := newRunner(t, 10, 5)
	if _, err := f.runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Point the health probe at a dead path on the same server by stopping
	// the answer: use a spec whose URL returns 404.
	f.runner.Spec.HealthURL = fmt.Sprintf("http://127.0.0.1:%d/missing", f.port)
	status, _ := f.runner.Status(context.Background())
	if status.State != StateUnhealthy || status.Healthy {
		t.Fatalf("status: %+v", status)
	}
}

func TestStateDirUnwritable(t *testing.T) {
	f := newRunner(t, 10, 5)
	blocker := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(blocker, nil, 0o600)
	f.runner.State = State{Dir: filepath.Join(blocker, "state")}
	_, err := f.runner.Start(context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_STATE_DIR_UNWRITABLE" {
		t.Fatalf("code %s", code)
	}
}

func TestRunForegroundStopsHostOnCancel(t *testing.T) {
	f := newRunner(t, 10, 5)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- RunForeground(ctx, f.runner) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if status, _ := f.runner.Status(context.Background()); status.State == StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("host never became healthy")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if status, _ := f.runner.Status(context.Background()); status.State != StateStopped {
		t.Fatalf("host should be stopped: %+v", status)
	}
}

func TestSpecValidationAndResolution(t *testing.T) {
	root := "/platform"
	if _, err := NewSpec(root, contracts.HostSpec{Command: "host", HealthURL: "http://example.com:1/health"}); err == nil {
		t.Fatal("non-loopback health URL must be rejected")
	}
	if _, err := NewSpec(root, contracts.HostSpec{Command: "host", HealthURL: "http://127.0.0.1/health"}); err == nil {
		t.Fatal("health URL without a port must be rejected")
	}
	if _, err := NewSpec(root, contracts.HostSpec{HealthURL: "http://127.0.0.1:1/health"}); err == nil {
		t.Fatal("missing command must be rejected")
	}
	spec, err := NewSpec(root, contracts.HostSpec{Command: "bin/host", WorkingDir: "run", HealthURL: "http://127.0.0.1:9/health"})
	if err != nil || spec.Command != "/platform/bin/host" || spec.WorkingDir != "/platform/run" || spec.ReadyTimeout != defaultReadyTimeout || spec.StopGrace != defaultStopGrace {
		t.Fatalf("spec: %+v %v", spec, err)
	}
}

func writeReceipt(t *testing.T, root string, host *contracts.HostSpec) {
	t.Helper()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, ServiceGraph: contracts.ServiceGraph{Services: []contracts.Service{{ID: "gateway", Required: true}}}, Host: host}
	if err := receipt.Write(root, contracts.InstallReceipt{ID: "r1", Plan: plan}); err != nil {
		t.Fatal(err)
	}
}

func TestSelectDefaultsToKBDevWithoutHostSpec(t *testing.T) {
	root := t.TempDir()
	writeReceipt(t, root, nil)
	runner, err := Select(root, "kb-dev-binary")
	if err != nil {
		t.Fatal(err)
	}
	kbdev, ok := runner.(*KBDevRunner)
	if !ok || len(kbdev.ServiceIDs) != 1 || kbdev.ServiceIDs[0] != "gateway" || kbdev.Client.Binary != "kb-dev-binary" {
		t.Fatalf("expected the kb-dev runner, got %#v", runner)
	}
}

func TestSelectUsesProcessRunnerWhenReceiptDeclaresHost(t *testing.T) {
	root := t.TempDir()
	t.Setenv(StateHomeEnv, filepath.Join(t.TempDir(), "state"))
	writeReceipt(t, root, &contracts.HostSpec{Command: "bin/host", HealthURL: "http://127.0.0.1:9/health"})
	runner, err := Select(root, "")
	if err != nil {
		t.Fatal(err)
	}
	process, ok := runner.(*ProcessRunner)
	if !ok || process.Spec.Command != filepath.Join(root, "bin/host") || process.State.Dir != os.Getenv(StateHomeEnv) {
		t.Fatalf("expected the process runner, got %#v", runner)
	}
}

func TestSelectRejectsInvalidHostSpec(t *testing.T) {
	root := t.TempDir()
	writeReceipt(t, root, &contracts.HostSpec{Command: "host", HealthURL: "http://10.0.0.1:1/health"})
	_, err := Select(root, "")
	if code := launcherCode(t, err); code != "KB_HOST_SPEC_INVALID" {
		t.Fatalf("code %s", code)
	}
}
