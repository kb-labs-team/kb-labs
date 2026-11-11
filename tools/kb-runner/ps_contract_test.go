//go:build darwin || linux

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func psJSONRecords(t *testing.T, state string) []map[string]any {
	t.Helper()
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"ps", "--state", state, "--json"}, &stdout, &stderr)
	if status.Code() != 0 {
		t.Fatalf("ps --json exit = %d; stderr=%s", status.Code(), stderr.String())
	}
	var listing struct {
		Runs []map[string]any `json:"runs"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &listing); err != nil {
		t.Fatalf("decode ps --json output %q: %v", stdout.String(), err)
	}
	return listing.Runs
}

func psLeftoversJSONEntries(t *testing.T, state string) []map[string]any {
	t.Helper()
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"ps", "--leftovers", "--state", state, "--json"}, &stdout, &stderr)
	if status.Code() != 0 {
		t.Fatalf("ps --leftovers --json exit = %d; stderr=%s", status.Code(), stderr.String())
	}
	var entries []map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &entries); err != nil {
		t.Fatalf("decode ps --leftovers --json output %q: %v", stdout.String(), err)
	}
	return entries
}

func assertNoJSONStringContains(t *testing.T, value any, forbidden string, path string) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			assertNoJSONStringContains(t, item, forbidden, path+"."+key)
		}
	case []any:
		for index, item := range typed {
			assertNoJSONStringContains(t, item, forbidden, fmt.Sprintf("%s[%d]", path, index))
		}
	case string:
		if strings.Contains(typed, forbidden) {
			t.Fatalf("JSON contract field %s leaks the state-directory layout: %q", path, typed)
		}
	}
}

// Script-level record consumers (the orchestration event daemon and any
// future reader) must read run records only through this JSON contract. The
// test runs a real run to a terminal record and asserts every field such
// consumers read is present, and that no record field leaks the state
// directory layout.
// case: S-237.75
func TestPSJSONCarriesEveryRecordFieldRecordConsumersRead(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("process supervision supports Linux and macOS")
	}
	state := t.TempDir()
	run, err := proc.Start(cancellableProcTestContext(t), proc.Config{StateDir: state, Tag: "contract-check", Stall: 30 * time.Minute,
		StdoutPath: filepath.Join(state, "out"), StderrPath: filepath.Join(state, "err"),
		Command: []string{"/bin/sh", "-c", `exit "$1"`, "sh", "0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Wait(); err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	deadline := time.Now().Add(testdeadline.Budget(t))
	for {
		records := psJSONRecords(t, state)
		if len(records) == 1 {
			if records[0]["status"] == "completed" {
				record = records[0]
				break
			}
		} else if len(records) > 1 {
			t.Fatalf("ps --json listed %d records for one finished run: %v", len(records), records)
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("ps --json never listed the finished run as completed: %v", records)
		}
		time.Sleep(10 * time.Millisecond)
	}
	for field, want := range map[string]any{
		"run_id":    run.RunID,
		"tag":       "contract-check",
		"status":    "completed",
		"exit_code": float64(0),
		"stall_ms":  float64(30 * time.Minute / time.Millisecond),
	} {
		got, ok := record[field]
		if !ok {
			t.Fatalf("ps --json record omits consumer field %q: %v", field, record)
		}
		if got != want {
			t.Fatalf("ps --json field %q = %v, want %v", field, got, want)
		}
	}
	for _, field := range []string{"started_at", "duration_ms", "command", "pid"} {
		if _, ok := record[field]; !ok {
			t.Fatalf("ps --json record omits consumer field %q: %v", field, record)
		}
	}
	assertNoJSONStringContains(t, record, state, "$")
}

// The leftovers JSON contract attributes every uncleaned owned resource to
// its owning run, so outcome publishers never compose resource ledger paths.
// case: S-237.75
func TestPSLeftoversJSONAttributesEveryLeftoverToItsRun(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("process supervision supports Linux and macOS")
	}
	state := t.TempDir()
	runner := buildRunnerBinary(t)
	tag := "x164-lost-resource"
	ownedPath := filepath.Join(state, "owned-path")
	childPIDFile := filepath.Join(state, "child.pid")
	script := `"$1" own path --create file "$2"; printf '%s' "$$" > "$3"; exec /bin/sleep 30`
	runCommand := exec.Command(runner, "run", "--tag", tag, "--state", state,
		"--stall", "1h", "--stdout", filepath.Join(state, "stdout"), "--stderr", filepath.Join(state, "stderr"),
		"--", "/bin/sh", "-c", script, "sh", runner, ownedPath, childPIDFile)
	var run proc.RunInfo
	var childPID int
	var childIdentity string
	if err := runCommand.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if run.RunID != "" {
			if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGTERM); err != nil {
				t.Logf("stop recorded run %s during cleanup: %v", run.RunID, err)
			}
		}
		_ = runCommand.Process.Kill()
		_ = runCommand.Wait()
	})
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		listing := proc.List(state)
		if listing.Error != nil {
			t.Fatalf("list active test run: %v", listing.Error)
		}
		for _, candidate := range listing.Runs {
			if candidate.Tag == tag && candidate.Status == proc.StatusRunning {
				run = candidate
			}
		}
		if run.PID != 0 && fileExists(childPIDFile) && fileExists(ownedPath) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if run.PID == 0 {
		t.Fatalf("run %q did not become visible", tag)
	}
	pidData, err := os.ReadFile(childPIDFile)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err = strconv.Atoi(string(pidData))
	if err != nil {
		t.Fatal(err)
	}
	childIdentity, alive, err := proc.ProcessIdentity(childPID)
	if err != nil || !alive || childIdentity == "" {
		t.Fatalf("inspect test-owned child %d: identity=%q alive=%t error=%v", childPID, childIdentity, alive, err)
	}
	if err := os.Remove(ownedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ownedPath, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGKILL); err != nil {
		t.Fatalf("signal recorded keeper: %v", err)
	}
	terminalDeadline := time.Now().Add(testdeadline.Budget(t))
	runID := ""
	for time.Now().Before(terminalDeadline) {
		listing := proc.List(state)
		for _, candidate := range listing.Runs {
			if candidate.Tag == tag && candidate.Status.Terminal() {
				run = candidate
				runID = candidate.RunID
			}
		}
		if runID != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if runID == "" {
		t.Fatalf("keeper loss never became terminal; status=%q", run.Status)
	}
	entries := psLeftoversJSONEntries(t, state)
	if len(entries) != 1 {
		t.Fatalf("ps --leftovers --json returned %d entries, want the one failed resource: %v", len(entries), entries)
	}
	entry := entries[0]
	if entry["run_id"] != runID {
		t.Fatalf("leftover entry does not name its owning run: want run_id %q, got %v", runID, entry)
	}
	if entry["kind"] != "path" {
		t.Fatalf("leftover entry kind = %v, want path", entry["kind"])
	}
	if entry["id"] != ownedPath {
		t.Fatalf("leftover entry id = %v, want %q", entry["id"], ownedPath)
	}
	outcome, _ := entry["outcome"].(string)
	if outcome != "refused" && outcome != "failed" {
		t.Fatalf("leftover entry outcome = %v, want refused or failed", entry["outcome"])
	}
	if message, _ := entry["error"].(string); message == "" {
		t.Fatalf("leftover entry omits its failure reason: %v", entry)
	}
	assertNoJSONStringContains(t, entries, state+string(filepath.Separator)+"runs", "$")
}

// case: S-237.75
func TestPSJSONContractsAreEmptyOnAnUnusedStateDirectory(t *testing.T) {
	state := t.TempDir()
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"ps", "--state", state, "--json"}, &stdout, &stderr)
	var listing struct {
		Runs []map[string]any `json:"runs"`
	}
	if status.Code() != 0 || json.Unmarshal(stdout.Bytes(), &listing) != nil || len(listing.Runs) != 0 {
		t.Fatalf("ps --json on an unused state directory = %d %q, want 0 with an empty runs array; stderr=%s", status.Code(), stdout.String(), stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	status = executeInvocation("kb-runner", []string{"ps", "--leftovers", "--state", state, "--json"}, &stdout, &stderr)
	if status.Code() != 0 || strings.TrimSpace(stdout.String()) != "[]" {
		t.Fatalf("ps --leftovers --json on an unused state directory = %d %q, want 0 %q; stderr=%s", status.Code(), stdout.String(), "[]", stderr.String())
	}
}
