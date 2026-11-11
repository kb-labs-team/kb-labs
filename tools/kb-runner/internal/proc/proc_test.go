//go:build darwin || linux

package proc_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"github.com/kb-labs/kb-runner/internal/testutil"
)

type stableHostResourceSource struct{}

func (stableHostResourceSource) Snapshot() proc.HostResourceSnapshot {
	return proc.HostResourceSnapshot{
		PhysicalMemory: 1 << 50, AvailableMemory: 1 << 50,
		MemoryAvailableKnown: true, LogicalCPUs: 64,
	}
}

func startTest(ctx context.Context, cfg proc.Config) (*proc.Run, error) {
	return proc.StartWithHostResourceSource(ctx, cfg, stableHostResourceSource{})
}

func cancellableTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	t.Cleanup(cancel)
	return ctx
}

// case: S-237.56
func TestLauncherExitTerminatesItsSpawnedRun(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	childPIDFile := filepath.Join(state, "child.pid")
	command := exec.Command(runner, "run", "--tag", "launcher-owned", "--state", state,
		"--stall", "1h", "--stdout", filepath.Join(state, "out"), "--stderr", filepath.Join(state, "err"),
		"--", "/bin/sh", "-c", `echo $$ > "$1"; exec /bin/sleep 30`, "sh", childPIDFile)
	var launcherOutput lockedTestBuffer
	command.Stdout = &launcherOutput
	command.Stderr = &launcherOutput
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	var childPID int
	var childIdentity string
	t.Cleanup(func() {
		if command.Process != nil && command.ProcessState == nil {
			if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("kill launcher process %d during cleanup: %v", command.Process.Pid, err)
			}
			if _, err := command.Process.Wait(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("wait for launcher process %d during cleanup: %v", command.Process.Pid, err)
			}
		}
		records, err := filepath.Glob(filepath.Join(state, "runs", "*.json"))
		if err != nil {
			t.Errorf("find test-owned run records during cleanup: %v", err)
		} else {
			for _, path := range records {
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					t.Errorf("read test-owned run record %s during cleanup: %v", path, readErr)
					continue
				}
				var owner struct {
					RunID     string `json:"run_id"`
					PID       int    `json:"pid"`
					StartedAt string `json:"started_at"`
				}
				if err := json.Unmarshal(data, &owner); err != nil {
					t.Errorf("decode test-owned run record %s during cleanup: %v", path, err)
					continue
				}
				if err := proc.SignalRecordedKeeper(state, owner.RunID, syscall.SIGTERM); err != nil {
					t.Errorf("stop test-owned run %s during cleanup: %v", owner.RunID, err)
				}
			}
		}
	})
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(childPIDFile)
		if err == nil {
			childPID, err = strconv.Atoi(strings.TrimSpace(string(data)))
			if err == nil {
				childIdentity, _, err = proc.ProcessIdentity(childPID)
				if err == nil && childIdentity != "" {
					break
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID == 0 || childIdentity == "" {
		t.Fatalf("launcher did not start a verifiable child: pid=%d identity=%q", childPID, childIdentity)
	}
	var recordObservationError string
	if !waitUntil(5*time.Second, func() bool {
		observed, err := runRecordContainsProcess(state, childPID, childIdentity)
		if err != nil {
			recordObservationError = err.Error()
		}
		return observed
	}) {
		t.Fatalf("keeper did not record launcher-owned child before launcher termination: %s; %s", recordObservationError, processTestDiagnostic(t, childPID, state, launcherOutput.String()))
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("terminated launcher reported a successful exit")
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		identity, alive, err := proc.ProcessIdentity(childPID)
		if err == nil && (!alive || identity != childIdentity) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("launcher-owned child survived launcher termination: %s", processTestDiagnostic(t, childPID, state, launcherOutput.String()))
}

func runRecordContainsProcess(stateDir string, pid int, identity string) (bool, error) {
	paths, err := filepath.Glob(filepath.Join(stateDir, "runs", "*.json"))
	if err != nil {
		return false, fmt.Errorf("find run records: %w", err)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return false, fmt.Errorf("read run record %s: %w", path, err)
		}
		var record struct {
			Observed []struct {
				PID      int    `json:"pid"`
				Identity string `json:"identity"`
			} `json:"observed"`
		}
		if err := json.Unmarshal(data, &record); err != nil {
			return false, fmt.Errorf("decode run record %s: %w", path, err)
		}
		for _, process := range record.Observed {
			if process.PID == pid && process.Identity == identity {
				return true, nil
			}
		}
	}
	return false, nil
}

// case: S-237.1
func TestNormalExitRemovesDescendantsAndWritesExitEvent(t *testing.T) {
	state := t.TempDir()
	helper := buildHelper(t)
	runner := buildRunner(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	readyFile := filepath.Join(state, "descendant.pid")
	cmd := exec.CommandContext(ctx, runner, "run", "--tag", "normal", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"), "--", helper, "detached", "3", readyFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		signalRecordedKeepers(t, state)
		skipOnTeardownObservationFailure(t, state, outputRunID(t, state, "normal"))
		stderr, _ := os.ReadFile(filepath.Join(state, "stderr.log"))
		events, _ := os.ReadFile(filepath.Join(state, "events.jsonl"))
		t.Fatalf("kb-runner normal exit failed: %v\n%s\nstderr: %s\nevents: %s", err, output, stderr, events)
	}
	if !strings.Contains(string(output), "run normal completed") {
		t.Fatalf("kb-runner did not report completion: %s", output)
	}
	descendant, err := waitPIDFile(readyFile, 5*time.Second)
	if err != nil {
		t.Fatalf("setsid descendant did not report a complete PID: %v; output: %s", err, output)
	}
	identity, found := identityForTest(t, descendant)
	if found {
		t.Cleanup(func() {
			if current, ok := identityForTest(t, descendant); ok && current == identity {
				if err := syscall.Kill(descendant, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
					t.Logf("cleanup detached test process %d: %v", descendant, err)
				}
			}
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if current, ok := identityForTest(t, descendant); !ok || current != identity {
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			t.Logf("test-owned descendant %d remains after bounded cleanup", descendant)
		})
	}
	descendantEscapedSampling := false
	if processExists(t, descendant) {
		if runtime.GOOS != "darwin" {
			t.Fatalf("descendant %d remains alive after normal command exit", descendant)
		}
		descendantEscapedSampling = true
		if err != nil {
			t.Fatalf("same-uid process without ancestry history or marker dirtied teardown: %v", err)
		}
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Status != proc.StatusCompleted || len(listing.Runs[0].Tree) != 0 {
		t.Fatalf("tree remains after normal exit: %+v", listing)
	}
	assertEvent(t, state, "exit")
	assertEvent(t, state, "teardown")
	teardown := eventOfType(t, state, proc.EventTeardown)
	if len(teardown.Reaped)+len(teardown.Unverified) == 0 && teardown.Error == "" && !descendantEscapedSampling {
		t.Fatalf("teardown event omitted the process cleanup inventory: %+v", teardown)
	}
	if descendantEscapedSampling {
		for _, process := range append(append(teardown.Reaped, teardown.Unverified...), teardown.Remaining...) {
			if process.PID == descendant {
				t.Fatalf("descendant without ancestry history or marker was still classified as owned: %+v", process)
			}
		}
	}
	skipOnTeardownObservationFailure(t, state, outputRunID(t, state, "normal"))
}

func TestSuccessfulRunStatusTimestampEventAndStdoutTee(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	stdoutPath := filepath.Join(state, "stdout.log")
	command := exec.Command(runner, "run", "--tag", "costprobe", "--state", state, "--stall", "1m",
		"--stdout", stdoutPath, "--stderr", filepath.Join(state, "stderr.log"), "--", "/bin/echo", "ok")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run successful command: %v\n%s", err, output)
	}
	if got := string(output); got != "ok\nrun costprobe completed\n" {
		t.Fatalf("terminal output = %q, want child output tee and completion line", got)
	}
	if data, err := os.ReadFile(stdoutPath); err != nil || string(data) != "ok\n" {
		t.Fatalf("stdout file = %q, err=%v", data, err)
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Status != proc.StatusCompleted {
		t.Fatalf("successful run listing = %+v", listing)
	}
	if listing.Runs[0].StartedAt == nil || listing.Runs[0].StartedAt.IsZero() {
		t.Fatalf("successful run has no timestamp: %+v", listing.Runs[0])
	}
	if listing.Runs[0].Identity == "" {
		t.Fatalf("successful run has no process identity: %+v", listing.Runs[0])
	}
	exit := eventOfType(t, state, proc.EventExit)
	if exit.Status != proc.StatusCompleted || exit.ExitCode == nil || *exit.ExitCode != 0 {
		t.Fatalf("exit event = %+v, want completed with code 0", exit)
	}
}

// case: S-237.42
func TestRunScratchEnvironmentIsRemovedAndKeptOutputSurvives(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	kept := filepath.Join(state, "kept.txt")
	scratchPathFile := filepath.Join(state, "scratch-path")
	command := exec.Command(runner, "run", "--tag", "scratch", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"), "--keep", kept, "--keep", "private", "--", "/bin/sh", "-ec", `printf '%s' "$TMPDIR" > "$2"; printf scratch > "$TMPDIR/private"; printf discard > "$TMPDIR/discard"; printf kept > "$3"; "$1" own path --create dir "$TMPDIR/owned"; test "$TMPDIR" = "$TMP" && test "$TMP" = "$TEMP" && test "$TMP" = "$KB_RUNNER_SCRATCH"`, "sh", runner, scratchPathFile, kept)
	output, err := command.CombinedOutput()
	runID := outputRunID(t, state, "scratch")
	scratch := scratchForRun(t, state, runID)
	t.Cleanup(func() {
		if err := os.RemoveAll(scratch); err != nil {
			t.Errorf("remove test scratch %s: %v", scratch, err)
		}
	})
	if err != nil {
		skipOnTeardownObservationFailure(t, state, runID)
		t.Fatalf("run with scratch environment: %v\n%s", err, output)
	}
	scratchBytes, err := os.ReadFile(scratchPathFile)
	if err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(filepath.Join(string(scratchBytes), "private")); err != nil || string(content) != "scratch" {
		t.Fatalf("kept scratch output = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(string(scratchBytes), "discard")); !os.IsNotExist(err) {
		t.Fatalf("undeclared scratch output remains: %v", err)
	}
	if content, err := os.ReadFile(kept); err != nil || string(content) != "kept" {
		t.Fatalf("kept output = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(state, "stdout.log")); err != nil {
		t.Fatalf("implicit stdout keep missing: %v", err)
	}
	leftovers, err := proc.Leftovers(state)
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("kept scratch output appeared as a leftover: %+v, %v", leftovers, err)
	}
	assertExactlyOneScratchOutcome(t, state, eventOfType(t, state, proc.EventTeardown), string(proc.ResourceRemoved))
	skipOnTeardownObservationFailure(t, state, runID)
}

// case: S-237.41
func TestRunScratchRemovesReadOnlyGoModuleContent(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	command := exec.Command(runner, "run", "--tag", "readonly-scratch", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"), "--", "/bin/sh", "-ec", `mkdir -p "$TMPDIR/go/pkg/mod/example"; printf source > "$TMPDIR/go/pkg/mod/example/decode_test.go"; chmod 0444 "$TMPDIR/go/pkg/mod/example/decode_test.go"; chmod 0555 "$TMPDIR/go/pkg/mod/example" "$TMPDIR/go/pkg/mod" "$TMPDIR/go"`)
	output, err := command.CombinedOutput()
	runID := outputRunID(t, state, "readonly-scratch")
	scratch := scratchForRun(t, state, runID)
	t.Cleanup(func() {
		_ = filepath.WalkDir(scratch, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return os.Chmod(path, 0o700)
			}
			return nil
		})
		if err := os.RemoveAll(scratch); err != nil {
			t.Errorf("remove test-owned scratch %s: %v", scratch, err)
		}
	})
	if _, err := os.Lstat(scratch); !os.IsNotExist(err) {
		t.Fatalf("read-only scratch remains at %s: %v", scratch, err)
	}
	assertExactlyOneScratchOutcome(t, state, eventOfType(t, state, proc.EventTeardown), string(proc.ResourceRemoved))
	if err != nil {
		skipOnTeardownObservationFailure(t, state, runID)
		t.Fatalf("read-only scratch run failed: %v\n%s", err, output)
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Status != proc.StatusCompleted {
		t.Fatalf("read-only scratch cleanup status = %+v", listing)
	}
}

// case: S-237.41
func TestCanceledKeeperStartupRemovesRegisteredScratch(t *testing.T) {
	state := t.TempDir()
	stdoutFIFO := filepath.Join(state, "stdout.fifo")
	if err := syscall.Mkfifo(stdoutFIFO, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan error, 1)
	go func() {
		_, err := proc.StartWithHostResourceSource(ctx, proc.Config{
			StateDir: state, Tag: "canceled-startup", Stall: time.Hour,
			StdoutPath: stdoutFIFO, StderrPath: filepath.Join(state, "stderr.log"),
			Command: []string{"/bin/sleep", "30"},
		}, stableHostResourceSource{})
		started <- err
	}()
	t.Cleanup(cancel)

	type runRecord struct {
		Scratch string `json:"scratch"`
	}
	deadline := time.NewTimer(5 * time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	var scratch string
waitForScratch:
	for {
		paths, err := filepath.Glob(filepath.Join(state, "runs", "*.json"))
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var record runRecord
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatal(err)
			}
			if record.Scratch != "" {
				scratch = record.Scratch
				break waitForScratch
			}
		}
		select {
		case err := <-started:
			t.Fatalf("keeper startup completed before scratch registration: %v", err)
		case <-deadline.C:
			t.Fatal("keeper did not register scratch before the FIFO output open blocked")
		case <-ticker.C:
		}
	}
	t.Cleanup(func() {
		_ = filepath.WalkDir(scratch, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return os.Chmod(path, 0o700)
			}
			return nil
		})
		if err := os.RemoveAll(scratch); err != nil {
			t.Errorf("remove test-owned scratch %s: %v", scratch, err)
		}
	})
	cancel()
	select {
	case err := <-started:
		if err == nil {
			t.Fatal("canceled keeper startup returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled keeper startup did not return promptly")
	}
	if _, err := os.Lstat(scratch); !os.IsNotExist(err) {
		t.Fatalf("canceled startup left scratch %s: %v", scratch, err)
	}
}

func TestRunScratchAllowsUnixSocketNameUnderDeepStateDirectory(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is unavailable")
	}
	stateRoot, err := os.MkdirTemp("/tmp", "x71-socket-state-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(stateRoot); err != nil {
			t.Errorf("remove deep socket test state %s: %v", stateRoot, err)
		}
	})
	state := filepath.Join(stateRoot, strings.Repeat("deep-state-segment-", 4), "logs", "runner")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := buildRunner(t)
	boundFile := filepath.Join(state, "socket-bound")
	nodeScript := `const path=require('path');const paths=[path.join(process.env.TMPDIR,'x'.repeat(40)),path.join(process.env.TMPDIR,'tsx-501','12345.pipe')];if(Buffer.byteLength(paths[0])+1>104) throw new Error('path too long for Unix socket: '+Buffer.byteLength(paths[0]));const bind=i=>{const s=require('net').createServer();s.listen(paths[i],()=>s.close(()=>{if(i+1<paths.length)bind(i+1);else require('fs').writeFileSync(process.argv[1],'bound')}))};bind(0)`
	command := exec.Command(runner, "run", "--tag", "scratch-socket", "--state", state, "--stall", "1h",
		"--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"), "--",
		"/bin/sh", "-ec", `mkdir -p "$TMPDIR/tsx-501"; node -e "`+nodeScript+`" "`+boundFile+`"`,
	)
	output, err := command.CombinedOutput()
	runID := outputRunID(t, state, "scratch-socket")
	recordPath, recordErr := proc.RunRecordFile(state, runID)
	if recordErr != nil {
		t.Fatalf("resolve socket run record: %v", recordErr)
	}
	data, recordErr := os.ReadFile(recordPath)
	if recordErr != nil {
		t.Fatalf("read socket run record: %v", recordErr)
	}
	var runRecord struct {
		Scratch string `json:"scratch"`
	}
	if err := json.Unmarshal(data, &runRecord); err != nil {
		t.Fatal(err)
	}
	if runRecord.Scratch == "" {
		t.Fatal("run record omitted scratch path")
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(runRecord.Scratch); err != nil {
			t.Errorf("remove socket test scratch %s: %v", runRecord.Scratch, err)
		}
	})
	if err != nil {
		skipOnTeardownObservationFailure(t, state, runID)
		stderr, _ := os.ReadFile(filepath.Join(state, "stderr.log"))
		t.Fatalf("supervised child could not bind socket below TMPDIR: %v\n%s\nchild stderr: %s", err, output, stderr)
	}
	if data, err := os.ReadFile(boundFile); err != nil || string(data) != "bound" {
		stderr, _ := os.ReadFile(filepath.Join(state, "stderr.log"))
		t.Fatalf("supervised child did not bind its Unix socket: marker=%q err=%v stderr=%s", data, err, stderr)
	}
	if _, err := os.Stat(runRecord.Scratch); !os.IsNotExist(err) {
		t.Fatalf("scratch remains after supervised child exit at %s: %v", runRecord.Scratch, err)
	}
	skipOnTeardownObservationFailure(t, state, runID)
}

