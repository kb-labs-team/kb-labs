//go:build !windows

package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/internal/tempdirguard"
	"github.com/kb-labs/create/v2/internal/testprocess"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
)

var fakeHostBinary string

// case: S-285.17
func TestHealthProbeReadsReportedStudioURL(t *testing.T) {
	for _, tc := range []struct{ body, want string }{{`{"data":{"studio":{"url":"http://example.test/"}}}`, "http://example.test/"}, {`{"data":{}}`, ""}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, tc.body)
		}))
		got := (&ProcessRunner{}).probeURL(context.Background(), server.URL)
		server.Close()
		if got.StudioURL != tc.want {
			t.Fatalf("studio URL = %q; want %q", got.StudioURL, tc.want)
		}
	}
}

func TestStopKillsHostGrandchild(t *testing.T) {
	f := newRunner(t, 10, 1)
	grandchildFile := filepath.Join(t.TempDir(), "grandchild.pid")
	f.runner.Spec.Command = "/bin/sh"
	f.runner.Spec.Args = []string{"-c", fmt.Sprintf("sleep 60 & echo $! > %q; exec %q -port %d", grandchildFile, fakeHostBinary, f.port)}
	info, err := f.runner.Start(context.Background())
	if err != nil {
		t.Fatalf("start host: %v", err)
	}
	data, err := os.ReadFile(grandchildFile)
	if err != nil {
		t.Fatal(err)
	}
	grandchildPID, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("parse grandchild pid: %v", err)
	}
	if _, err := f.runner.Stop(context.Background()); err != nil {
		t.Fatalf("stop host: %v", err)
	}
	if processAlive(grandchildPID) {
		t.Fatalf("host stop left grandchild %d alive (host pid %d)", grandchildPID, info.PID)
	}
}

func TestLifecycleRecordReadersNeverSeePartialPublication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.pid")
	type record struct {
		PID      int    `json:"pid"`
		Identity string `json:"identity"`
	}
	first, _ := json.Marshal(record{PID: 1, Identity: strings.Repeat("a", 32*1024)})
	second, _ := json.Marshal(record{PID: 2, Identity: strings.Repeat("b", 32*1024)})
	if err := WriteRecordFile(path, first); err != nil {
		t.Fatal(err)
	}
	var writers sync.WaitGroup
	writers.Add(1)
	go func() {
		defer writers.Done()
		for i := 0; i < 400; i++ {
			data := first
			if i%2 == 0 {
				data = second
			}
			if err := WriteRecordFile(path, data); err != nil {
				t.Errorf("publish record: %v", err)
				return
			}
		}
	}()
	for i := 0; i < 1000; i++ {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read record during publication: %v", err)
		}
		var got record
		if err := json.Unmarshal(data, &got); err != nil || (got.PID != 1 && got.PID != 2) || len(got.Identity) != 32*1024 {
			t.Fatalf("reader saw a partial lifecycle record: pid=%d identity length=%d err=%v", got.PID, len(got.Identity), err)
		}
	}
	writers.Wait()
}

func TestStartFailureEnvelopePreservesReadinessEvidence(t *testing.T) {
	state := State{Dir: filepath.Join(t.TempDir(), "missing-state-dir")}
	original := StartFailure(state, errors.New("readiness check failed"), map[string]string{
		"stderrTail": "fakehost: ready check failed", "hostStartupCode": "KB_RUNTIME_UNEXPECTED",
		"waited": "1s", "readinessURL": "http://127.0.0.1:5250/ready", "readinessStatus": "500",
		"readinessError": "readiness refused", "exitCode": "2", "signal": "SIGTERM", "exitStatus": "exit status 2",
		"expectedPid": "20", "pid": "21", "command": "kb-host", "failureKind": "readinessFailed",
		"supervisorLog": "/tmp/supervisor.log", "supervisorStderrTail": "supervisor failed",
		"supervisorExit": "exit status 3", "controlRecord": "/tmp/control.json",
		"nextCommand": "kb-create status", "structuredLogTail": "2026-11-11T00:00:00Z ERROR host failed",
	})
	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal start failure: %v", err)
	}
	var decoded diag.Diag
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode start failure: %v", err)
	}
	for key, want := range original.Meta {
		if got := decoded.Meta[key]; got != want {
			t.Errorf("decoded start-failure detail %q = %v, want %v", key, got, want)
		}
	}
	entry, _ := diag.LookupCatalog("KB_HOST_START_FAILED")
	if len(encoded) == 0 || len(decoded.Meta) != len(entry.StructuredDetailFields) {
		t.Fatalf("round-trip fields=%v, catalog declares %v", decoded.Meta, entry.StructuredDetailFields)
	}
}

func TestStartFailureRejectsUndeclaredEvidence(t *testing.T) {
	failure := StartFailure(State{Dir: t.TempDir()}, errors.New("startup failed"), map[string]string{
		"evidenceFromNewProducer": "value",
	})
	if failure.Code != "KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION" ||
		failure.Meta["originalCode"] != "KB_HOST_START_FAILED" ||
		failure.Meta["fields"] != "evidenceFromNewProducer" {
		t.Fatalf("StartFailure = %+v, want typed contract violation with offending field", failure)
	}
}

