package host

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/secrets"
)

func TestBoundResidueLogMovesAnOversizeFileAside(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 100)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := boundResidueLog(path, 100); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Size() != 100 {
		t.Fatalf("a file within its budget must be left alone: %v %v", info, err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("y", 101)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := boundResidueLog(path, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("an oversize residue file must be moved aside, stat err = %v", err)
	}
	if data, err := os.ReadFile(path + ".1"); err != nil || len(data) != 101 {
		t.Fatalf("the previous generation must be kept: %d bytes, %v", len(data), err)
	}
	if err := boundResidueLog(filepath.Join(t.TempDir(), "absent.log"), 100); err != nil {
		t.Fatalf("a missing residue file is not an error: %v", err)
	}
}

// The helper process plays the launcher: it starts the host through
// ProcessRunner.Start, reports where it is and waits to be killed.
func TestLauncherHelperProcess(t *testing.T) {
	if os.Getenv("KB_TEST_LAUNCHER_HELPER") != "1" {
		t.Skip("helper process of TestHostKeepsLoggingAfterItsLauncherIsKilled")
	}
	f := newRunner(t, 10, 5)
	if _, err := f.runner.Start(context.Background()); err != nil {
		fmt.Println("START-FAILED", err)
		os.Exit(2)
	}
	fmt.Println("READY", f.port, f.runner.State.HostLog())
	time.Sleep(time.Minute)
}

// The host runs in its own process group and outlives a killed launcher
// (`halt` SIGKILLs the supervisor). Its raw stdout/stderr must keep landing in
// host.log, and a console.error must not crash it with EPIPE.
func TestHostKeepsLoggingAfterItsLauncherIsKilled(t *testing.T) {
	tmp := t.TempDir()
	helper := exec.Command(os.Args[0], "-test.run=^TestLauncherHelperProcess$")
	helper.Env = append(os.Environ(), "KB_TEST_LAUNCHER_HELPER=1", "TMPDIR="+tmp)
	stdout, err := helper.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	var port int
	var hostLog string
	var hostPID int
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "START-FAILED") {
			t.Fatalf("helper launcher failed: %s", line)
		}
		if fields := strings.Fields(line); len(fields) == 3 && fields[0] == "READY" {
			port, _ = strconv.Atoi(fields[1])
			hostLog = fields[2]
			break
		}
	}
	if port == 0 {
		t.Fatalf("helper never reported READY: %v", scanner.Err())
	}
	if raw, err := os.ReadFile(filepath.Join(filepath.Dir(hostLog), "host.pid")); err == nil {
		var record pidRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			t.Fatal(err)
		}
		hostPID = record.PID
	}
	t.Cleanup(func() {
		if hostPID > 0 {
			_ = syscall.Kill(-hostPID, syscall.SIGKILL)
		}
	})
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = helper.Wait()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: 5 * time.Second}
	if resp, err := client.Get(base + "/emit"); err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("host did not survive its launcher: %v %v", resp, err)
	}
	if resp, err := client.Get(base + "/health"); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("host is not healthy after its launcher died: %v %v", resp, err)
	}
	var data []byte
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		data, _ = os.ReadFile(hostLog)
		if strings.Contains(string(data), "console.error line") && strings.Contains(string(data), "stdout line") {
			return
		}
	}
	t.Fatalf("host.log lacks the lines written after the launcher died:\n%s", data)
}

// Start is where the launcher bounds the residue file and names the
// structured log path for the platform logger.
func TestStartBoundsResidueLogAndPassesTheStructuredLogPath(t *testing.T) {
	envDump := filepath.Join(t.TempDir(), "env.txt")
	f := newRunner(t, 10, 5, "-dump-env", envDump)
	if err := f.runner.State.Ensure(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.runner.State.HostLog(), []byte(strings.Repeat("o", int(HostResidueLogBytes)+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startProcessForTest(t, f.runner, context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(f.runner.State.HostLog() + ".1"); err != nil {
		t.Fatalf("Start did not bound the oversize residue log: %v", err)
	}
	env, err := os.ReadFile(envDump)
	if err != nil {
		t.Fatal(err)
	}
	if want := "KB_LOG_FILE=" + f.runner.State.HostStructuredLog(); !strings.Contains(string(env), want) {
		t.Fatalf("host environment lacks %s", want)
	}
}

// A host that reports why it cannot start through the platform logger writes
// that cause to host.jsonl, not to the raw residue file; the startup diagnostic
// must still carry it, redacted, name both files, and leave out info records.
func TestStartupFailureCarriesTheStructuredLogCause(t *testing.T) {
	f := newRunner(t, 10, 5, "-log-error", "database rejected fake-secret-token", "-exit", "7")
	f.runner.SecretEnv = func() (secrets.Environment, error) {
		return secrets.Environment{Values: map[string]string{"API_TOKEN": "fake-secret-token"}}, nil
	}
	_, err := startProcessForTest(t, f.runner, context.Background())
	var typed *diag.Diag
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_START_FAILED" {
		t.Fatalf("startup failure = %#v; want KB_HOST_START_FAILED", err)
	}
	tail := fmt.Sprint(typed.Meta["structuredLogTail"])
	if !strings.Contains(tail, "ERROR database rejected [REDACTED]") {
		t.Fatalf("structuredLogTail = %q; want the host's error record, redacted and readable", tail)
	}
	if strings.Contains(tail, "fake-secret-token") || strings.Contains(tail, `"level"`) || strings.Contains(tail, "fakehost: starting") {
		t.Fatalf("structuredLogTail = %q; want no secret, no raw JSON and no info record", tail)
	}
	if typed.Meta["structuredLog"] != f.runner.State.HostStructuredLog() || typed.Meta["log"] != f.runner.State.HostLog() {
		t.Fatalf("diagnostic paths = %v / %v; want both host log files", typed.Meta["log"], typed.Meta["structuredLog"])
	}
	if !strings.Contains(typed.Hint, f.runner.State.HostStructuredLog()) || !strings.Contains(typed.Hint, f.runner.State.HostLog()) {
		t.Fatalf("hint = %q; want both host log paths named", typed.Hint)
	}
}

func TestStructuredTailReadsFromTheStartOffsetAndSurvivesRotation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.jsonl")
	old := `{"level":50,"time":1000,"msg":"previous run"}` + "\n"
	fresh := `{"level":60,"time":2000,"msg":"this run","err":{"message":"boom"}}` + "\n" + "not json\n"
	if err := os.WriteFile(path, []byte(old+fresh), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := structuredTail(path, int64(len(old))).String(); got != "1970-01-01T00:00:02Z FATAL this run: boom" {
		t.Fatalf("tail from offset = %q", got)
	}
	if got := structuredTail(path, 1<<30).String(); !strings.Contains(got, "previous run") || !strings.Contains(got, "this run") {
		t.Fatalf("tail of a rotated (shorter) file = %q; want it read from the start", got)
	}
}