func TestRunScratchReplacementWithDifferentInodeIsRefused(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	scratchPathFile := filepath.Join(state, "scratch-path")
	command := exec.Command(runner, "run", "--tag", "scratch-replaced", "--state", state, "--stall", "1h",
		"--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"), "--",
		"/bin/sh", "-ec", `printf '%s' "$TMPDIR" > "$1"; mv "$TMPDIR" "$TMPDIR.original"; mkdir "$TMPDIR"; printf replacement > "$TMPDIR/marker"`, "sh", scratchPathFile)
	output, runErr := command.CombinedOutput()
	runID := outputRunID(t, state, "scratch-replaced")
	if runErr == nil {
		t.Fatalf("run with replaced scratch directory succeeded; unsafe scratch removal was not reported\n%s", output)
	}
	exit := eventOfType(t, state, proc.EventExit)
	if exit.ExitCode == nil || *exit.ExitCode != 0 || exit.Signal != "" {
		t.Fatalf("replacement child did not exit successfully: %+v", exit)
	}
	scratchBytes, err := os.ReadFile(scratchPathFile)
	if err != nil {
		t.Fatalf("run did not report scratch path: %v", err)
	}
	scratch := string(scratchBytes)
	originalScratch := scratch + ".original"
	t.Cleanup(func() {
		if err := os.RemoveAll(scratch); err != nil {
			t.Errorf("remove test replacement scratch %s: %v", scratch, err)
		}
		if err := os.RemoveAll(originalScratch); err != nil {
			t.Errorf("remove replaced original scratch %s: %v", originalScratch, err)
		}
	})
	marker, err := os.ReadFile(filepath.Join(scratch, "marker"))
	if err != nil || string(marker) != "replacement" {
		t.Fatalf("replacement scratch was removed or changed: data=%q err=%v", marker, err)
	}
	teardown := eventOfType(t, state, proc.EventTeardown)
	assertExactlyOneScratchOutcome(t, state, teardown, string(proc.ResourceRefused))
	var refusal string
	resources, err := proc.ResourceOutcomes(state, teardown.RunID)
	if err != nil {
		t.Fatal(err)
	}
	for _, resource := range resources {
		if resource.Kind == "scratch" {
			refusal = resource.Error
		}
	}
	if refusal == "" || !strings.Contains(teardown.Error, refusal) {
		t.Fatalf("teardown error %q does not identify the refused scratch cleanup %q", teardown.Error, refusal)
	}
	skipOnTeardownObservationFailure(t, state, runID)
	if teardown.Error != "remove run scratch: "+refusal {
		t.Fatalf("runner exited for a different teardown error: %q", teardown.Error)
	}
}