func TestMain(m *testing.M) {
	// Re-exec helper children (process_identity_exec_test.go) either replace
	// their image with syscall.Exec or exit from inside the test, so the
	// cleanup below never runs in them; they never use the fake host.
	if os.Getenv("KB_PROCESS_IDENTITY_EXEC_PHASE") != "" {
		os.Exit(m.Run())
	}
	checkLeakedTempEntries := tempdirguard.Own("kb-create-fakehost-")
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
	if output, err := exec.Command("lsof", "-nP", "-t", fakeHostBinary).CombinedOutput(); err != nil {
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 || len(output) != 0 {
			fmt.Fprintf(os.Stderr, "could not audit test process path %s: %v\n%s", fakeHostBinary, err, output)
			code = 1
		} else {
			fmt.Fprintf(os.Stdout, "process audit %s: none\n", fakeHostBinary)
		}
	} else if len(strings.Fields(string(output))) > 0 {
		fmt.Fprintf(os.Stderr, "test fakehost process remains alive for %s:\n%s", fakeHostBinary, output)
		code = 1
	} else {
		fmt.Fprintf(os.Stdout, "process audit %s: none\n", fakeHostBinary)
	}
	os.RemoveAll(dir)
	if leaked := checkLeakedTempEntries(); len(leaked) > 0 {
		fmt.Fprintf(os.Stderr, "host tests left their own temp entries in %s: %v; entries with this prefix must be removed by the suite that created them\n", os.TempDir(), leaked)
		code = 1
	}
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

func startOwnedFakeHost(t *testing.T, port int, identityToken string) *exec.Cmd {
	t.Helper()
	command := exec.Command(fakeHostBinary, "-port", fmt.Sprint(port))
	command.Env = ProcessEnvironmentWithIdentity(os.Environ(), identityToken)
	if err := testprocess.Start(t, command); err != nil {
		t.Fatalf("start owned fakehost process group: %v", err)
	}
	return command
}

type fixture struct {
	runner *ProcessRunner
	port   int
}

func startProcessForTest(t *testing.T, runner *ProcessRunner, ctx context.Context) (Info, error) {
	t.Helper()
	info, err := runner.Start(ctx)
	if err == nil {
		t.Cleanup(func() {
			if _, stopErr := runner.Stop(context.Background()); stopErr != nil {
				runner.mu.Lock()
				processIdentity := runner.processIdentity
				runner.mu.Unlock()
				if ProcessIdentityOf(info.PID, processIdentity) == ProcessIdentityMatch {
					if !KillProcessGroupIfIdentity(info.PID, processIdentity) || !runner.waitGone(info.PID, processIdentity, 5*time.Second) {
						t.Errorf("test host cleanup could not kill verified process %d after stop error", info.PID)
					}
				}
				t.Errorf("test host cleanup could not stop process: %v", stopErr)
			}
		})
	}
	return info, err
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
	root := t.TempDir()
	identity, err := NewProcessIdentity(contracts.InstallReceipt{ID: "test-receipt", InstallationID: "test-installation",
		Plan: contracts.ResolvedInstallPlan{ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "host"}}}}}, root, root)
	if err != nil {
		t.Fatal(err)
	}
	runner := &ProcessRunner{Spec: spec, State: State{Dir: filepath.Join(t.TempDir(), "state")}, InstallRoot: root, InstallationID: identity.InstallationID, PlatformRoot: root, TreeRoot: root, Identity: identity, PollInterval: 20 * time.Millisecond}
	t.Cleanup(func() {
		if _, stopErr := runner.Stop(context.Background()); stopErr != nil {
			t.Errorf("test runner cleanup could not stop process: %v", stopErr)
		}
	})
	return fixture{runner: runner, port: port}
}

func launcherCode(t *testing.T, err error) string {
	t.Helper()
	var typed *diag.Diag
	if !errors.As(err, &typed) {
		t.Fatalf("expected a Diag, got %v", err)
	}
	if typed.Hint == "" {
		t.Fatalf("diagnostic %s has no hint", typed.Code)
	}
	return typed.Code
}

// case: PC-001.2
func TestHostControlReadinessUsesInstalledHostEnvironmentContract(t *testing.T) {
	failedProbe := readinessProbe{URL: "http://127.0.0.1:5250/health", Status: 200, Error: "host readiness did not report a valid loopback control address"}
	if got, want := probeDescription(failedProbe), "http://127.0.0.1:5250/health returned HTTP 200 but readiness failed: host readiness did not report a valid loopback control address"; got != want {
		t.Fatalf("readiness failure description = %q, want %q", got, want)
	}
	f := newRunner(t, 10, 5)
	f.runner.ControlCredential = strings.Repeat("c", 32)
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
		t.Fatal(err)
	}
	if !validControlAddress(f.runner.ControlAddress) {
		t.Fatalf("host readiness did not publish its loopback control address: %q", f.runner.ControlAddress)
	}
	items, err := f.runner.QueryActiveWork(context.Background())
	if err != nil || len(items) != 0 {
		t.Fatalf("authenticated active-work request = %v, %v; want empty list", items, err)
	}
}