// case: S-237.44
func TestRunScratchSymlinkReplacementRefusesWithoutTouchingTarget(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	scratchPathFile := filepath.Join(state, "scratch-path")
	command := exec.Command(runner, "run", "--tag", "scratch-symlink", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"), "--", "/bin/sh", "-ec", `printf '%s' "$TMPDIR" > "$2"; rm -rf "$TMPDIR"; ln -s "$1" "$TMPDIR"`, "sh", outside, scratchPathFile)
	_, _ = command.CombinedOutput()
	scratchBytes, err := os.ReadFile(scratchPathFile)
	if err != nil {
		t.Fatalf("run did not report scratch path: %v", err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "keep" {
		t.Fatalf("scratch cleanup touched symlink target: data=%q err=%v", data, err)
	}
	if target, err := os.Readlink(string(scratchBytes)); err != nil || target != outside {
		t.Fatalf("scratch symlink replacement changed: target=%q err=%v", target, err)
	}
	teardown := eventOfType(t, state, proc.EventTeardown)
	assertExactlyOneScratchOutcome(t, state, teardown, string(proc.ResourceRefused))
}

// case: S-237.41
func TestRunScratchIsRemovedAfterNonzeroExitAndSignal(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	for _, outcome := range []struct {
		tag    string
		script string
		stall  string
	}{{tag: "nonzero", script: `printf '%s' "$TMPDIR" > "$1"; exit 7`, stall: "1h"}, {tag: "signal", script: `printf '%s' "$TMPDIR" > "$1"; kill -TERM $$`, stall: "1h"}, {tag: "stall", script: `printf '%s' "$TMPDIR" > "$1"; /bin/sleep 0.3`, stall: "100ms"}} {
		scratchPathFile := filepath.Join(state, outcome.tag+"-scratch")
		command := exec.Command(runner, "run", "--tag", outcome.tag, "--state", state, "--stall", outcome.stall, "--stdout", filepath.Join(state, outcome.tag+".out"), "--stderr", filepath.Join(state, outcome.tag+".err"), "--", "/bin/sh", "-c", outcome.script, "sh", scratchPathFile)
		_, _ = command.CombinedOutput()
		scratchBytes, err := os.ReadFile(scratchPathFile)
		if err != nil {
			t.Fatalf("run %s did not write its scratch path: %v", outcome.tag, err)
		}
		if _, err := os.Stat(string(scratchBytes)); !os.IsNotExist(err) {
			t.Fatalf("run %s scratch remains at %s: %v", outcome.tag, scratchBytes, err)
		}
		if outcome.tag == "stall" {
			assertEvent(t, state, "stall")
		}
		assertExactlyOneScratchOutcome(t, state, eventOfType(t, state, proc.EventTeardown), string(proc.ResourceRemoved))
	}
}

func assertExactlyOneScratchOutcome(t *testing.T, state string, event proc.Event, expected string) {
	t.Helper()
	resources, err := proc.ResourceOutcomes(state, event.RunID)
	if err != nil {
		t.Errorf("read run resource outcomes: %v", err)
		return
	}
	count := 0
	for _, resource := range resources {
		if resource.Kind == "scratch" {
			count++
			if resource.Outcome != expected {
				t.Errorf("scratch outcome = %q, want %q", resource.Outcome, expected)
			}
		}
	}
	if count != 1 {
		t.Errorf("scratch outcomes = %d, want exactly one: %+v", count, resources)
	}
}

// case: S-237.1
func TestKilledSupervisorReapsSetsidDescendant(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	descendantPIDFile := filepath.Join(state, "descendant.pid")
	sleepPIDFile := filepath.Join(state, "sleep.pid")
	releaseIntermediate := filepath.Join(state, "release-intermediate")
	var cmd *exec.Cmd
	if runtime.GOOS == "linux" {
		helper := buildHelper(t)
		cmd = exec.Command(runner, "run", "--state", state, "--tag", "sigkill", "--stall", "1h", "--stdout", filepath.Join(state, "out"), "--stderr", filepath.Join(state, "err"), "--", "/bin/sh", "-c", `"$1" double-fork-held 4 "$2" "$4" & printf 'descendant-ready %s\n' "$!"; /bin/sleep 30 & echo $! > "$3"; wait`, "sh", helper, descendantPIDFile, sleepPIDFile, releaseIntermediate)
	} else {
		cmd = exec.Command(runner, "run", "--state", state, "--tag", "sigkill", "--stall", "1h", "--stdout", filepath.Join(state, "out"), "--stderr", filepath.Join(state, "err"), "--", "/bin/sh", "-c", `echo "descendant-ready $$"; echo $$ > "$1"; echo $$ > "$2"; exec /bin/sleep 30`, "sh", descendantPIDFile, sleepPIDFile)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr lockedTestBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	var descendant int
	var owned []proc.Process
	started := make(map[int]string)
	var stopTeardownFollower context.CancelFunc
	var teardownFollowerDone <-chan error
	followerWaited := false
	stdoutReadDone := make(chan struct{})
	t.Cleanup(func() {
		if stopTeardownFollower != nil {
			stopTeardownFollower()
			if teardownFollowerDone != nil && !followerWaited {
				select {
				case followErr := <-teardownFollowerDone:
					if followErr != nil && !errors.Is(followErr, context.Canceled) && !errors.Is(followErr, context.DeadlineExceeded) {
						t.Logf("stop teardown event follower: %v", followErr)
					}
				case <-time.After(time.Second):
					t.Log("teardown event follower did not stop after cancellation")
				}
			}
		}
		if listing := proc.List(state); listing.Error == nil {
			for _, run := range listing.Runs {
				owned = append(owned, run.Tree...)
			}
		}
		if !waited {
			if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Logf("cleanup test supervisor: %v", err)
			}
		}
		signalRecordedKeepers(t, state)
		if !waited {
			if err := testutil.WaitAfterPipeRead(cmd, stdoutReadDone); err != nil {
				t.Logf("wait for killed test supervisor: %v", err)
			}
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			alive := false
			for pid, identity := range started {
				if current, ok := identityForTest(t, pid); ok && current == identity {
					alive = true
				}
			}
			if !alive {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Logf("test-owned process identities remain after bounded cleanup: %v", started)
		// Keep this integration fixture from leaving test processes behind when
		// the local sandbox denies the product's complete process snapshot.
		for pid, identity := range started {
			current, alive := identityForTest(t, pid)
			if alive && current == identity {
				if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
					t.Logf("force-stop test-owned process %d after failed cleanup: %v", pid, err)
				}
			}
		}
	})
	scanner := bufio.NewScanner(stdout)
	line := make(chan string, 1)
	go func() {
		defer close(stdoutReadDone)
		if scanner.Scan() {
			line <- scanner.Text()
			return
		}
		line <- ""
	}()
	select {
	case ready := <-line:
		if !strings.HasPrefix(ready, "descendant-ready ") {
			t.Fatalf("setsid descendant did not become ready: %q; stderr: %s", ready, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("setsid descendant readiness timed out")
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Status != proc.StatusRunning {
		t.Fatalf("run did not become live before SIGKILL: %+v", listing)
	}
	descendant, err = waitPIDFile(descendantPIDFile, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	descendantIdentity, descendantAlive, descendantIdentityErr := proc.ProcessIdentity(descendant)
	if descendantIdentityErr != nil || !descendantAlive || descendantIdentity == "" {
		t.Fatalf("setsid descendant is not identifiable before supervisor kill: pid=%d identity=%q alive=%t err=%v; %s", descendant, descendantIdentity, descendantAlive, descendantIdentityErr, processTestDiagnostic(t, descendant, state, stderr.String()))
	}
	started[descendant] = descendantIdentity
	sleepPID, err := waitPIDFile(sleepPIDFile, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if identity, ok := identityForTest(t, sleepPID); ok {
		started[sleepPID] = identity
	}
	var found bool
	_, found = identityForTest(t, descendant)
	if !found {
		t.Fatalf("setsid descendant %d disappeared before supervisor kill", descendant)
	}
	owned = append(owned, listing.Runs[0].Tree...)
	for _, process := range listing.Runs[0].Tree {
		started[process.PID] = process.Identity
	}
	followCtx, followCancel := context.WithTimeout(context.Background(), 10*time.Second)
	stopTeardownFollower = followCancel
	teardownSeen := make(chan proc.Event, 1)
	followOutput := teardownEventFollowWriter{cancel: followCancel, events: teardownSeen}
	followerDone := make(chan error, 1)
	teardownFollowerDone = followerDone
	go func() {
		followerDone <- proc.Events(followCtx, state, true, []proc.EventType{proc.EventTeardown}, 0, &followOutput)
	}()
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if !waitUntil(5*time.Second, func() bool {
		for pid, identity := range started {
			current, alive := identityForTest(t, pid)
			if t.Failed() || alive && current == identity {
				return false
			}
		}
		for _, process := range owned {
			current, alive := identityForTest(t, process.PID)
			if t.Failed() || alive && current == process.Identity {
				return false
			}
		}
		return true
	}) {
		events, _ := os.ReadFile(filepath.Join(state, "events.jsonl"))
		logRawTeardownFieldSizes(t, events)
		for pid, identity := range started {
			current, alive := identityForTest(t, pid)
			t.Logf("supervisor post-SIGKILL identity expected=%s current=%s alive=%t %s", identity, current, alive, processTestDiagnostic(t, pid, state, stderr.String()))
		}
		for _, process := range owned {
			current, alive := identityForTest(t, process.PID)
			t.Logf("supervisor post-SIGKILL owned expected=%s current=%s alive=%t %s", process.Identity, current, alive, processTestDiagnostic(t, process.PID, state, stderr.String()))
		}
		t.Fatalf("recorded process identities survived supervisor SIGKILL; descendant_pid=%d sleep_pid=%d started=%v; stderr: %s",
			descendant, sleepPID, started, stderr.String())
	}
	var followedTeardown proc.Event
	select {
	case followedTeardown = <-teardownSeen:
	case followErr := <-followerDone:
		followerWaited = true
		if errors.Is(followErr, context.Canceled) {
			select {
			case followedTeardown = <-teardownSeen:
			default:
				t.Fatalf("teardown event follower stopped without observing teardown")
			}
		} else {
			t.Fatalf("teardown event follower ended before teardown appeared: %v", followErr)
		}
	}
	if followedTeardown.RunID != listing.Runs[0].RunID || followedTeardown.Type != proc.EventTeardown {
		t.Fatalf("teardown event follower returned %+v for run %s", followedTeardown, listing.Runs[0].RunID)
	}
	select {
	case followErr := <-followerDone:
		followerWaited = true
		if followErr != nil && !errors.Is(followErr, context.Canceled) {
			t.Fatalf("teardown event follower failed after teardown: %v", followErr)
		}
	case <-time.After(time.Second):
		t.Fatal("teardown event follower did not stop after teardown")
	}
	eventFile, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatalf("open lifecycle event stream after process identities ended: %v", err)
	}
	var teardownEvents []proc.Event
	eventReadErr := proc.ReadEvents(eventFile, func(event proc.Event) error {
		if event.Type == proc.EventTeardown {
			teardownEvents = append(teardownEvents, event)
		}
		return nil
	})
	closeErr := eventFile.Close()
	if eventReadErr != nil || closeErr != nil {
		t.Fatalf("read lifecycle event stream after process identities ended: %v", errors.Join(eventReadErr, closeErr))
	}
	if len(teardownEvents) != 1 {
		t.Fatalf("teardown event count after process identities ended = %d, want 1", len(teardownEvents))
	}
	teardown := teardownEvents[0]
	if teardown.Error != "" || len(teardown.Remaining) != 0 {
		t.Fatalf("teardown outcome after process identities ended = error %q, remaining %v", teardown.Error, teardown.Remaining)
	}
	listing = proc.List(state)
	if listing.Error != nil {
		t.Fatalf("read terminal run state after process identities ended: %v", listing.Error)
	}
	if len(listing.Runs) != 1 || !listing.Runs[0].Status.Terminal() {
		t.Fatalf("terminal run state after process identities ended = %+v", listing.Runs)
	}
	if err := testutil.WaitAfterPipeRead(cmd, stdoutReadDone); err != nil {
		t.Logf("wait for SIGKILLed test supervisor: %v", err)
	}
	waited = true
}

type teardownEventFollowWriter struct {
	cancel context.CancelFunc
	events chan<- proc.Event
}

func (writer *teardownEventFollowWriter) Write(data []byte) (int, error) {
	if err := proc.ReadEvents(bytes.NewReader(data), func(event proc.Event) error {
		if event.Type == proc.EventTeardown {
			select {
			case writer.events <- event:
			default:
			}
			writer.cancel()
		}
		return nil
	}); err != nil {
		return 0, err
	}
	return len(data), nil
}

func logRawTeardownFieldSizes(t *testing.T, data []byte) {
	t.Helper()
	for lineNumber, line := range bytes.Split(data, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(line, &fields); err != nil {
			t.Logf("raw event line %d bytes=%d decode_error=%q", lineNumber+1, len(line)+1, err)
			continue
		}
		var eventType proc.EventType
		if err := json.Unmarshal(fields["type"], &eventType); err != nil || eventType != proc.EventTeardown {
			continue
		}
		keys := make([]string, 0, len(fields))
		for key := range fields {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		t.Logf("raw teardown event line %d total_bytes=%d", lineNumber+1, len(line)+1)
		for _, key := range keys {
			t.Logf("raw teardown field %s bytes=%d", key, len(fields[key]))
		}
	}
}

// case: S-237.2
func TestSilentLeafEmitsOneStallEvent(t *testing.T) {
	state := t.TempDir()
	helper := buildHelper(t)
	leafPIDFile := filepath.Join(state, "leaf.pid")
	releaseFile := filepath.Join(state, "release-leaves")
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "stall", Stall: 250 * time.Millisecond,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{helper, "hold", leafPIDFile, releaseFile},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRun(t, run)
	// Registered after cleanupRun, so LIFO order releases the held leaf before
	// the run kill: the leaf exits on its own and the keeper reaps the attributable process tree.
	t.Cleanup(func() { releaseHeldLeaves(t, releaseFile) })
	if _, err := waitPIDFile(leafPIDFile, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if !waitUntil(5*time.Second, func() bool {
		listing := proc.List(state)
		return listing.Error == nil && len(listing.Runs) == 1 && listing.Runs[0].Status == proc.StatusStalled
	}) {
		t.Fatalf("silent run never became visibly stalled: %+v", proc.List(state))
	}
	if !waitUntil(2*time.Second, func() bool { return countEvents(t, state, "stall") == 1 }) {
		t.Fatalf("stall event count = %d, want 1", countEvents(t, state, "stall"))
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Status != proc.StatusStalled || listing.Runs[0].ElapsedMS <= 0 || len(listing.Runs[0].Tree) == 0 {
		t.Fatalf("ps listing does not distinguish a stalled run with elapsed tree: %+v", listing)
	}
	runner := buildRunner(t)
	psOutput := outputPS(t, runner, state)
	if !strings.Contains(psOutput, "\tSTALLED\t") || !strings.Contains(psOutput, "elapsed=") {
		t.Fatalf("kb-runner ps does not show stalled run and tree elapsed time: %s", psOutput)
	}
	leaves := eventLeaves(t, state, "stall")
	var foundLeaf bool
	for _, leaf := range leaves {
		if leaf.Command == filepath.Base(helper) && !leaf.Unverified && leaf.ElapsedMS > 0 && leaf.Identity != "" {
			foundLeaf = true
		}
	}
	if !foundLeaf {
		t.Fatalf("stall event leaves = %+v, want the command's verified held leaf with elapsed time and identity", leaves)
	}
}

// case: S-237.7
func TestDarwinAncestryHistoryReapsDetachedDescendant(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS ancestry sampling contract")
	}
	state := t.TempDir()
	helper := buildHelper(t)
	pidFile := filepath.Join(state, "grandchild.pid")
	releaseFile := filepath.Join(state, "release-command")
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "darwin-sampled-descendant", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{helper, "double-fork-system-held", "30", pidFile, releaseFile},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRun(t, run)
	t.Cleanup(func() {
		if err := os.WriteFile(releaseFile, []byte("release after test\n"), 0o600); err != nil && !os.IsNotExist(err) {
			t.Logf("release test-owned intermediate during cleanup: %v", err)
		}
	})
	grandchild, err := waitPIDFile(pidFile, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	grandchildIdentity, alive := identityForTest(t, grandchild)
	if !alive {
		t.Fatalf("fixture grandchild %d exited before ownership sampling", grandchild)
	}
	t.Cleanup(func() {
		if identity, exists := identityForTest(t, grandchild); exists && identity == grandchildIdentity {
			if err := run.Kill(); err != nil {
				t.Logf("stop run owning detached grandchild %d: %v", grandchild, err)
			}
			if err := run.Wait(); err != nil {
				t.Logf("wait for run owning detached grandchild %d: %v", grandchild, err)
			}
		}
	})
	if !waitUntil(2*time.Second, func() bool {
		listing := proc.List(state)
		if listing.Error != nil || len(listing.Runs) != 1 {
			return false
		}
		for _, process := range listing.Runs[0].Tree {
			if process.PID == grandchild && !process.Unverified && process.Identity != "" {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("sampler did not record detached PID %d as verified: %+v", grandchild, proc.List(state))
	}
	time.Sleep(350 * time.Millisecond)
	if err := os.WriteFile(releaseFile, []byte("release\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run.Wait(); err != nil {
		skipOnTeardownObservationFailure(t, state, run.RunID)
		t.Fatalf("keeper failed after detached command exit: %v", err)
	}
	if _, alive := identityForTest(t, grandchild); alive {
		t.Fatalf("sampled detached grandchild %d survived tree teardown", grandchild)
	}
	skipOnTeardownObservationFailure(t, state, run.RunID)
}

// case: S-237.13
func TestRunOwnershipInspectionKeepsProcessTableFailureUnknown(t *testing.T) {
	state := filepath.Join(t.TempDir(), "missing-state")
	owned, err := proc.RunOwnsProcess(state, "run-1", 200, "worker-start")
	if err == nil || owned {
		t.Fatalf("RunOwnsProcess = (%t, %v), want explicit inspection error", owned, err)
	}
	active, err := proc.RunTagActive(state, "review-task")
	if err == nil || active {
		t.Fatalf("RunTagActive = (%t, %v), want explicit inspection error", active, err)
	}
}

func TestStartUsesRunIDAllocatedBeforeDispatch(t *testing.T) {
	state := t.TempDir()
	runID, err := proc.AllocateRunID()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	run, err := proc.Start(ctx, proc.Config{
		StateDir: state, Tag: runID, RunID: runID, Stall: time.Minute,
		StdoutPath: filepath.Join(t.TempDir(), "stdout.log"),
		StderrPath: filepath.Join(t.TempDir(), "stderr.log"),
		Command:    []string{"/bin/sh", "-c", "exit 0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.RunID != runID {
		t.Fatalf("started run ID = %q, want preallocated %q", run.RunID, runID)
	}
	if err := run.Wait(); err != nil {
		t.Fatal(err)
	}
	listing := proc.List(state)
	if listing.Error != nil {
		t.Fatal(listing.Error)
	}
	for _, record := range listing.Runs {
		if record.RunID == runID && record.Status == proc.StatusCompleted {
			return
		}
	}
	t.Fatalf("completed run %s is missing from durable registry: %+v", runID, listing.Runs)
}

// case: S-237.13
func TestUnrelatedSameUIDProcessIsNotOwnedByRun(t *testing.T) {
	state := t.TempDir()
	sleepPath, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	unrelated := exec.Command(sleepPath, "30")
	if err := unrelated.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if unrelated.Process != nil {
			if err := unrelated.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Logf("stop test-owned unrelated process: %v", err)
			}
			if err := unrelated.Wait(); err != nil {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || !wasKilledByTest(exitErr) {
					t.Logf("wait for test-owned unrelated process: %v", err)
				}
			}
		}
	})
	if _, alive := identityForTest(t, unrelated.Process.Pid); !alive {
		t.Fatal("test-owned unrelated process exited before the run started")
	}

	run, err := proc.Start(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "unrelated-same-uid", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{sleepPath, "3"},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRun(t, run)
	if !waitUntil(2*time.Second, func() bool {
		tree, treeErr := proc.ProcessTree(int(run.PID), run.RunID)
		if treeErr != nil {
			return false
		}
		for _, process := range tree {
			if process.PID == unrelated.Process.Pid {
				t.Fatalf("same-uid process without ownership evidence appeared in run tree: %+v", process)
			}
			if process.Command == "sleep" && process.PID != unrelated.Process.Pid {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("supervised sleep was not visible or process-table observation failed: %+v", proc.List(state))
	}
	if err := run.Wait(); err != nil {
		t.Fatalf("unrelated same-uid process dirtied clean run teardown: %v", err)
	}
	if _, alive := identityForTest(t, unrelated.Process.Pid); !alive {
		t.Fatal("supervisor signalled unrelated same-uid process")
	}
}

func wasKilledByTest(err *exec.ExitError) bool {
	status, ok := err.Sys().(syscall.WaitStatus)
	return ok && status.Signaled() && status.Signal() == syscall.SIGKILL
}

// case: S-237.3
func TestListShowsLiveTreeAndDetectsDeadKeeper(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "list", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/bin/sleep", "30"},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRun(t, run)
	output, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
	if err != nil {
		t.Fatalf("kb-runner ps failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "RUNNING") || !strings.Contains(string(output), "  └─") || !strings.Contains(string(output), "sleep") {
		t.Fatalf("separate kb-runner ps did not show the live tree: %s", output)
	}
	if err := run.Kill(); err != nil {
		t.Fatal(err)
	}
	if !waitUntil(3*time.Second, func() bool {
		listing, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
		return err == nil && strings.Contains(string(listing), "DEAD")
	}) {
		listing, _ := exec.Command(runner, "ps", "--state", state).CombinedOutput()
		t.Fatalf("dead keeper was reported as live: %s", listing)
	}
	if err := run.Wait(); err != nil {
		t.Logf("wait for stopped test run: %v", err)
	}
	assertSignalExitEvent(t, state)
}

// case: S-237.4
func TestEventsAreStructuredJSONL(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	runCtx, cancelRun := context.WithTimeout(context.Background(), 15*time.Second)
	run, err := startTest(runCtx, proc.Config{
		StateDir: state, Tag: "events", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/usr/bin/true"},
	})
	if err != nil {
		cancelRun()
		t.Fatal(err)
	}
	runFinished := false
	t.Cleanup(func() {
		cancelRun()
		if runFinished {
			return
		}
		if err := run.Kill(); err != nil {
			t.Logf("stop structured-event test run %s: %v", run.RunID, err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for structured-event test run %s: %v", run.RunID, err)
		}
	})
	waitErr := run.Wait()
	runFinished = true
	if waitErr != nil {
		skipOnTeardownObservationFailure(t, state, run.RunID)
		t.Fatal(waitErr)
	}
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Logf("close test event stream: %v", err)
		}
	}()
	eventTypes := make([]proc.EventType, 0, 4)
	exitHasCode := false
	readErr := proc.ReadEvents(f, func(event proc.Event) error {
		if event.Schema != proc.EventSchema || event.RunID == "" || event.At.IsZero() || event.Type == "" {
			return fmt.Errorf("incomplete structured event: %+v", event)
		}
		if event.Type == "exit" && event.ExitCode != nil && *event.ExitCode == 0 {
			exitHasCode = true
		}
		eventTypes = append(eventTypes, event.Type)
		return nil
	})
	if readErr != nil {
		t.Fatal(readErr)
	}
	wantLifecycle := []proc.EventType{proc.EventQueued, proc.EventStart, proc.EventExit, proc.EventTeardown}
	if !sameEventTypes(eventTypes, wantLifecycle) {
		t.Fatalf("lifecycle event sequence = %v, want %v", eventTypes, wantLifecycle)
	}
	if !exitHasCode {
		t.Fatal("normal exit event has no exit code")
	}
	skipOnTeardownObservationFailure(t, state, run.RunID)

	followState := t.TempDir()
	followRun, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: followState, Tag: "follow", Stall: time.Hour,
		StdoutPath: filepath.Join(followState, "stdout.log"), StderrPath: filepath.Join(followState, "stderr.log"),
		Command: []string{"/usr/bin/true"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := followRun.Wait(); err != nil {
		skipOnTeardownObservationFailure(t, followState, followRun.RunID)
		t.Fatal(err)
	}
	follow := exec.Command(runner, "events", "--state", followState, "--follow")
	followStdout, err := follow.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var followStderr bytes.Buffer
	follow.Stderr = &followStderr
	if err := follow.Start(); err != nil {
		t.Fatal(err)
	}
	followWaited := false
	followReadDone := make(chan struct{})
	t.Cleanup(func() {
		if !followWaited {
			if err := follow.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Logf("stop events --follow test process: %v", err)
			}
			if err := testutil.WaitAfterPipeRead(follow, followReadDone); err != nil {
				t.Logf("wait for events --follow test process: %v", err)
			}
		}
	})
	followedEvents := make([]proc.Event, 0, 4)
	lines := make(chan error, 1)
	firstEvent := make(chan struct{}, 1)
	go func() {
		defer close(followReadDone)
		lines <- proc.ReadEvents(followStdout, func(event proc.Event) error {
			followedEvents = append(followedEvents, event)
			select {
			case firstEvent <- struct{}{}:
			default:
			}
			return nil
		})
	}()
	select {
	case <-firstEvent:
	case <-time.After(5 * time.Second):
		t.Fatal("events --follow did not emit the existing lifecycle record")
	}
	if err := follow.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case readErr := <-lines:
		if readErr != nil {
			t.Fatalf("read events --follow output: %v; stderr: %s", readErr, followStderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("events --follow did not terminate and close its stream")
	}
	waitErr = testutil.WaitAfterPipeRead(follow, followReadDone)
	followWaited = true
	if waitErr != nil {
		t.Fatalf("stop events --follow: %v; stderr: %s", waitErr, followStderr.String())
	}
	gotLifecycle := make([]proc.EventType, len(followedEvents))
	for i, event := range followedEvents {
		gotLifecycle[i] = event.Type
	}
	if !sameEventTypes(gotLifecycle, wantLifecycle) {
		t.Fatalf("events --follow lifecycle sequence = %v, want %v; stderr: %s", gotLifecycle, wantLifecycle, followStderr.String())
	}
	for _, event := range followedEvents {
		if event.Schema != proc.EventSchema {
			t.Fatalf("events --follow emitted incomplete event: %+v", event)
		}
	}
	skipOnTeardownObservationFailure(t, followState, followRun.RunID)
}

func sameEventTypes(got, want []proc.EventType) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// case: S-237.4
func TestEventsFollowLiveLifecycleFromRunStart(t *testing.T) {
	state := t.TempDir()
	helper := buildHelper(t)
	runner := buildRunner(t)

	follow := exec.Command(runner, "events", "--state", state, "--follow")
	followStdout, err := follow.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var followStderr bytes.Buffer
	follow.Stderr = &followStderr
	if err := follow.Start(); err != nil {
		t.Fatal(err)
	}
	followerFinished := false
	followReadDone := make(chan struct{})
	followEvents := make(chan proc.Event, 8)
	followDone := make(chan error, 1)
	go func() {
		defer close(followReadDone)
		followDone <- proc.ReadEvents(followStdout, func(event proc.Event) error {
			followEvents <- event
			return nil
		})
	}()
	t.Cleanup(func() {
		if followerFinished {
			return
		}
		if err := follow.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Logf("stop live lifecycle follower: %v", err)
		}
		if err := testutil.WaitAfterPipeRead(follow, followReadDone); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Logf("wait for live lifecycle follower: %v", err)
		}
	})

	// Start the follower process before proc.Start so it observes this run from
	// its first append. The test holds the child until queued and start have
	// crossed the follower, then releases it so exit and teardown are live too.
	runCtx, cancelRun := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelRun()
	childPIDPath := filepath.Join(state, "child.pid")
	releasePath := filepath.Join(state, "release-child")
	run, err := startTest(runCtx, proc.Config{
		StateDir: state, Tag: "live-follow", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{helper, "hold", childPIDPath, releasePath},
	})
	if err != nil {
		t.Fatalf("start live-follow run: %v", err)
	}
	runFinished := false
	t.Cleanup(func() {
		if runFinished {
			return
		}
		if err := run.Kill(); err != nil {
			t.Logf("stop live-follow run %s: %v", run.RunID, err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for live-follow run %s: %v", run.RunID, err)
		}
	})
	want := []proc.EventType{proc.EventQueued, proc.EventStart, proc.EventExit, proc.EventTeardown}
	got := make([]proc.Event, 0, len(want))
	sequenceDeadline := time.NewTimer(10 * time.Second)
	defer sequenceDeadline.Stop()
	for len(got) < 2 {
		select {
		case event := <-followEvents:
			got = append(got, event)
		case err := <-followDone:
			t.Fatalf("events --follow ended before full live lifecycle: %v; stderr: %s", err, followStderr.String())
		case <-sequenceDeadline.C:
			t.Fatalf("events --follow did not receive full live lifecycle, got %v; stderr: %s", eventTypes(got), followStderr.String())
		}
	}
	if got[0].Type != proc.EventQueued || got[1].Type != proc.EventStart {
		t.Fatalf("live follower prefix = %v, want [queued start]", eventTypes(got))
	}
	for _, event := range got {
		if event.Schema != proc.EventSchema || event.RunID != run.RunID {
			t.Fatalf("live follower received event for another/incomplete run: %+v; run=%s", event, run.RunID)
		}
	}
	if err := os.WriteFile(releasePath, []byte("release\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run.Wait(); err != nil {
		skipOnTeardownObservationFailure(t, state, run.RunID)
		t.Fatalf("wait for live-follow run: %v", err)
	}
	runFinished = true
	for len(got) < len(want) {
		select {
		case event := <-followEvents:
			got = append(got, event)
		case err := <-followDone:
			t.Fatalf("events --follow ended before full live lifecycle: %v; stderr: %s", err, followStderr.String())
		case <-sequenceDeadline.C:
			t.Fatalf("events --follow did not receive full live lifecycle, got %v; stderr: %s", eventTypes(got), followStderr.String())
		}
	}
	gotTypes := eventTypes(got)
	if !sameEventTypes(gotTypes, want) {
		t.Fatalf("live follower lifecycle = %v, want %v", gotTypes, want)
	}
	for _, event := range got {
		if event.Schema != proc.EventSchema || event.RunID != run.RunID {
			t.Fatalf("live follower received event for another/incomplete run: %+v; run=%s", event, run.RunID)
		}
	}
	if err := follow.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("stop live lifecycle follower: %v", err)
	}
	select {
	case err := <-followDone:
		if err != nil {
			t.Fatalf("read live lifecycle follower: %v; stderr: %s", err, followStderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("events --follow did not shut down after SIGTERM; stderr: %s", followStderr.String())
	}
	if err := testutil.WaitAfterPipeRead(follow, followReadDone); err != nil {
		t.Fatalf("wait for live lifecycle follower: %v; stderr: %s", err, followStderr.String())
	}
	followerFinished = true
}

func eventTypes(events []proc.Event) []proc.EventType {
	types := make([]proc.EventType, len(events))
	for index, event := range events {
		types[index] = event.Type
	}
	return types
}

// case: S-237.4
func TestOversizedEventLineFailsEventsFollowAndPS(t *testing.T) {
	runner := buildRunner(t)
	state := t.TempDir()
	oversized := strings.Repeat("x", proc.MaxJSONLLineBytes+1) + "\n"
	if err := os.WriteFile(filepath.Join(state, "events.jsonl"), []byte(oversized), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	follow := exec.CommandContext(ctx, runner, "events", "--state", state, "--follow")
	var followStdout, followStderr bytes.Buffer
	follow.Stdout = &followStdout
	follow.Stderr = &followStderr
	err := follow.Run()
	if err == nil {
		t.Fatalf("events --follow accepted oversized record; stdout=%s stderr=%s", followStdout.String(), followStderr.String())
	}
	if ctx.Err() != nil {
		t.Fatalf("events --follow did not return within bound: %v; stdout=%s stderr=%s", ctx.Err(), followStdout.String(), followStderr.String())
	}
	if followStdout.Len() != 0 || !strings.Contains(followStderr.String(), "line-too-long") {
		t.Fatalf("events --follow stdout=%s stderr=%s; want typed line-size error on stderr", followStdout.String(), followStderr.String())
	}

	ps := exec.Command(runner, "ps", "--state", state)
	psOutput, err := ps.CombinedOutput()
	if err == nil || !strings.Contains(string(psOutput), "line-too-long") {
		t.Fatalf("ps error = %v, output=%s; want non-zero typed JSONL size error", err, psOutput)
	}
}

func buildHelper(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "proc-helper")
	cmd := exec.Command("go", "build", "-o", path, "./testhelper")
	cmd.Dir = packageDir(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build process helper: %v\n%s", err, out)
	}
	return path
}

func buildRunner(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kb-runner")
	cmd := exec.Command("go", "build", "-o", path, ".")
	cmd.Dir = filepath.Join(packageDir(t), "..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, out)
	}
	return path
}

func packageDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test package")
	}
	return filepath.Dir(file)
}

func assertEvent(t *testing.T, state, kind string) {
	t.Helper()
	if countEvents(t, state, kind) < 1 {
		t.Fatalf("missing %q event", kind)
	}
}

func decodeTestEvents(t *testing.T, reader io.Reader) []proc.Event {
	t.Helper()
	var events []proc.Event
	if err := proc.ReadEvents(reader, func(event proc.Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}

func eventOfType(t *testing.T, state string, kind proc.EventType) proc.Event {
	t.Helper()
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, event := range decodeTestEvents(t, f) {
		if event.Type == kind {
			return event
		}
	}
	t.Fatalf("event %q not found", kind)
	return proc.Event{}
}

func outputRunID(t *testing.T, state, tag string) string {
	t.Helper()
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, event := range decodeTestEvents(t, f) {
		if event.Tag == tag {
			return event.RunID
		}
	}
	t.Fatalf("run tag %q has no lifecycle event", tag)
	return ""
}

func skipOnTeardownObservationFailure(t *testing.T, state, runID string) {
	t.Helper()
	teardown := eventForRunAndType(t, state, runID, proc.EventTeardown)
	if strings.Contains(teardown.Error, "unverified/failed observation") {
		t.Skipf("process table unavailable; teardown could not be verified: %s", teardown.Error)
	}
}

func assertSignalExitEvent(t *testing.T, state string) {
	t.Helper()
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Logf("close test event stream: %v", err)
		}
	}()
	for _, event := range decodeTestEvents(t, f) {
		if event.Type == "exit" && event.Signal != "" {
			return
		}
	}
	t.Fatal("missing signal exit event")
}

func cleanupRun(t *testing.T, run *proc.Run) {
	t.Helper()
	t.Cleanup(func() {
		if err := run.Kill(); err != nil {
			t.Logf("stop test run: %v", err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for stopped test run: %v", err)
		}
	})
}

// releaseHeldLeaves frees every leaf the test started on the testhelper hold
// mode. Cleanup paths must call it before killing keepers so held leaves exit
// through the keeper's own reaping instead of being orphaned.
func releaseHeldLeaves(t *testing.T, releaseFile string) {
	t.Helper()
	if err := os.WriteFile(releaseFile, []byte("release\n"), 0o600); err != nil {
		t.Logf("release held fixture leaves via %s: %v", releaseFile, err)
	}
}

func signalRecordedKeepers(t *testing.T, state string) {
	t.Helper()
	listing := proc.List(state)
	if listing.Error != nil {
		t.Logf("list recorded keepers during cleanup: %v", listing.Error)
		return
	}
	for _, run := range listing.Runs {
		if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGTERM); err != nil {
			t.Logf("stop recorded test keeper %s: %v", run.RunID, err)
		}
	}
}

func countEvents(t *testing.T, state, kind string) int {
	t.Helper()
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		return 0
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Logf("close test event stream: %v", err)
		}
	}()
	n := 0
	for _, event := range decodeTestEvents(t, f) {
		if string(event.Type) == kind {
			n++
		}
	}
	return n
}

func eventLeaves(t *testing.T, state, kind string) []proc.Process {
	t.Helper()
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Logf("close test event stream: %v", err)
		}
	}()
	for _, event := range decodeTestEvents(t, f) {
		if string(event.Type) == kind {
			return event.Leaves
		}
	}
	return nil
}

func waitUntil(d time.Duration, condition func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return condition()
}

func identityForTest(t testing.TB, pid int) (string, bool) {
	t.Helper()
	identity, alive, err := proc.ProcessIdentity(pid)
	if err != nil {
		t.Errorf("inspect process %d identity: %v", pid, err)
		return "", false
	}
	return identity, alive
}

type lockedTestBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (writer *lockedTestBuffer) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.buffer.Write(data)
}

func (writer *lockedTestBuffer) String() string {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.buffer.String()
}

func processTestDiagnostic(t testing.TB, pid int, stateDir, processOutput string) string {
	t.Helper()
	details := fmt.Sprintf("pid=%d", pid)
	if runtime.GOOS == "linux" {
		data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
		if err != nil {
			details += " proc_stat=" + err.Error()
		} else {
			close := strings.LastIndexByte(string(data), ')')
			fields := strings.Fields(string(data[close+1:]))
			if close < 0 || len(fields) <= 19 || len(fields[0]) != 1 {
				details += " proc_stat=malformed"
			} else {
				details += fmt.Sprintf(" state=%s ppid=%s pgid=%s sid=%s start_ticks=%s", fields[0], fields[1], fields[2], fields[3], fields[19])
			}
		}
	} else {
		details += " state/ppid/pgid/sid=not exposed by darwin process table"
	}
	var targets []string
	for _, line := range strings.Split(processOutput, "\n") {
		if strings.Contains(line, "teardown signal") && strings.Contains(line, fmt.Sprintf("pid=%d ", pid)) {
			targets = append(targets, "process-output:"+line)
		}
	}
	for _, name := range []string{"err", "events.jsonl"} {
		path := filepath.Join(stateDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.Contains(line, strconv.Itoa(pid)) {
				targets = append(targets, name+":"+line)
			}
		}
	}
	if len(targets) == 0 {
		details += " teardown_target=not-recorded-in-run-logs"
	} else {
		details += " teardown_target=" + strings.Join(targets, " | ")
	}
	return details
}

func processExists(t testing.TB, pid int) bool {
	t.Helper()
	alive, err := proc.ProcessExists(pid)
	if err != nil {
		t.Errorf("inspect process %d: %v", pid, err)
		return false
	}
	return alive
}

// case: S-237.1
func TestLinuxDoubleForkGrandchildIsAdoptedAndReaped(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux child-subreaper contract")
	}
	state := t.TempDir()
	helper := buildHelper(t)
	pidFile := filepath.Join(state, "grandchild.pid")
	releaseFile := filepath.Join(state, "release-command")
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "double-fork", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{helper, "double-fork-held", "30", pidFile, releaseFile},
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRun(t, run)
	grandchild, err := waitPIDFile(pidFile, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !waitUntil(3*time.Second, func() bool {
		tree, treeErr := proc.ProcessTree(int(run.PID), run.RunID)
		if treeErr != nil {
			t.Fatalf("process tree for run %s: %v", run.RunID, treeErr)
		}
		for _, child := range tree {
			if child.PID == grandchild && child.PPID == int(run.PID) {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("double-fork grandchild %d did not survive and reparent to keeper %d", grandchild, run.PID)
	}
	if err := os.WriteFile(releaseFile, []byte("release\n"), 0o600); err != nil {
		t.Fatalf("release supervised command after observing adoption: %v", err)
	}
	if err := run.Wait(); err != nil {
		t.Fatal(err)
	}
	if _, alive := identityForTest(t, grandchild); alive {
		t.Fatalf("double-fork grandchild %d survived the keeper's subreaper cleanup", grandchild)
	}
}

// case: S-237.4
func TestConcurrentKeepersAppendCompleteEventLines(t *testing.T) {
	state := t.TempDir()
	const count = 8
	runs := make([]*proc.Run, 0, count)
	for i := 0; i < count; i++ {
		run, err := startTest(cancellableTestContext(t), proc.Config{
			StateDir: state, Tag: fmt.Sprintf("parallel-%d", i), Stall: time.Hour,
			StdoutPath: filepath.Join(state, fmt.Sprintf("out-%d", i)), StderrPath: filepath.Join(state, fmt.Sprintf("err-%d", i)),
			Command: []string{"/bin/sleep", "0.3"},
		})
		if err != nil {
			t.Fatal(err)
		}
		cleanupRun(t, run)
		runs = append(runs, run)
	}
	for _, run := range runs {
		if err := run.Wait(); err != nil {
			skipOnTeardownObservationFailure(t, state, run.RunID)
			t.Fatal(err)
		}
	}
	f, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	countLines := 0
	types := make(map[proc.EventType]int)
	readErr := proc.ReadEvents(f, func(event proc.Event) error {
		countLines++
		types[event.Type]++
		return nil
	})
	if readErr != nil {
		t.Fatalf("read lifecycle events: %v", readErr)
	}
	if countLines != count*4 {
		t.Fatalf("event lines = %d, want %d (queued, start, exit, teardown per keeper); event types: %v", countLines, count*4, types)
	}
	data, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(data, []byte("\n")) {
		t.Fatal("event stream ends with a partial JSONL record")
	}
	for _, run := range runs {
		skipOnTeardownObservationFailure(t, state, run.RunID)
	}
}

// case: S-237.5
func TestCallerSurvivesInProcessRunTeardown(t *testing.T) {
	state := t.TempDir()
	callerPID := os.Getpid()
	callerIdentity, alive, err := proc.ProcessIdentity(callerPID)
	if err != nil || !alive {
		t.Fatalf("inspect supervising test process: alive=%t err=%v", alive, err)
	}
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "caller-survival", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/bin/sleep", "0.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := run.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Logf("stop caller-survival run: %v", err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for caller-survival run: %v", err)
		}
	})
	waitErr := run.Wait()
	identityAfter, alive, err := proc.ProcessIdentity(callerPID)
	if err != nil || !alive || identityAfter != callerIdentity {
		t.Fatalf("supervising caller changed across teardown: pid=%d identity=%q after=%q alive=%t err=%v", callerPID, callerIdentity, identityAfter, alive, err)
	}
	if waitErr != nil {
		skipOnTeardownObservationFailure(t, state, run.RunID)
		t.Fatalf("in-process run did not finish with clean teardown: %v", waitErr)
	}
	if event := eventOfType(t, state, proc.EventTeardown); event.RunID != run.RunID {
		t.Fatalf("teardown event run id = %q, want %q", event.RunID, run.RunID)
	}
}

// case: S-237.6
func TestRunReadsStdinAndMergesEnvWithMarker(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	prompt := filepath.Join(state, "prompt.txt")
	if err := os.WriteFile(prompt, []byte("prompt-line-one\nprompt-line-two\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(runner,
		"run", "--tag", "stdin-env", "--state", state, "--stall", "1h",
		"--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"),
		"--stdin", prompt, "--env", "PHASE2=present", "--env", "TASK_ID=42", "--",
		"/bin/sh", "-c", `printf 'prompt='; cat; printf 'phase2=%s task=%s marker=%s\n' "$PHASE2" "$TASK_ID" "$KBLABS_CLIPROC_RUN"`,
	)
	output, err := command.CombinedOutput()
	runID := outputRunID(t, state, "stdin-env")
	if err != nil {
		skipOnTeardownObservationFailure(t, state, runID)
		t.Fatalf("kb-runner run with stdin/env failed: %v\n%s", err, output)
	}
	if len(output) == 0 {
		t.Fatal("kb-runner did not report command completion")
	}
	data, err := os.ReadFile(filepath.Join(state, "stdout.log"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{"prompt=prompt-line-one\nprompt-line-two\n", "phase2=present task=42 marker="} {
		if !strings.Contains(text, expected) {
			t.Fatalf("supervised output missing %q: stdout-file=%q stderr-file=%q runner=%s", expected, text, readText(t, filepath.Join(state, "stderr.log")), output)
		}
	}
	if strings.HasSuffix(strings.TrimSpace(text), "marker=") {
		t.Fatalf("run marker was empty: %s", text)
	}
	skipOnTeardownObservationFailure(t, state, runID)
}

// case: S-237.8
func TestSlotAdmissionIsAtomicAndFIFO(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	startedLog := filepath.Join(state, "start-order")
	commands := make([]*exec.Cmd, 4)
	pidFiles := make([]string, 4)
	finished := make([]bool, 4)
	t.Cleanup(func() {
		for i, command := range commands {
			if command != nil && command.Process != nil && !finished[i] {
				if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
					t.Logf("stop slot test runner: %v", err)
				}
				if err := command.Wait(); err != nil {
					t.Logf("wait for slot test runner: %v", err)
				}
			}
		}
		signalRecordedKeepers(t, state)
	})
	for i := range commands {
		tag := fmt.Sprintf("worker-%d", i+1)
		pidFiles[i] = filepath.Join(state, tag+".pid")
		commands[i] = exec.Command(runner,
			"run", "--tag", tag, "--state", state, "--stall", "1h",
			"--stdout", filepath.Join(state, tag+".stdout"), "--stderr", filepath.Join(state, tag+".stderr"),
			"--slot-group", "workers", "--slots", "2", "--",
			"/bin/sh", "-c", `printf '%s\n' "$1" >> "$2"; echo $$ > "$3"; exec /bin/sleep 30`, "sh", tag, startedLog, pidFiles[i],
		)
		if err := commands[i].Start(); err != nil {
			t.Fatal(err)
		}
	}
	if !waitUntil(5*time.Second, func() bool {
		output, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
		return err == nil && strings.Count(string(output), "\tRUNNING\t") == 2 && strings.Count(string(output), "\tQUEUED\t") == 2
	}) {
		t.Fatalf("slot capacity was not enforced for four concurrent starts: %s", outputPS(t, runner, state))
	}
	ps := outputPS(t, runner, state)
	for _, tag := range activeTags(t, ps) {
		if _, err := waitPIDFile(pidFiles[tagIndex(tag)], 5*time.Second); err != nil {
			t.Fatalf("active worker %s did not create its pid file: %v", tag, err)
		}
	}
	firstQueued := queuedTagAtPosition(t, ps, 1)
	secondQueued := queuedTagAtPosition(t, ps, 2)
	firstActive := activeTags(t, ps)
	for _, tag := range firstActive[:1] {
		stopSlotProcess(t, state, pidFiles[tagIndex(tag)])
	}
	firstQueuedIndex := tagIndex(firstQueued)
	if _, err := waitPIDFile(pidFiles[firstQueuedIndex], 5*time.Second); err != nil {
		t.Fatalf("first queued run was not admitted: %v; ps: %s", err, outputPS(t, runner, state))
	}
	order, err := os.ReadFile(startedLog)
	if err != nil || !strings.Contains(string(order), firstQueued+"\n") {
		t.Fatalf("slot admission was not FIFO after first release: %q, err=%v", order, err)
	}
	ps = outputPS(t, runner, state)
	active := activeTags(t, ps)
	for _, tag := range active {
		if tag != firstQueued {
			stopSlotProcess(t, state, pidFiles[tagIndex(tag)])
			break
		}
	}
	secondQueuedIndex := tagIndex(secondQueued)
	if _, err := waitPIDFile(pidFiles[secondQueuedIndex], 5*time.Second); err != nil {
		t.Fatalf("second queued run was not admitted: %v; ps: %s", err, outputPS(t, runner, state))
	}
	order, err = os.ReadFile(startedLog)
	if err != nil || !strings.Contains(string(order), firstQueued+"\n"+secondQueued+"\n") {
		t.Fatalf("slot admission order = %q, err=%v", order, err)
	}
	stopSlotProcess(t, state, pidFiles[firstQueuedIndex])
	stopSlotProcess(t, state, pidFiles[secondQueuedIndex])
	for i, command := range commands {
		if err := command.Wait(); err == nil {
			t.Fatal("slot command returned success after SIGTERM")
		}
		finished[i] = true
	}
}

// case: S-237.8
func TestDeadKeeperIsLostReapedAndDoesNotConsumeSlot(t *testing.T) {
	testDeadKeeperIsLostReapedAndDoesNotConsumeSlot(t)
}

// case: S-237.47
func TestLostKeeperCleansRegisteredResources(t *testing.T) {
	testDeadKeeperIsLostReapedAndDoesNotConsumeSlot(t)
}

func testDeadKeeperIsLostReapedAndDoesNotConsumeSlot(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	firstPIDFile := filepath.Join(state, "first-child.pid")
	secondPIDFile := filepath.Join(state, "second-child.pid")
	start := func(tag, pidFile string) *exec.Cmd {
		t.Helper()
		cmd := exec.Command(runner, "run", "--tag", tag, "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, tag+".out"), "--stderr", filepath.Join(state, tag+".err"), "--slot-group", "stale", "--slots", "1", "--", "/bin/sh", "-ec", `"$1" own path --create dir "$TMPDIR/owned"; echo $$ > "$2"; exec /bin/sleep 30`, "sh", runner, pidFile)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return cmd
	}
	first := start("stale-holder", firstPIDFile)
	var second *exec.Cmd
	t.Cleanup(func() {
		if first.Process != nil {
			_ = first.Process.Kill()
			_ = first.Wait()
		}
		if second != nil && second.Process != nil {
			_ = second.Process.Kill()
			_ = second.Wait()
		}
		signalRecordedKeepers(t, state)
	})
	firstChild, err := waitPIDFile(firstPIDFile, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, alive := identityForTest(t, firstChild)
	if !alive {
		t.Fatalf("cannot verify first command identity for PID %d", firstChild)
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 {
		t.Fatalf("list first run: %+v", listing)
	}
	firstRun := listing.Runs[0]
	if runtime.GOOS == "darwin" && !waitUntil(3*time.Second, func() bool {
		recordPath, err := proc.RunRecordFile(state, firstRun.RunID)
		if err != nil {
			return false
		}
		data, err := os.ReadFile(recordPath)
		if err != nil {
			return false
		}
		var stored struct {
			Observed []proc.Process `json:"observed"`
		}
		if json.Unmarshal(data, &stored) != nil {
			return false
		}
		for _, process := range stored.Observed {
			if process.PID == firstChild {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("keeper never persisted the live descendant identity before SIGKILL")
	}
	if err := proc.SignalRecordedKeeper(state, firstRun.RunID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	second = start("stale-waiter", secondPIDFile)
	secondChild, err := waitPIDFile(secondPIDFile, 5*time.Second)
	if err != nil {
		t.Fatalf("queued run did not acquire slot after keeper death: %v; ps: %s", err, outputPS(t, runner, state))
	}
	_, alive = identityForTest(t, secondChild)
	if !alive {
		t.Fatalf("cannot verify second command identity for PID %d", secondChild)
	}
	if !waitUntil(5*time.Second, func() bool {
		listing := proc.List(state)
		if listing.Error != nil {
			return false
		}
		for _, run := range listing.Runs {
			if run.RunID == firstRun.RunID && run.Status == proc.StatusLost {
				return countLostEvents(t, state, firstRun.RunID) == 1
			}
		}
		return false
	}) {
		t.Fatalf("dead keeper was not recorded LOST with one event: %s", outputPS(t, runner, state))
	}
	if _, alive := identityForTest(t, firstChild); alive {
		t.Fatalf("surviving tree process %d was not cleaned after keeper death", firstChild)
	}
	teardown := eventForRunAndType(t, state, firstRun.RunID, proc.EventTeardown)
	scratch := scratchForRun(t, state, firstRun.RunID)
	if _, err := os.Stat(scratch); !os.IsNotExist(err) {
		t.Fatalf("lost-run scratch remains at %s: %v; teardown=%+v", scratch, err, teardown.Resources)
	}
	removedPath, removedScratch := false, false
	entries, err := proc.ResourceOutcomes(state, firstRun.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Kind != proc.ResourcePath || entries[1].Kind != "scratch" {
		t.Fatalf("lost run ledger entries = %+v", entries)
	}
	for _, entry := range entries {
		if entry.Outcome != proc.ResourceRemoved {
			t.Fatalf("lost-run resource outcome was not persisted: %+v", entry)
		}
		if entry.Kind == proc.ResourcePath {
			removedPath = true
		}
		if entry.Kind == "scratch" {
			removedScratch = true
		}
	}
	if teardown.Resources.Counts[proc.ResourceRemoved] != len(entries) || !removedPath || !removedScratch {
		t.Fatalf("lost-run teardown summary=%+v, run record=%+v", teardown.Resources, entries)
	}
}

func scratchForRun(t *testing.T, state, runID string) string {
	t.Helper()
	recordPath, err := proc.RunRecordFile(state, runID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	var record struct {
		Scratch string `json:"scratch"`
	}
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record.Scratch == "" {
		t.Fatalf("run %s record omitted scratch path", runID)
	}
	return record.Scratch
}

func eventForRunAndType(t *testing.T, state, runID string, eventType proc.EventType) proc.Event {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var found *proc.Event
	if err := proc.ReadEvents(bytes.NewReader(data), func(event proc.Event) error {
		if event.RunID == runID && event.Type == eventType {
			copy := event
			found = &copy
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if found == nil {
		t.Fatalf("event %s for run %s not found", eventType, runID)
	}
	return *found
}

// case: S-237.17
func TestRunWaitRecordsKeeperLossWithoutRegistryReader(t *testing.T) {
	state := t.TempDir()
	childFile := filepath.Join(state, "daemon-child.pid")
	run, err := proc.Start(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "daemon:wait-owner", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/bin/sh", "-c", `echo $$ > "$1"; exec /bin/sleep 30`, "sh", childFile},
	})
	if err != nil {
		t.Fatal(err)
	}
	var childPID int
	var childIdentity string
	t.Cleanup(func() {
		if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGTERM); err != nil {
			t.Logf("cleanup test-owned keeper %d: %v", run.PID, err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for test-owned keeper %d: %v", run.PID, err)
		}
	})
	childPID, err = waitPIDFile(childFile, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	childIdentity, alive := identityForTest(t, childPID)
	if !alive {
		t.Fatalf("cannot identify test-owned command child %d", childPID)
	}
	if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGKILL); err != nil {
		t.Fatalf("SIGKILL test-owned keeper %d: %v", run.PID, err)
	}
	if err := run.Wait(); err == nil {
		t.Fatal("Wait returned success after the keeper was SIGKILLed")
	}
	runEvents := eventsForRun(t, state, run.RunID)
	lostCount, teardownCount := 0, 0
	var teardown proc.Event
	for _, event := range runEvents {
		if event.Type == proc.EventLost {
			lostCount++
		}
		if event.Type == proc.EventTeardown {
			teardownCount++
			teardown = event
		}
	}
	if lostCount != 1 || teardownCount != 1 {
		t.Fatalf("run.Wait did not write exactly one lost and teardown event: %+v", runEvents)
	}
	if identity, alive := identityForTest(t, childPID); alive && identity == childIdentity {
		t.Fatalf("run.Wait left its recorded command child %d alive: %+v", childPID, teardown)
	}
	for _, process := range teardown.Reaped {
		if process.PID == childPID && process.Identity == childIdentity {
			return
		}
	}
	t.Fatalf("run.Wait did not account for the command child identity %d:%s in teardown: %+v", childPID, childIdentity, teardown)
}

// case: S-237.9
func TestWaitGateBlocksAndDeadHolderReleases(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	start := func(tag string, args ...string) *exec.Cmd {
		t.Helper()
		base := []string{"run", "--tag", tag, "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, tag+".out"), "--stderr", filepath.Join(state, tag+".err")}
		command := exec.Command(runner, append(base, args...)...)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		return command
	}
	holderPID := filepath.Join(state, "holder.pid")
	holder := exec.Command(runner, append([]string{"gate", "hold", "maintenance", "--tag", "holder", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "holder.out"), "--stderr", filepath.Join(state, "holder.err"), "--"}, "/bin/sh", "-c", `echo $$ > "$1"; exec /bin/sleep 30`, "sh", holderPID)...)
	holder.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := killTestProcessGroup(holder); err != nil {
			t.Logf("stop holder command child: %v", err)
		}
		if holder.Process != nil {
			_ = holder.Process.Kill()
			_ = holder.Wait()
		}
		signalRecordedKeepers(t, state)
	})
	if _, err := waitPIDFile(holderPID, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	waiterPID := filepath.Join(state, "waiter.pid")
	waiter := start("waiter", "--wait-gate", "maintenance", "--", "/bin/sh", "-c", `echo $$ > "$1"; exec /bin/sleep 30`, "sh", waiterPID)
	t.Cleanup(func() {
		if err := killTestProcessGroup(waiter); err != nil {
			t.Logf("stop waiter command child: %v", err)
		}
		if waiter.Process != nil {
			_ = waiter.Process.Kill()
			_ = waiter.Wait()
		}
	})
	if !waitUntil(5*time.Second, func() bool {
		return strings.Contains(outputPS(t, runner, state), "waiter\t") && strings.Contains(outputPS(t, runner, state), "BLOCKED")
	}) {
		t.Fatalf("gate waiter was not visibly blocked: %s", outputPS(t, runner, state))
	}
	if _, err := os.Stat(waiterPID); !os.IsNotExist(err) {
		t.Fatalf("wait-gated command started before release: stat=%v", err)
	}
	if err := holder.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := holder.Wait(); err == nil {
		t.Fatal("killed gate holder returned success")
	}
	if _, err := waitPIDFile(waiterPID, 5*time.Second); err != nil {
		t.Fatalf("dead holder did not release gate: %v; ps=%s", err, outputPS(t, runner, state))
	}
	stopSlotProcess(t, state, waiterPID)
	if err := waiter.Wait(); err == nil {
		t.Fatal("terminated waiter command returned success")
	}
}

// case: S-237.51
func TestGateWaitDoesNotBlockUnrelatedRun(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	start := func(tag string, args ...string) *exec.Cmd {
		t.Helper()
		base := []string{"run", "--tag", tag, "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, tag+".out"), "--stderr", filepath.Join(state, tag+".err")}
		command := exec.Command(runner, append(base, args...)...)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		return command
	}
	startHeld := func(tag, gate, started, release string) *exec.Cmd {
		command := exec.Command(runner, "gate", "hold", gate, "--tag", tag, "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, tag+".out"), "--stderr", filepath.Join(state, tag+".err"), "--", "/bin/sh", "-c", `touch "$1"; while [ ! -f "$2" ]; do /bin/sleep 0.01; done; exit 0`, "sh", started, release)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		return command
	}
	stopped := make(map[*exec.Cmd]bool)
	stop := func(command *exec.Cmd) {
		t.Helper()
		if command.Process != nil && !stopped[command] {
			stopped[command] = true
			_ = killTestProcessGroup(command)
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}
	holderStarted := filepath.Join(state, "holder.started")
	holderRelease := filepath.Join(state, "holder.release")
	holder := startHeld("admission-holder", "maintenance", holderStarted, holderRelease)
	t.Cleanup(func() { stop(holder); signalRecordedKeepers(t, state) })
	if _, err := waitFile(t, holderStarted, 5*time.Second); err != nil {
		t.Fatalf("gate holder did not start: %v; ps=%s", err, outputPS(t, runner, state))
	}
	waiterStarted := filepath.Join(state, "waiter.started")
	waiter := start("admission-waiter", "--wait-gate", "maintenance", "--", "/bin/sh", "-c", `touch "$1"; exec /bin/sleep 30`, "sh", waiterStarted)
	t.Cleanup(func() { stop(waiter); signalRecordedKeepers(t, state) })
	if !waitUntil(5*time.Second, func() bool {
		return strings.Contains(outputPS(t, runner, state), "admission-waiter\t") && strings.Contains(outputPS(t, runner, state), "BLOCKED")
	}) {
		t.Fatalf("gate waiter did not become blocked: %s", outputPS(t, runner, state))
	}
	freeStarted := filepath.Join(state, "unrelated.started")
	unrelated := start("admission-unrelated", "--", "/bin/sh", "-c", `touch "$1"; exec /bin/sleep 30`, "sh", freeStarted)
	t.Cleanup(func() { stop(unrelated); signalRecordedKeepers(t, state) })
	if _, err := waitFile(t, freeStarted, 5*time.Second); err != nil {
		t.Fatalf("unrelated run was held behind gate waiter: %v; ps=%s", err, outputPS(t, runner, state))
	}
	if strings.Contains(outputPS(t, runner, state), "admission-waiter\tRUNNING") {
		t.Fatal("gate waiter started before gate release")
	}
	stop(unrelated)
	if err := os.WriteFile(holderRelease, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := waitFile(t, waiterStarted, 5*time.Second); err != nil {
		t.Fatalf("gate waiter did not start after gate release: %v; ps=%s", err, outputPS(t, runner, state))
	}
	stop(waiter)
}

// case: S-237.52
func TestGateWaitUsesLittleCPU(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	start := func(args ...string) *exec.Cmd {
		t.Helper()
		command := exec.Command(runner, args...)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		return command
	}
	stopped := make(map[*exec.Cmd]bool)
	stop := func(command *exec.Cmd) {
		t.Helper()
		if command.Process != nil && !stopped[command] {
			stopped[command] = true
			_ = killTestProcessGroup(command)
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}
	holder := start("gate", "hold", "maintenance", "--tag", "cpu-holder", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "holder.out"), "--stderr", filepath.Join(state, "holder.err"), "--", "/bin/sleep", "30")
	t.Cleanup(func() { stop(holder); signalRecordedKeepers(t, state) })
	var gateStatErr error
	if !waitUntil(5*time.Second, func() bool {
		_, held, err := proc.GateStatus(state, "maintenance")
		gateStatErr = err
		if err != nil {
			return false
		}
		if !held {
			return false
		}
		return true
	}) {
		t.Fatalf("gate holder did not claim maintenance before waiter launch: %v", gateStatErr)
	}
	waiterStarted := filepath.Join(state, "waiter.started")
	waiter := start("run", "--tag", "cpu-waiter", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "waiter.out"), "--stderr", filepath.Join(state, "waiter.err"), "--wait-gate", "maintenance", "--", "/bin/sh", "-c", `touch "$1"; exec /bin/sleep 30`, "sh", waiterStarted)
	t.Cleanup(func() { stop(waiter); signalRecordedKeepers(t, state) })
	if !waitUntil(5*time.Second, func() bool {
		ps := outputPS(t, runner, state)
		return strings.Contains(ps, "cpu-waiter\t") && strings.Contains(ps, "\tBLOCKED\tblocked: position=") && strings.Contains(ps, "gate: maintenance")
	}) {
		t.Fatalf("gate waiter did not become blocked: %s", outputPS(t, runner, state))
	}
	if _, err := os.Stat(waiterStarted); !os.IsNotExist(err) {
		t.Fatalf("waiter's command started before gate release: stat=%v", err)
	}
	// ProcessState reports CPU for the waiting CLI process after it is stopped.
	time.Sleep(5 * time.Second)
	stop(waiter)
	usage, ok := waiter.ProcessState.SysUsage().(*syscall.Rusage)
	if !ok {
		t.Fatal("waiter process CPU usage is unavailable")
	}
	cpu := time.Duration(usage.Utime.Sec)*time.Second + time.Duration(usage.Utime.Usec)*time.Microsecond + time.Duration(usage.Stime.Sec)*time.Second + time.Duration(usage.Stime.Usec)*time.Microsecond
	t.Logf("gate waiter used %s CPU while visibly blocked for five seconds", cpu)
	if cpu > 100*time.Millisecond {
		t.Fatalf("gate wait consumed %s CPU over five seconds", cpu)
	}
	if err := holder.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := holder.Wait(); err == nil {
		t.Fatal("killed gate holder returned success")
	}
}

// case: S-237.10
func TestMinFreeWaitIsVisibleAndEmitsOneEvent(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	started := filepath.Join(state, "command.started")
	command := exec.Command(runner,
		"run", "--tag", "disk-wait", "--state", state, "--stall", "1h",
		"--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"),
		"--min-free", "18446744073709551615",
		"--", "/bin/sh", "-c", `touch "$1"`, "sh", started,
	)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
		signalRecordedKeepers(t, state)
	})
	if !waitUntil(5*time.Second, func() bool {
		output, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
		return err == nil && strings.Contains(string(output), "BLOCKED") && strings.Contains(string(output), "disk budget")
	}) {
		t.Fatalf("minimum-free wait was invisible: %s", outputPS(t, runner, state))
	}
	if _, err := os.Stat(started); !os.IsNotExist(err) {
		t.Fatalf("command started below min-free threshold: %v", err)
	}
	if got := countEvents(t, state, "blocked"); got != 1 {
		t.Fatalf("blocked event count = %d, want one disk wait transition", got)
	}
	blocked := eventOfType(t, state, proc.EventBlocked)
	if blocked.DiskNeedBytes != ^uint64(0) || blocked.DiskFreeBytes >= blocked.DiskNeedBytes {
		t.Fatalf("blocked disk event reports need=%d free=%d; want observed below-budget values", blocked.DiskNeedBytes, blocked.DiskFreeBytes)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("cancelled disk wait returned success")
	}
}

// case: S-237.11
func TestWaitReturnsRecordedExitAndFilteredEvents(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(func() {
		cancel()
		signalRecordedKeepers(t, state)
	})
	command := exec.CommandContext(ctx, runner,
		"run", "--tag", "result", "--state", state, "--stall", "100ms",
		"--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"),
		"--", "/bin/sh", "-c", "/bin/sleep 0.4; exit 7",
	)
	output, err := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
		t.Fatalf("run exit = %v, output=%s; want code 7", err, output)
	}
	wait := exec.Command(runner, "wait", "--tag", "result", "--state", state)
	waitOutput, waitErr := wait.CombinedOutput()
	if !errors.As(waitErr, &exitErr) || exitErr.ExitCode() != 7 || !strings.Contains(string(waitOutput), "run result exited after ") {
		t.Fatalf("wait result = %v, output=%s; want recorded code 7 and duration", waitErr, waitOutput)
	}
	events := exec.Command(runner, "events", "--state", state, "--filter", "exit,stall")
	eventOutput, err := events.CombinedOutput()
	if err != nil {
		t.Fatalf("filtered events: %v: %s", err, eventOutput)
	}
	var seen []proc.EventType
	if err := proc.ReadEvents(bytes.NewReader(eventOutput), func(event proc.Event) error {
		seen = append(seen, event.Type)
		return nil
	}); err != nil {
		t.Fatalf("invalid filtered events: %v", err)
	}
	if len(seen) != 2 || seen[0] != proc.EventStall || seen[1] != proc.EventExit {
		t.Fatalf("filtered lifecycle types = %v, want [stall exit]", seen)
	}
	if countEvents(t, state, "teardown") != 1 || countEvents(t, state, "start") != 1 {
		t.Fatalf("lifecycle event counts start=%d teardown=%d", countEvents(t, state, "start"), countEvents(t, state, "teardown"))
	}
}

// case: S-237.59
func TestEventsStartsAtPersistedByteOffset(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	first := []byte(`{"schema":"kb.proc-event/v2","type":"queued","tag":"agent:old"}` + "\n")
	second := []byte(`{"schema":"kb.proc-event/v2","type":"queued","tag":"agent:new"}` + "\n")
	if err := os.WriteFile(filepath.Join(state, "events.jsonl"), append(first, second...), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(runner, "events", "--state", state, "--offset", strconv.Itoa(len(first)))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("events from byte offset failed: %v; output=%s", err, output)
	}
	var event proc.Event
	if err := proc.ReadEvents(bytes.NewReader(output), func(decoded proc.Event) error {
		event = decoded
		return nil
	}); err != nil {
		t.Fatalf("decode event from byte offset: %v; output=%s", err, output)
	}
	if event.Tag != "agent:new" {
		t.Fatalf("event at offset = %q, want agent:new; output=%s", event.Tag, output)
	}
}

// case: S-237.11
func TestEventsFollowStreamsLaterFilteredRecords(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	follower := exec.Command(runner, "events", "--state", state, "--follow", "--filter", "exit,stall")
	stdout, err := follower.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := follower.Start(); err != nil {
		t.Fatal(err)
	}
	type followedEvent struct {
		event proc.Event
		err   error
	}
	readEvents := make(chan followedEvent, 8)
	readDone := make(chan error, 1)
	go func() {
		readDone <- proc.ReadEvents(stdout, func(event proc.Event) error {
			readEvents <- followedEvent{event: event}
			return nil
		})
	}()
	stopped := false
	stopFollower := func() error {
		if stopped {
			return nil
		}
		stopped = true
		var stopErr error
		if err := follower.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
			stopErr = fmt.Errorf("signal event follower: %w", err)
		}
		// StdoutPipe's reader must finish before Wait closes the pipe. Waiting
		// first races the scanner's final read and can produce os.ErrClosed.
		var readErr error
		select {
		case readErr = <-readDone:
		case <-time.After(2 * time.Second):
			if err := follower.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				stopErr = errors.Join(stopErr, fmt.Errorf("kill event follower after reader timeout: %w", err))
			}
			select {
			case readErr = <-readDone:
			case <-time.After(2 * time.Second):
				stopErr = errors.Join(stopErr, errors.New("event follower stdout reader did not finish after process termination"))
			}
		}
		waitErr := follower.Wait()
		if waitErr != nil && !errors.Is(waitErr, syscall.EINTR) {
			stopErr = errors.Join(stopErr, fmt.Errorf("wait for event follower: %w", waitErr))
		}
		if readErr != nil {
			stopErr = errors.Join(stopErr, fmt.Errorf("read event follower stdout to EOF: %w", readErr))
		}
		return stopErr
	}
	t.Cleanup(func() {
		if err := stopFollower(); err != nil {
			t.Errorf("stop event follower during cleanup: %v", err)
		}
	})
	command := exec.Command(runner,
		"run", "--tag", "followed", "--state", state, "--stall", "100ms",
		"--stdout", filepath.Join(state, "stdout.log"), "--stderr", filepath.Join(state, "stderr.log"),
		"--", "/bin/sh", "-c", "/bin/sleep 0.4; exit 7",
	)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("followed command returned success: %s", output)
	}
	seen := make(map[proc.EventType]int)
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for seen[proc.EventExit] == 0 || seen[proc.EventStall] == 0 {
		select {
		case row := <-readEvents:
			if row.err != nil {
				t.Fatal(row.err)
			}
			if row.event.Type != proc.EventExit && row.event.Type != proc.EventStall {
				t.Fatalf("filtered follower emitted %q", row.event.Type)
			}
			seen[row.event.Type]++
		case <-deadline.C:
			t.Fatalf("event follower did not receive later filtered rows: %v", seen)
		}
	}
	if seen[proc.EventExit] != 1 || seen[proc.EventStall] != 1 {
		t.Fatalf("followed event counts = %v, want one exit and one stall", seen)
	}
	if err := stopFollower(); err != nil {
		t.Fatalf("event follower shutdown failed: %v", err)
	}
}

// case: S-237.26
func TestPSShowsRunningQueuedBlockedAndStalledTogether(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	helper := buildHelper(t)
	releaseFile := filepath.Join(state, "release-leaves")
	var commands []*exec.Cmd
	t.Cleanup(func() {
		// Release the held leaves first so they exit on their own and their
		// keepers reap them; killing the launchers first would orphan them.
		releaseHeldLeaves(t, releaseFile)
		for _, command := range commands {
			if command.Process != nil {
				_ = command.Process.Kill()
				_ = command.Wait()
			}
		}
		signalRecordedKeepers(t, state)
	})
	start := func(args ...string) *exec.Cmd {
		t.Helper()
		command := exec.Command(runner, args...)
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		commands = append(commands, command)
		return command
	}
	heldCommand := func(pidFile string) []string {
		return []string{helper, "hold", pidFile, releaseFile}
	}
	startHeld := func(args []string, pidFile string) *exec.Cmd {
		t.Helper()
		return start(append(args, heldCommand(pidFile)...)...)
	}
	startWorker := func(tag, pidFile string) *exec.Cmd {
		return startHeld([]string{"run", "--tag", tag, "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, tag+".out"), "--stderr", filepath.Join(state, tag+".err"), "--slot-group", "ps-workers", "--slots", "1", "--"}, pidFile)
	}
	activePID := filepath.Join(state, "active.pid")
	startWorker("active", activePID)
	if _, err := waitPIDFile(activePID, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	holderPID := filepath.Join(state, "gate-holder.pid")
	startHeld([]string{"gate", "hold", "maintenance", "--tag", "gate-holder", "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "gate-holder.out"), "--stderr", filepath.Join(state, "gate-holder.err"), "--"}, holderPID)
	if _, err := waitPIDFile(holderPID, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	startHeld([]string{"run", "--tag", "stalled", "--state", state, "--stall", "100ms", "--stdout", filepath.Join(state, "stalled.out"), "--stderr", filepath.Join(state, "stalled.err"), "--"}, filepath.Join(state, "stalled.pid"))
	if !waitUntil(5*time.Second, func() bool {
		return psHasTagStatus(outputPS(t, runner, state), "stalled", "STALLED")
	}) {
		t.Fatalf("silent command did not become stalled before queued work: %s", outputPS(t, runner, state))
	}
	startHeld([]string{"run", "--tag", "blocked", "--state", state, "--stall", "1h", "--wait-gate", "maintenance", "--stdout", filepath.Join(state, "blocked.out"), "--stderr", filepath.Join(state, "blocked.err"), "--"}, filepath.Join(state, "blocked.pid"))
	startWorker("queued", filepath.Join(state, "queued.pid"))
	if !waitUntil(5*time.Second, func() bool {
		output, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
		if err != nil {
			return false
		}
		return psHasTagStatus(string(output), "active", "RUNNING") &&
			psHasTagStatus(string(output), "queued", "QUEUED") &&
			psHasTagStatus(string(output), "gate-holder", "RUNNING") &&
			psHasTagStatus(string(output), "blocked", "BLOCKED") &&
			psHasTagStatus(string(output), "stalled", "STALLED")
	}) {
		t.Fatalf("ps did not show all live/waiting states together: %s", outputPS(t, runner, state))
	}
	output := outputPS(t, runner, state)
	assertPSRowDetails(t, output, "active", true, "")
	assertPSRowDetails(t, output, "queued", false, "position=1")
	assertPSRowDetails(t, output, "gate-holder", true, "")
	assertPSRowDetails(t, output, "blocked", false, "gate: maintenance")
	assertPSRowDetails(t, output, "stalled", true, "")
}

func assertPSRowDetails(t *testing.T, output, tag string, hasChild bool, waitDetail string) {
	t.Helper()
	lines := strings.Split(output, "\n")
	for i, line := range lines {
		fields := strings.Split(line, "\t")
		if len(fields) == 0 || fields[0] != tag {
			continue
		}
		if len(fields) < 7 || !strings.HasPrefix(fields[4], "elapsed=") || !strings.HasPrefix(fields[5], "tree=") {
			t.Fatalf("ps row %q omitted its own tree and elapsed fields: %s", tag, line)
		}
		if waitDetail != "" && !strings.Contains(fields[3], waitDetail) {
			t.Fatalf("ps row %q omitted wait detail %q: %s", tag, waitDetail, line)
		}
		treeCount, err := strconv.Atoi(strings.TrimPrefix(fields[5], "tree="))
		if err != nil {
			t.Fatalf("ps row %q has invalid tree count: %s", tag, line)
		}
		childCount := 0
		for _, childLine := range lines[i+1:] {
			if !strings.HasPrefix(childLine, "  └─ ") {
				if childLine != "" {
					break
				}
				continue
			}
			childFields := strings.Split(childLine, "\t")
			if len(childFields) < 3 || !strings.Contains(childFields[2], "elapsed=") {
				t.Fatalf("ps child of %q omitted its own elapsed field: %s", tag, childLine)
			}
			childCount++
		}
		if treeCount != childCount {
			t.Fatalf("ps row %q advertises tree=%d but prints %d descendants: %s", tag, treeCount, childCount, output)
		}
		if hasChild != (childCount > 0) {
			t.Fatalf("ps row %q has %d descendants, want child=%t: %s", tag, childCount, hasChild, output)
		}
		return
	}
	t.Fatalf("ps row %q was omitted: %s", tag, output)
}

func countLostEvents(t *testing.T, state, runID string) int {
	return countRunEvents(t, state, runID, proc.EventLost)
}

func countRunEvents(t *testing.T, state, runID string, eventType proc.EventType) int {
	t.Helper()
	count := 0
	for _, event := range eventsForRun(t, state, runID) {
		if event.Type == eventType {
			count++
		}
	}
	return count
}

func eventsForRun(t *testing.T, state, runID string) []proc.Event {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var matches []proc.Event
	if err := proc.ReadEvents(bytes.NewReader(data), func(event proc.Event) error {
		if event.RunID == runID {
			matches = append(matches, event)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return matches
}

func psHasTagStatus(output, tag, status string) bool {
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) >= 3 && fields[0] == tag && fields[2] == status {
			return true
		}
	}
	return false
}

func activeTags(t *testing.T, output string) []string {
	t.Helper()
	var tags []string
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) >= 3 && fields[2] == "RUNNING" && strings.HasPrefix(fields[0], "worker-") {
			tags = append(tags, fields[0])
		}
	}
	if len(tags) != 2 {
		t.Fatalf("active worker set = %v, want 2: %s", tags, output)
	}
	return tags
}

func queuedTagAtPosition(t *testing.T, output string, position int) string {
	t.Helper()
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) >= 4 && strings.HasPrefix(fields[3], fmt.Sprintf("position=%d ", position)) {
			return fields[0]
		}
	}
	t.Fatalf("queue position %d absent from ps output: %s", position, output)
	return ""
}

func tagIndex(tag string) int {
	var index int
	if _, err := fmt.Sscanf(tag, "worker-%d", &index); err != nil {
		panic(err)
	}
	return index - 1
}

func outputPS(t *testing.T, runner, state string) string {
	t.Helper()
	output, err := exec.Command(runner, "ps", "--state", state).CombinedOutput()
	if err != nil {
		t.Fatalf("kb-runner ps: %v\n%s", err, output)
	}
	return string(output)
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return err.Error()
	}
	return string(data)
}

func stopSlotProcess(t *testing.T, state, pidFile string) {
	t.Helper()
	pid, err := waitPIDFile(pidFile, 5*time.Second)
	if err != nil {
		t.Fatalf("read complete process PID from %s: %v", pidFile, err)
	}
	listing := proc.List(state)
	if listing.Error != nil {
		t.Fatalf("list runs before stopping slot process %d: %v", pid, listing.Error)
	}
	for _, run := range listing.Runs {
		for _, process := range run.Tree {
			if process.PID == pid {
				if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGTERM); err != nil {
					t.Fatalf("stop run %s containing slot process %d: %v", run.RunID, pid, err)
				}
				return
			}
		}
	}
	t.Fatalf("slot process %d is absent from every recorded run tree", pid)
}

func killTestProcessGroup(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	if err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("kill process group for %d: %w", command.Process.Pid, err)
	}
	return nil
}

func TestKillTestProcessGroupStopsChild(t *testing.T) {
	child := exec.Command("/bin/sh", "-c", "exec /bin/sleep 30")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		if !waited {
			_ = killTestProcessGroup(child)
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	})
	if err := killTestProcessGroup(child); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err == nil {
		waited = true
		t.Fatal("child survived process-group cleanup")
	}
	waited = true
}

func TestParsePIDFileReadiness(t *testing.T) {
	tests := []struct {
		name     string
		contents []byte
		wantPID  int
		ready    bool
		wantErr  bool
	}{
		{name: "empty file is still being written"},
		{name: "unterminated PID is still being written", contents: []byte("123")},
		{name: "complete PID", contents: []byte("123\n"), wantPID: 123, ready: true},
		{name: "empty complete PID", contents: []byte("\n"), ready: true, wantErr: true},
		{name: "invalid complete PID", contents: []byte("invalid\n"), ready: true, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotPID, gotReady, err := parsePIDFile(test.contents)
			if gotReady != test.ready || (gotReady && !test.wantErr && gotPID != test.wantPID) {
				t.Fatalf("parsePIDFile(%q) = (%d, %t, %v), want PID %d ready %t", test.contents, gotPID, gotReady, err, test.wantPID, test.ready)
			}
			if (err != nil) != test.wantErr {
				t.Fatalf("parsePIDFile(%q) error = %v, wantErr %t", test.contents, err, test.wantErr)
			}
		})
	}
}

func parsePIDFile(data []byte) (int, bool, error) {
	if len(data) == 0 || data[len(data)-1] != '\n' {
		return 0, false, nil
	}
	value := strings.TrimSpace(string(data))
	pid, err := strconv.Atoi(value)
	if err != nil {
		return 0, true, fmt.Errorf("parse process PID %q: %w", value, err)
	}
	if pid <= 0 {
		return 0, true, fmt.Errorf("process PID %d must be positive", pid)
	}
	return pid, true, nil
}

func waitPIDFile(path string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			pid, ready, parseErr := parsePIDFile(data)
			if parseErr != nil {
				return 0, parseErr
			}
			if ready {
				return pid, nil
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return 0, fmt.Errorf("read process PID from %s: %w", path, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return 0, fmt.Errorf("timed out waiting for a complete process PID in %s", path)
}

func waitFile(t *testing.T, path string, timeout time.Duration) ([]byte, error) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil {
			return data, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, fmt.Errorf("timed out waiting for %s", path)
}

// case: S-237.69
func TestOuterRunReapsDetachedNestedCommand(t *testing.T) {
	state := t.TempDir()
	runner := buildRunner(t)
	pidFile := filepath.Join(state, "detached.pid")
	var pid int
	var identity string
	t.Cleanup(func() {
		if pid == 0 {
			data, readErr := os.ReadFile(pidFile)
			if readErr != nil {
				return
			}
			parsed, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
			if parseErr != nil {
				t.Errorf("decode detached child pid during cleanup %q: %v", data, parseErr)
				return
			}
			pid = parsed
		}
		current, live, identityErr := proc.ProcessIdentity(pid)
		if identityErr != nil {
			t.Errorf("inspect test-owned detached child during cleanup: %v", identityErr)
			return
		}
		if identity == "" {
			identity = current
		}
		if live && current == identity {
			if killErr := syscall.Kill(pid, syscall.SIGKILL); killErr != nil && !errors.Is(killErr, syscall.ESRCH) {
				t.Errorf("kill test-owned detached child: %v", killErr)
			}
		}
	})
	command := exec.Command(runner, "run", "--tag", "outer-with-detached-nested", "--state", state,
		"--stall", "1h", "--stdout", filepath.Join(state, "outer.out"), "--stderr", filepath.Join(state, "outer.err"),
		"--", "/bin/sh", "-c", `(/bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 60' sh "$1" >/dev/null 2>&1 </dev/null) >/dev/null 2>&1 & exit 0`, "sh", pidFile)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("outer run returned %v: %s", err, output)
	}
	runID := outputRunID(t, state, "outer-with-detached-nested")
	if _, err := waitFile(t, pidFile, 5*time.Second); err != nil {
		t.Fatalf("detached nested command did not start: %v", err)
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err = strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("decode detached child pid %q: %v", data, err)
	}
	var alive bool
	identity, alive, err = proc.ProcessIdentity(pid)
	if err != nil {
		t.Fatalf("inspect detached child after outer completion: %v", err)
	}
	if alive {
		teardown := eventForRunAndType(t, state, runID, proc.EventTeardown)
		t.Logf("run identity history at teardown: %+v", teardown.TeardownHistory)
		t.Logf("teardown outcome: error=%q reaped=%+v unverified=%+v remaining=%+v", teardown.Error, teardown.Reaped, teardown.Unverified, teardown.Remaining)
		for _, sample := range teardown.TeardownInventory {
			t.Logf("teardown inventory sample %d omitted=%d membership_changed=%t", sample.Index, sample.OmittedProcesses, sample.MembershipChanged)
			if sample.SnapshotErr != "" {
				t.Logf("teardown inventory sample %d error: %s", sample.Index, sample.SnapshotErr)
			}
			logProcess := func(process proc.ProcessTreeInventoryEvidence) {
				t.Logf("teardown inventory sample=%d pid=%d ppid=%d pgid=%d sid=%d sid_error=%q uid=%d identity=%s marker=%s marker_error=%q token=%s token_error=%q unverified_reason=%s membership=%s",
					sample.Index, process.PID, process.PPID, process.PGID, process.SID, process.SIDError, process.UID, process.Identity, process.MarkerResult, process.MarkerError, process.TokenResult, process.TokenError, process.OwnershipUnverifiedReason, process.Membership)
			}
			for _, process := range sample.Processes {
				logProcess(process)
			}
			for _, process := range sample.RejectedExamples {
				logProcess(process)
			}
			for _, rejected := range sample.RejectedCounts {
				t.Logf("teardown inventory sample=%d rejected membership=%s marker=%s token=%s uid=%s potential_setuid_owner=%t count=%d",
					sample.Index, rejected.Membership, rejected.MarkerResult, rejected.TokenResult, rejected.UIDClass, rejected.PotentialSetuidOwner, rejected.Count)
			}
		}
		t.Fatalf("nested detached command PID %d (identity %s) outlived the outer run", pid, identity)
	}
}

// case: S-237.69
func TestNestedRunTokenOwnershipIsIsolated(t *testing.T) {
	root := t.TempDir()
	outerState := filepath.Join(root, "outer-state")
	innerState := filepath.Join(root, "inner-state")
	pidFile := filepath.Join(root, "inner-detached.pid")
	releaseInner := filepath.Join(root, "release-inner-command")
	runner := buildRunner(t)
	detachedCommand := `(/bin/sh -c 'echo $$ > "$1"; exec /bin/sleep 60' sh "$1" >/dev/null 2>&1 </dev/null) >/dev/null 2>&1 & while [ ! -e "$2" ]; do /bin/sleep 0.02; done; exit 0`
	innerArgs := []string{"run", "--tag", "inner-token-run", "--state", innerState, "--stall", "1h",
		"--stdout", filepath.Join(root, "inner.out"), "--stderr", filepath.Join(root, "inner.err"),
		"--", "/bin/sh", "-c", detachedCommand, "sh", pidFile, releaseInner}
	outerArgs := []string{"run", "--tag", "outer-token-run", "--state", outerState, "--stall", "1h",
		"--stdout", filepath.Join(root, "outer.out"), "--stderr", filepath.Join(root, "outer.err"), "--", runner}
	outerArgs = append(outerArgs, innerArgs...)
	command := exec.Command(runner, outerArgs...)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatalf("start outer run: %v", err)
	}
	t.Cleanup(func() {
		if err := os.WriteFile(releaseInner, []byte("release\n"), 0o600); err != nil && !os.IsNotExist(err) {
			t.Errorf("release inner run command during cleanup: %v", err)
		}
		if command.ProcessState == nil {
			if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("stop nested-run fixture: %v", err)
			}
			if err := command.Wait(); err != nil {
				t.Logf("wait for stopped nested-run fixture: %v", err)
			}
		}
	})
	data, err := waitFile(t, pidFile, 5*time.Second)
	if err != nil {
		t.Fatalf("inner detached child did not start: %v; output=%s", err, output.String())
	}
	innerPID, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("decode inner detached PID %q: %v", data, err)
	}
	innerIdentity, alive, err := proc.ProcessIdentity(innerPID)
	if err != nil || !alive {
		t.Fatalf("inspect inner detached process: alive=%t identity=%s err=%v", alive, innerIdentity, err)
	}
	if err := os.WriteFile(releaseInner, []byte("release\n"), 0o600); err != nil {
		t.Fatalf("release inner run command: %v", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("outer nested run returned %v: %s", err, output.String())
	}
	innerRunID := outputRunID(t, innerState, "inner-token-run")
	outerRunID := outputRunID(t, outerState, "outer-token-run")
	if innerRunID == outerRunID {
		t.Fatalf("nested runs reused run identity %q", innerRunID)
	}
	innerTeardown := eventForRunAndType(t, innerState, innerRunID, proc.EventTeardown)
	outerTeardown := eventForRunAndType(t, outerState, outerRunID, proc.EventTeardown)
	var innerReaped *proc.Process
	for i := range innerTeardown.Reaped {
		if innerTeardown.Reaped[i].PID == innerPID {
			innerReaped = &innerTeardown.Reaped[i]
			break
		}
	}
	if innerReaped == nil || innerReaped.Identity != innerIdentity {
		t.Fatalf("inner teardown reaped=%+v, want detached PID %d identity %s", innerTeardown.Reaped, innerPID, innerIdentity)
	}
	containsPID := func(processes []proc.Process) bool {
		for _, process := range processes {
			if process.PID == innerPID {
				return true
			}
		}
		return false
	}
	if containsPID(outerTeardown.ProcessTree) || containsPID(outerTeardown.Leaves) || containsPID(outerTeardown.Reaped) ||
		containsPID(outerTeardown.Unverified) || containsPID(outerTeardown.Remaining) {
		t.Fatalf("outer teardown attributed inner-owned PID %d: %+v", innerPID, outerTeardown)
	}
	for _, evidence := range outerTeardown.TeardownHistory {
		if evidence.PID == innerPID {
			t.Fatalf("outer teardown history attributed inner-owned PID %d: %+v", innerPID, evidence)
		}
	}
	for _, sample := range outerTeardown.TeardownInventory {
		for _, evidence := range sample.Processes {
			if evidence.PID == innerPID {
				t.Fatalf("outer teardown accepted inner-owned PID %d: %+v", innerPID, evidence)
			}
		}
		for _, evidence := range sample.RejectedExamples {
			if evidence.PID == innerPID && !strings.HasPrefix(evidence.Membership, "rejected:") {
				t.Fatalf("outer teardown did not reject inner-owned PID %d: %+v", innerPID, evidence)
			}
		}
	}
	for _, run := range []struct {
		state string
		runID string
	}{{innerState, innerRunID}, {outerState, outerRunID}} {
		teardownCount := 0
		for _, event := range eventsForRun(t, run.state, run.runID) {
			if event.Type == proc.EventTeardown {
				teardownCount++
			}
		}
		if teardownCount != 1 {
			t.Fatalf("run %s teardown event count = %d, want exactly 1", run.runID, teardownCount)
		}
	}
}