func TestStartStatusStopGraceful(t *testing.T) {
	f := newRunner(t, 10, 5)
	ctx := context.Background()
	info, err := startProcessForTest(t, f.runner, ctx)
	if err != nil || info.PID == 0 {
		t.Fatalf("start: %+v %v", info, err)
	}
	status, err := f.runner.Status(ctx)
	if err != nil || status.State != StateRunning || !status.Healthy || status.PID != info.PID {
		t.Fatalf("status: %+v %v", status, err)
	}
	owner := listenerOwner(fmt.Sprint(f.port))
	if owner.PID != fmt.Sprint(info.PID) {
		t.Fatalf("listener owner = %+v, launched pid = %d", owner, info.PID)
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
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
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
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := startProcessForTest(t, f.runner, context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("code %s", code)
	}
}

func TestRunnerDoesNotObserveOrStopAHostForAnotherRoot(t *testing.T) {
	f := newRunner(t, 10, 5)
	rootA, rootB := filepath.Join(t.TempDir(), "platform-a"), filepath.Join(t.TempDir(), "platform-b")
	f.runner.PlatformRoot = rootA
	info, err := startProcessForTest(t, f.runner, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	other := &ProcessRunner{Spec: f.runner.Spec, State: f.runner.State, InstallRoot: rootB, InstallationID: "other-installation", PlatformRoot: rootB, TreeRoot: f.runner.TreeRoot, Identity: f.runner.Identity}
	status, err := other.Status(context.Background())
	if err != nil || status.State != StateStopped || status.PID != 0 {
		t.Fatalf("other-root status = %#v, %v; want stopped", status, err)
	}
	stopped, err := other.Stop(context.Background())
	if err != nil || stopped.WasRunning {
		t.Fatalf("other-root stop = %#v, %v; want no-op", stopped, err)
	}
	if !processAlive(info.PID) {
		t.Fatal("other-root stop signaled the original host")
	}
	_, err = startProcessForTest(t, other, context.Background())
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_ALREADY_RUNNING" ||
		typed.Meta["platformRoot"] != rootA || typed.Meta["pid"] != strconv.Itoa(info.PID) ||
		!strings.Contains(typed.Hint, contracts.ShellCommand("kb-create", "stop", "--platform-root", rootA)) {
		t.Fatalf("other-root start error = %#v; want typed root refusal", err)
	}
	status, err = f.runner.Status(context.Background())
	if err != nil || status.State != StateRunning || status.PID != info.PID {
		t.Fatalf("original root status after other-root operations = %#v, %v", status, err)
	}
	if _, err := f.runner.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSeparateGatewayResourcesCanRunConcurrently(t *testing.T) {
	first := newRunner(t, 10, 5)
	second := newRunner(t, 10, 5)
	firstInfo, err := startProcessForTest(t, first.runner, context.Background())
	if err != nil {
		t.Fatalf("start first root: %v", err)
	}
	secondInfo, err := startProcessForTest(t, second.runner, context.Background())
	if err != nil {
		t.Fatalf("start second root on its separate Gateway: %v", err)
	}
	for _, current := range []struct {
		name   string
		runner *ProcessRunner
		info   Info
	}{{"first", first.runner, firstInfo}, {"second", second.runner, secondInfo}} {
		status, err := current.runner.Status(context.Background())
		if err != nil || status.State != StateRunning || !status.Healthy || status.PID != current.info.PID {
			t.Fatalf("%s root status = %#v, %v; both roots should remain healthy on their separate Gateway resources", current.name, status, err)
		}
	}
}

func TestPortInUse(t *testing.T) {
	f := newRunner(t, 10, 5)
	f.runner.Operation = "apply"
	blocker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", f.port))
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	plan := contracts.ResolvedInstallPlan{Request: contracts.InstallRequest{PlatformRoot: f.runner.PlatformRoot},
		Host: &contracts.HostSpec{HealthURL: fmt.Sprintf("http://127.0.0.1:%d/health", f.port)}}
	if err := CheckPorts(plan, "apply"); err == nil {
		t.Fatal("expected early port conflict")
	} else {
		var typed *diag.Diag
		if !errors.As(err, &typed) || typed.Code != "KB_INSTALL_PORT_IN_USE" || typed.Meta["port"] != fmt.Sprint(f.port) || typed.Meta["pid"] == "" || typed.Meta["command"] == "" {
			t.Fatalf("port diagnostic lacks owner details: %#v", err)
		}
		if runtime.GOOS == "linux" && typed.Meta["pid"] != strconv.Itoa(os.Getpid()) {
			t.Fatalf("port owner pid = %v, want current test process %d", typed.Meta["pid"], os.Getpid())
		}
		wire, marshalErr := diag.ToEnvelope(typed)
		if marshalErr != nil {
			t.Fatalf("marshal actual port preflight diagnostic: %v", marshalErr)
		}
		if wire.Code != "KB_INSTALL_PORT_IN_USE" || wire.Details["port"] != fmt.Sprint(f.port) {
			t.Fatalf("actual kb-create wire diagnostic = %+v, want details.port=%d", wire, f.port)
		}
		if !strings.Contains(typed.Hint, contracts.ShellCommand("kb-create", "apply", "--platform-root", f.runner.PlatformRoot)) ||
			!strings.Contains(typed.Hint, typed.Meta["pid"].(string)) || !strings.Contains(typed.Hint, typed.Meta["command"].(string)) {
			t.Fatalf("port hint omits the owning process or attempted command: %#v", err)
		}
		if !strings.Contains(typed.Hint, contracts.ShellCommand("kb-create", "apply", "--platform-root", f.runner.PlatformRoot, "--gateway-url", "http://127.0.0.1:"+strconv.Itoa(f.port+100))) {
			t.Fatalf("port hint omits explicit Gateway recovery: %#v", err)
		}
	}
	planFailure := CheckPorts(plan, "plan")
	var planDiagnostic *diag.Diag
	if !errors.As(planFailure, &planDiagnostic) || planDiagnostic.Code != "KB_INSTALL_PORT_IN_USE" ||
		!strings.Contains(planDiagnostic.Hint, contracts.ShellCommand("kb-create", "plan", "--platform-root", f.runner.PlatformRoot, "--gateway-url", "http://127.0.0.1:"+strconv.Itoa(f.port+100))) {
		t.Fatalf("plan port diagnostic does not suggest a Gateway address: %#v", planFailure)
	}
	_, err = startProcessForTest(t, f.runner, context.Background())
	if code := launcherCode(t, err); code != "KB_INSTALL_PORT_IN_USE" {
		t.Fatalf("code %s", code)
	}
	if _, statErr := os.Stat(f.runner.State.HostPID()); !os.IsNotExist(statErr) {
		t.Fatal("no process should have been spawned")
	}
}

// case: S-025.8, PC-001.9
func TestPortConflictIdentifiesRegisteredLiveInstallation(t *testing.T) {
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(ProcessIdentityEnv, token)
	root := filepath.Join(t.TempDir(), "KB Labs ' root")
	writeReceipt(t, root, &contracts.HostSpec{Command: fakeHostBinary, HealthURL: "http://127.0.0.1:4100/health"})
	platformRoot := filepath.Join(root, "current")
	launcherHome := t.TempDir()
	t.Setenv(KBHomeEnv, launcherHome)
	t.Setenv("XDG_DATA_HOME", launcherHome)
	expectedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	state, err := StateForRoot(platformRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := state.Ensure(); err != nil {
		t.Fatal(err)
	}
	processIdentity, err := ProcessIdentityForPID(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSONFile(state.HostPID(), pidRecord{PID: os.Getpid(), ProcessIdentity: processIdentity, InstallationID: installationID, PlatformRoot: platformRoot}); err != nil {
		t.Fatal(err)
	}
	if _, err := receipt.Read(platformRoot); err != nil {
		t.Fatalf("fixture receipt: %v", err)
	}
	if active, ok := ActiveHost(state); !ok || active.PID != os.Getpid() || filepath.Clean(active.PlatformRoot) != filepath.Clean(platformRoot) {
		t.Fatalf("fixture active host = %#v, %t", active, ok)
	}
	if err := (gateway.Registry{Path: gateway.RegistryPath("")}).Writer(gateway.Apply).Register(platformRoot, "http://127.0.0.1:4100"); err != nil {
		t.Fatal(err)
	}
	if roots, err := (gateway.Registry{Path: gateway.RegistryPath("")}).Read(); err != nil || len(roots) != 1 {
		t.Fatalf("fixture Gateway roots = %#v, %v", roots, err)
	}

	failure := portConflictError("4100", "127.0.0.1:4100", "gateway", portOwner{PID: strconv.Itoa(os.Getpid()), Command: "kb-host"}, "start", root, nil)
	if failure.Code != "KB_HOST_ALREADY_RUNNING" || failure.Meta["platformRoot"] != expectedRoot || failure.Meta["pid"] != strconv.Itoa(os.Getpid()) {
		t.Fatalf("known installation conflict = %#v", failure)
	}
	stopCommand := contracts.ShellCommand("kb-create", "stop", "--platform-root", expectedRoot)
	if !strings.Contains(failure.Hint, stopCommand) {
		t.Fatalf("known installation conflict omitted its stop command: %#v", failure)
	}
	commands, err := contracts.ParseShellCommands(stopCommand)
	want := []string{"kb-create", "stop", "--platform-root", expectedRoot}
	if err != nil || len(commands) != 1 || !reflect.DeepEqual(commands[0], want) {
		t.Fatalf("stop command does not preserve a root containing spaces and quote: %#v, %v", commands, err)
	}
	if err := writeJSONFile(state.HostPID(), map[string]any{
		"pid": os.Getpid(), "processIdentity": "different-process-identity", "platformRoot": platformRoot,
	}); err != nil {
		t.Fatal(err)
	}
	stale := portConflictError("4100", "127.0.0.1:4100", "gateway",
		portOwner{PID: strconv.Itoa(os.Getpid()), Command: "kb-host"}, "start", root, nil)
	if stale.Code != contracts.CodeHostProcessIdentityStale || strings.Contains(stale.Message, "already running") {
		t.Fatalf("reused PID was identified as the registered installation: %#v", stale)
	}
}

func TestGatewayResourceConflictIdentifiesTheVerifiedLiveOwner(t *testing.T) {
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(ProcessIdentityEnv, token)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	gatewayURL := "http://127.0.0.1:" + port
	root := filepath.Join(t.TempDir(), "running root")
	writeReceipt(t, root, &contracts.HostSpec{Command: fakeHostBinary, HealthURL: gatewayURL + "/health"})
	expectedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	platformRoot := filepath.Join(root, "current")
	t.Setenv(KBHomeEnv, t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	state, err := StateForRoot(platformRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := state.Ensure(); err != nil {
		t.Fatal(err)
	}
	processIdentity, err := ProcessIdentityForPID(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	installationID, err := versionroot.InstallationIDForPath(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSONFile(state.HostPID(), pidRecord{PID: os.Getpid(), ProcessIdentity: processIdentity,
		InstallationID: installationID, PlatformRoot: platformRoot}); err != nil {
		t.Fatal(err)
	}
	if err := (gateway.Registry{Path: gateway.RegistryPath("")}).Writer(gateway.Apply).Register(
		platformRoot, gatewayURL); err != nil {
		t.Fatal(err)
	}

	failure := GatewayResourceConflict(gatewayURL, "apply", filepath.Join(t.TempDir(), "other root"))
	if failure == nil || failure.Code != contracts.CodeHostAlreadyRunning || failure.Meta["platformRoot"] != expectedRoot ||
		failure.Meta["pid"] != strconv.Itoa(os.Getpid()) {
		t.Fatalf("Gateway resource conflict = %#v; want verified running root and PID", failure)
	}
}

func TestPortConflictSurfacesGatewayIndexDiagnosticForRequestedRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "requested platform")
	launcherHome := t.TempDir()
	t.Setenv(KBHomeEnv, launcherHome)
	t.Setenv("XDG_DATA_HOME", launcherHome)
	path := gateway.RegistryPath("")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"schema":1,"roots":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	failure := portConflictError("4100", "127.0.0.1:4100", "gateway",
		portOwner{PID: strconv.Itoa(os.Getpid()), Command: "kb-host"}, "start", root, nil)
	if failure.Code != contracts.CodeGatewayIndexUnavailable || !strings.Contains(failure.Message, path) || !strings.Contains(failure.Hint, root) {
		t.Fatalf("port conflict did not retain Gateway index diagnostic and requested root: %#v", failure)
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
	if err := writeJSONFile(f.runner.State.HostPID(), pidRecord{PID: dead.Process.Pid, PlatformRoot: f.runner.PlatformRoot, StartedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	status, err := f.runner.Status(context.Background())
	if err != nil || status.State != StateStopped || !status.StalePID {
		t.Fatalf("status with stale pid: %+v %v", status, err)
	}
	// Recreate the stale file: Start must clean it and succeed.
	_ = writeJSONFile(f.runner.State.HostPID(), pidRecord{PID: dead.Process.Pid, PlatformRoot: f.runner.PlatformRoot, StartedAt: time.Now()})
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
		t.Fatalf("start over stale pid: %v", err)
	}
}

func TestActiveHostRejectsAReusedPID(t *testing.T) {
	state := State{Dir: t.TempDir()}
	if err := state.Ensure(); err != nil {
		t.Fatal(err)
	}
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	command := startOwnedFakeHost(t, freePort(t), token)
	if err := writeJSONFile(state.HostPID(), map[string]any{
		"pid": command.Process.Pid, "platformRoot": "/tmp/recorded-kb-root", "processIdentity": "different-process-identity",
	}); err != nil {
		t.Fatal(err)
	}
	if active, ok := ActiveHost(state); ok {
		t.Fatalf("reused PID was accepted as the recorded host: %#v", active)
	}
}

func TestStopDoesNotSignalAReusedPID(t *testing.T) {
	f := newRunner(t, 10, 1)
	if err := f.runner.State.Ensure(); err != nil {
		t.Fatal(err)
	}
	foreignIdentity, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	command := startOwnedFakeHost(t, freePort(t), foreignIdentity)
	if err := writeJSONFile(f.runner.State.HostPID(), map[string]any{
		"pid": command.Process.Pid, "platformRoot": f.runner.PlatformRoot, "installationId": f.runner.InstallationID, "processIdentity": "recorded-owner-token",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.Status(context.Background()); err == nil {
		t.Fatal("status accepted a process whose identity differs from the recorded host")
	} else if failure, ok := err.(*diag.Diag); !ok || failure.Code != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("stale process record diagnostic = %#v", err)
	}
	if _, err := f.runner.Stop(context.Background()); err == nil {
		t.Fatal("stop accepted a process whose identity differs from the recorded host")
	}
	if !processAlive(command.Process.Pid) {
		t.Fatal("stop signalled the process after its PID identity failed validation")
	}
}

func TestOldHostRecordWithoutIdentityIsDiagnosedAndNeverSignalled(t *testing.T) {
	f := newRunner(t, 10, 1)
	if err := f.runner.State.Ensure(); err != nil {
		t.Fatal(err)
	}
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	command := startOwnedFakeHost(t, freePort(t), token)
	// This is the host.pid shape written before processIdentity was required.
	if err := writeJSONFile(f.runner.State.HostPID(), map[string]any{
		"pid": command.Process.Pid, "platformRoot": f.runner.PlatformRoot,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.Status(context.Background()); err == nil {
		t.Fatal("status silently treated the old live record as stopped")
	} else if failure, ok := err.(*diag.Diag); !ok || failure.Code != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("old host record diagnostic = %#v", err)
	}
	if _, err := f.runner.Stop(context.Background()); err == nil {
		t.Fatal("stop accepted the old record without process identity")
	} else if failure, ok := err.(*diag.Diag); !ok || failure.Code != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("old host record stop diagnostic = %#v", err)
	}
	if !processAlive(command.Process.Pid) {
		t.Fatal("stop signalled the process for an old record without identity")
	}
}

func TestX26RecordWithoutInstallationIDFailsClosed(t *testing.T) {
	f := newRunner(t, 10, 1)
	if err := f.runner.State.Ensure(); err != nil {
		t.Fatal(err)
	}
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	command := startOwnedFakeHost(t, freePort(t), token)
	if err := writeJSONFile(f.runner.State.HostPID(), map[string]any{
		"pid": command.Process.Pid, "processIdentity": token, "platformRoot": f.runner.PlatformRoot,
	}); err != nil {
		t.Fatal(err)
	}
	for _, action := range []struct {
		name string
		run  func() error
	}{
		{name: "status", run: func() error { _, err := f.runner.Status(context.Background()); return err }},
		{name: "stop", run: func() error { _, err := f.runner.Stop(context.Background()); return err }},
	} {
		t.Run(action.name, func(t *testing.T) {
			err := action.run()
			failure, ok := err.(*diag.Diag)
			if !ok || failure.Code != contracts.CodeHostProcessIdentityStale {
				t.Fatalf("x26 record diagnostic = %#v", err)
			}
			if !processAlive(command.Process.Pid) {
				t.Fatal("operation signalled the live process from an x26-format record")
			}
		})
	}
}

func TestStatusReportsAProcessRecordFromPreviousBootAsStale(t *testing.T) {
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(ProcessIdentityEnv, token)
	f := newRunner(t, 10, 1)
	if err := f.runner.State.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONFile(f.runner.State.HostPID(), pidRecord{
		PID: os.Getpid(), ProcessIdentity: "recorded-before-reboot", InstallationID: f.runner.InstallationID,
		PlatformRoot: f.runner.PlatformRoot,
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(f.runner.State.HostPID()) })
	if _, err := f.runner.Status(context.Background()); err == nil {
		t.Fatal("status accepted a process identity from a previous boot")
	} else if failure, ok := err.(*diag.Diag); !ok || failure.Code != contracts.CodeHostProcessIdentityStale {
		t.Fatalf("previous-boot status diagnostic = %#v", err)
	}
}

func TestProcessIdentityDistinguishesAReusedPID(t *testing.T) {
	token, err := NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(ProcessIdentityEnv, token)
	identity, err := ProcessIdentityForPID(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if ProcessIdentityOf(os.Getpid(), identity) != ProcessIdentityMatch {
		t.Fatal("current process did not match its captured instance token")
	}
	if ProcessIdentityOf(os.Getpid(), identity+"-reused") == ProcessIdentityMatch {
		t.Fatal("current process matched a different instance token")
	}
}

func TestCorruptPidFileIsStale(t *testing.T) {
	f := newRunner(t, 10, 5)
	_ = f.runner.State.Ensure()
	_ = os.WriteFile(f.runner.State.HostPID(), []byte("not json"), 0o600)
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
		t.Fatalf("start over corrupt pid: %v", err)
	}
}

func TestForcedStopWhenTermIgnored(t *testing.T) {
	f := newRunner(t, 10, 1, "-ignore-term")
	info, err := startProcessForTest(t, f.runner, context.Background())
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
	f.runner.Operation = "apply"
	f.runner.PlatformRoot = "/tmp/platform"
	_, err := startProcessForTest(t, f.runner, context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Meta["exitCode"] != "7" ||
		!strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), "fakehost: exiting early") {
		t.Fatalf("process exit diagnostic = %#v; want exit code and stderr tail", err)
	}
	if typed.Message != "The host process failed while starting." || typed.Reason == "" || typed.Cause == "" ||
		typed.Meta["nextCommand"] != "kb-create apply" {
		t.Fatalf("apply startup diagnostic = %#v; want catalog message, concrete reason, and apply retry", typed)
	}
	if _, statErr := os.Stat(f.runner.State.HostPID()); !os.IsNotExist(statErr) {
		t.Fatal("pid file must be removed after a failed start")
	}
	data, _ := os.ReadFile(f.runner.State.HostLog())
	if len(data) == 0 {
		t.Fatal("host output should be captured in the log file")
	}
	launcherLog, err := os.ReadFile(f.runner.State.LauncherLog())
	if err != nil || !strings.Contains(string(launcherLog), "host.start.failed") || !strings.Contains(string(launcherLog), "exit code 7") {
		t.Fatalf("launcher failure log = %q, %v; want the process exit reason", launcherLog, err)
	}
}

func TestStartIdentityTimeoutTerminatesAndReapsHost(t *testing.T) {
	f := newRunner(t, 1, 5)
	childPID := 0
	f.runner.identityReader = func(pid int) (string, error) {
		childPID = pid
		return "", errors.New("injected process environment unavailable")
	}
	_, err := startProcessForTest(t, f.runner, context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Meta["waited"] == nil ||
		!strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), "fakehost: ready") {
		t.Fatalf("identity timeout diagnostic = %#v; want elapsed time and stderr tail", err)
	}
	if f.runner.pid != 0 {
		t.Fatalf("runner retained child PID %d after failed start", f.runner.pid)
	}
	if childPID == 0 || processAlive(childPID) {
		t.Fatalf("host child PID %d remains alive after failed start", childPID)
	}
	if _, statErr := os.Stat(f.runner.State.HostPID()); !os.IsNotExist(statErr) {
		t.Fatalf("pid file must be absent after failed start: %v", statErr)
	}
	if conn, dialErr := net.DialTimeout("tcp", f.runner.Spec.HealthAddress(), 200*time.Millisecond); dialErr == nil {
		_ = conn.Close()
		t.Fatal("host listener remains after identity timeout")
	}
}

func TestStartWaitsPastFormerIdentityLimitForDelayedMatch(t *testing.T) {
	f := newRunner(t, 3, 5)
	started := time.Now()
	childPID := 0
	f.runner.identityReader = func(pid int) (string, error) {
		childPID = pid
		if time.Since(started) < 1100*time.Millisecond {
			return "", errProcessEnvironmentNotReady
		}
		return ProcessIdentityForPID(pid)
	}
	info, err := startProcessForTest(t, f.runner, context.Background())
	if err != nil {
		t.Fatalf("delayed valid identity should start successfully: %v", err)
	}
	if info.PID == 0 || info.PID != childPID || !processAlive(info.PID) {
		t.Fatalf("host PID %d is not alive after delayed identity verification", info.PID)
	}
	if _, err := os.Stat(f.runner.State.HostPID()); err != nil {
		t.Fatalf("verified host PID record was not published: %v", err)
	}
	if elapsed := time.Since(started); elapsed < 1100*time.Millisecond {
		t.Fatalf("identity wait lasted %s; want more than the former one-second bound", elapsed)
	}
	if _, err := f.runner.Stop(context.Background()); err != nil {
		t.Fatalf("stop delayed host: %v", err)
	}
}

func TestReadyTimeoutKillsHost(t *testing.T) {
	f := newRunner(t, 1, 5, "-unhealthy")
	_, err := startProcessForTest(t, f.runner, context.Background())
	if code := launcherCode(t, err); code != "KB_HOST_START_FAILED" {
		t.Fatalf("code %s", code)
	}
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Meta["readinessURL"] != f.runner.Spec.HealthURL ||
		typed.Meta["readinessStatus"] != "500" || typed.Meta["waited"] == nil ||
		!strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), "fakehost: ready") {
		t.Fatalf("readiness diagnostic = %#v; want URL, last status, elapsed wait, and stderr tail", err)
	}
	if _, dialErr := net.DialTimeout("tcp", f.runner.Spec.HealthAddress(), 200*time.Millisecond); dialErr == nil {
		t.Fatal("unhealthy host must be killed after the ready timeout")
	}
}

func TestTypedStartupEnvelopeIsTheHostFailureCause(t *testing.T) {
	f := newRunner(t, 10, 5, "-startup-error")
	f.runner.SecretEnv = func() (secrets.Environment, error) {
		return secrets.Environment{Values: map[string]string{"API_TOKEN": "fake-secret-token"}}, nil
	}
	_, err := startProcessForTest(t, f.runner, context.Background())
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_CONFIG_INVALID" ||
		typed.Meta["hostStartupCode"] != "KB_CONFIG_INVALID" ||
		!strings.Contains(typed.Cause, "positive integer") ||
		typed.Meta["path"] != "platform.adapterOptions.analytics.retentionDays" ||
		!strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), `"code":"KB_CONFIG_INVALID"`) ||
		strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), "fake-secret-token") ||
		!strings.Contains(fmt.Sprint(typed.Meta["stderrTail"]), "[REDACTED]") ||
		typed.Message != "Adapter option \"platform.adapterOptions.analytics.retentionDays\" is invalid: must be a positive integer." {
		t.Fatalf("typed startup diagnostic = %#v; want original catalogued config error with host evidence", err)
	}
}

func TestTypedConfigStartupFailureKeepsReadinessEvidence(t *testing.T) {
	configFailure := diag.New("KB_CONFIG_INVALID", "Analytics retention must be a positive integer.",
		diag.WithCause("platform.adapterOptions.analytics.retentionDays must be a positive integer"),
		diag.WithMeta(map[string]any{"path": "platform.adapterOptions.analytics.retentionDays"}))
	envelope, err := diag.ToEnvelope(configFailure)
	if err != nil {
		t.Fatalf("serialize config failure: %v", err)
	}
	stderr, err := json.Marshal(map[string]any{"ok": false, "error": envelope})
	if err != nil {
		t.Fatalf("marshal config failure: %v", err)
	}

	failure := StartFailure(State{Dir: t.TempDir()}, errors.New("readiness check failed"), map[string]string{
		"stderrTail": string(stderr), "waited": "5s", "readinessURL": "http://127.0.0.1:5250/health",
		"readinessError": "connection refused",
	})
	result, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("serialize startup failure: %v", err)
	}
	if result.Code != "KB_CONFIG_INVALID" || result.Details["path"] != "platform.adapterOptions.analytics.retentionDays" ||
		result.Details["waited"] != "5s" || result.Details["readinessURL"] != "http://127.0.0.1:5250/health" ||
		result.Details["readinessError"] != "connection refused" {
		t.Fatalf("startup envelope = %+v; want the original config error and catalogued readiness evidence", result)
	}
}

// case: S-222.11
func TestHostEnvironmentSuppressesCompletedBootstrapPasswordFromAllSources(t *testing.T) {
	t.Setenv(secrets.BootstrapPasswordEnvironment, "inherited-bootstrap-password")
	runner := newRunner(t, 10, 5)
	runner.runner.Spec.Env = map[string]string{secrets.BootstrapPasswordEnvironment: "spec-bootstrap-password"}
	runner.runner.SecretEnv = func() (secrets.Environment, error) {
		return secrets.Environment{
			Values:     map[string]string{secrets.BootstrapPasswordEnvironment: "stored-bootstrap-password"},
			Suppressed: []string{secrets.BootstrapPasswordEnvironment},
		}, nil
	}

	environment, err := runner.runner.environment()
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range environment {
		if strings.HasPrefix(entry, secrets.BootstrapPasswordEnvironment+"=") {
			t.Fatalf("completed host environment contains bootstrap password: %q", entry)
		}
	}
}

func TestStderrTailIsLimitedToFortyLines(t *testing.T) {
	buffer := &tailBuffer{limit: 64 * 1024}
	for i := 0; i < 80; i++ {
		_, _ = fmt.Fprintf(buffer, "line-%02d\n", i)
	}
	tail := strings.Split(buffer.String(), "\n")
	if len(tail) != 40 || tail[0] != "line-40" || tail[len(tail)-1] != "line-79" {
		t.Fatalf("stderr tail = %d lines, first %q last %q; want last 40 lines", len(tail), tail[0], tail[len(tail)-1])
	}
}

func TestStatusReportsUnhealthy(t *testing.T) {
	f := newRunner(t, 10, 5)
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
		t.Fatal(err)
	}
	// Point the health probe at a dead path on the same server by stopping
	// the answer: use a spec whose URL returns 404.
	record, ok := f.runner.readPID()
	if !ok {
		t.Fatal("running host record is missing")
	}
	record.HealthURL = fmt.Sprintf("http://127.0.0.1:%d/missing", f.port)
	if err := writeJSONFile(f.runner.State.HostPID(), record); err != nil {
		t.Fatal(err)
	}
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
	_, err := startProcessForTest(t, f.runner, context.Background())
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
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: host, ServiceGraph: contracts.ServiceGraph{PlatformVersion: "1.0.0", Services: []contracts.Service{{ID: "host"}}}}
	if err := receipt.Write(stage, contracts.InstallReceipt{ID: "r1", InstallationID: installationID, Plan: plan}); err != nil {
		t.Fatal(err)
	}
	if _, err := layout.ActivateInitial(stage, "1.0.0", "host-test"); err != nil {
		t.Fatal(err)
	}
}

func TestNewRunnerRunsTheHostTheReceiptDeclares(t *testing.T) {
	root := t.TempDir()
	writeReceipt(t, root, &contracts.HostSpec{Command: "bin/host", HealthURL: "http://127.0.0.1:9/health"})
	runner, err := NewRunner(root)
	if err != nil {
		t.Fatal(err)
	}
	layout, _ := versionroot.New(root)
	rootState, stateErr := StateForRoot(layout.InstallRoot())
	installationID, identityErr := versionroot.InstallationIDForPath(root)
	if runner.Spec.Command != filepath.Join(layout.PlatformRoot(), "bin/host") || stateErr != nil || identityErr != nil || runner.State != rootState || runner.SecretEnv == nil || runner.Identity.InstallationID != installationID {
		t.Fatalf("runner: %#v", runner)
	}
}

func TestNewRunnerRejectsReceiptWithoutInstallationIdentity(t *testing.T) {
	root := t.TempDir()
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, Host: &contracts.HostSpec{Command: "host", HealthURL: "http://127.0.0.1:9/health"}}
	if err := receipt.Write(root, contracts.InstallReceipt{ID: "transaction-id", Plan: plan}); err != nil {
		t.Fatal(err)
	}
	_, err := NewRunner(root)
	if launcherCode(t, err) != contracts.CodeReceiptUnavailable {
		t.Fatalf("missing installation identity error = %v", err)
	}
}

func TestNewRunnerRejectsAnInstallationWithoutAValidHost(t *testing.T) {
	cases := map[string]*contracts.HostSpec{
		"no host (a receipt from before the host-only launcher)": nil,
		"non-loopback health URL":                                {Command: "host", HealthURL: "http://10.0.0.1:1/health"},
	}
	for name, spec := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			writeReceipt(t, root, spec)
			_, err := NewRunner(root)
			if code := launcherCode(t, err); code != contracts.CodeHostSpecInvalid {
				t.Fatalf("code %s", code)
			}
			var failure *diag.Diag
			if !errors.As(err, &failure) {
				t.Fatalf("invalid host error is not structured: %v", err)
			}
			wire, marshalErr := diag.ToEnvelope(failure)
			if marshalErr != nil || wire.Code != contracts.CodeHostSpecInvalid {
				t.Fatalf("invalid host diagnostic cannot be serialized: envelope=%+v error=%v", wire, marshalErr)
			}
		})
	}
	if _, err := NewRunner(t.TempDir()); launcherCode(t, err) != "KB_INSTALL_RECEIPT_UNAVAILABLE" {
		t.Fatalf("a missing receipt must be reported as such: %v", err)
	}
}

func TestRootConflictNamesPidWhenRootIsUnknown(t *testing.T) {
	failure := RootConflict("", 4242)
	if failure.Code != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("code = %q", failure.Code)
	}
	if !strings.Contains(failure.Hint, "Stop process 4242") || strings.Contains(failure.Hint, "--platform-root") {
		t.Fatalf("hint must name the pid, not an unmatchable stop command: %q", failure.Hint)
	}
	known := RootConflict("/tmp/KB Labs ' A", 7)
	want := contracts.ShellCommand("kb-create", "stop", "--platform-root", "/tmp/KB Labs ' A")
	if !strings.Contains(known.Hint, want) {
		t.Fatalf("hint = %q", known.Hint)
	}
	envelope, err := diag.ToEnvelope(known)
	if err != nil || envelope.Details["nextCommand"] != want {
		t.Fatalf("root conflict envelope command = %q, error = %v", envelope.Details["nextCommand"], err)
	}
}
