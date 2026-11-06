//go:build darwin || linux

package proc

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type countingHostResourceSource struct {
	sample    HostResourceSnapshot
	snapshots atomic.Uint64
}

func (source *countingHostResourceSource) Snapshot() HostResourceSnapshot {
	source.snapshots.Add(1)
	return source.sample
}

func seedFinishedRecords(t *testing.T, state string, count int) {
	t.Helper()
	command := []string{"python3", "-c", "import time; time.sleep(1)"}
	for index := 0; index < count; index++ {
		code := 0
		rec := record{
			RunID: fmt.Sprintf("finished-%05d", index), Tag: "history", Status: StatusCompleted,
			QueueOrder: uint64(index + 1), StateDir: state, Command: command,
			ExitCode: &code, EnqueuedAt: time.Now().UTC().Add(-time.Duration(count-index) * time.Second),
		}
		if err := writeRecordAtomic(rec); err != nil {
			t.Fatalf("seed finished record %d: %v", index, err)
		}
	}
}

func processCPUSeconds() (float64, error) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, err
	}
	user := time.Duration(usage.Utime.Sec)*time.Second + time.Duration(usage.Utime.Usec)*time.Microsecond
	system := time.Duration(usage.Stime.Sec)*time.Second + time.Duration(usage.Stime.Usec)*time.Microsecond
	return (user + system).Seconds(), nil
}

// case: S-237.64
func TestAdmissionWaitCostIsIndependentOfFinishedHistory(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	seedFinishedRecords(t, state, 4000)
	if err := SetQuota(state, "", "", "18446744073709551615"); err != nil {
		t.Fatal(err)
	}
	identity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("identify test process for admission: alive=%t err=%v", alive, err)
	}
	source := &countingHostResourceSource{sample: HostResourceSnapshot{
		PhysicalMemory: 1 << 30, AvailableMemory: 1 << 29, MemoryAvailableKnown: true,
		LogicalCPUs: 4, Pressure: "normal", PressureAvailable: true, LoadAvailable: true,
	}}
	cfg := Config{StateDir: state, Tag: "history-waiter", Command: []string{"/bin/true"}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- reserveAdmission(ctx, cfg, "history-waiter", os.Getpid(), identity, source) }()
	blocked := waitForAdmissionRecord(t, state, "history-waiter", func(rec record) bool {
		return rec.Status == StatusBlocked
	})
	if !strings.Contains(blocked.WaitReason, "disk budget") {
		t.Fatalf("blocked record does not state the disk budget: %+v", blocked)
	}

	before, err := processCPUSeconds()
	if err != nil {
		t.Fatal(err)
	}
	snapshotsBefore := source.snapshots.Load()
	window := 2 * time.Second
	time.Sleep(window)
	snapshotsAfter := source.snapshots.Load()
	after, err := processCPUSeconds()
	if err != nil {
		t.Fatal(err)
	}
	// The waiter wakes a bounded number of times per interval whatever the
	// blocking condition, and one wake never rescans finished history.
	if evaluations := snapshotsAfter - snapshotsBefore; evaluations > 32 {
		t.Fatalf("admission evaluated its condition %d times in %s; want at most 32", evaluations, window)
	}
	t.Logf("admission waiter used %.3fs CPU and %d condition evaluations over %s with finished history present", after-before, snapshotsAfter-snapshotsBefore, window)
	if cpu := after - before; cpu > 0.25 {
		t.Fatalf("admission wait consumed %.2fs CPU over %s with finished history present; want at most 0.25s", cpu, window)
	}

	if err := SetQuota(state, "", "", "0"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("admission did not start after the disk floor cleared: %v", err)
		}
	case <-time.After(testdeadline.Budget(t)):
		cancel()
		t.Fatal("admission did not start before the test deadline after the disk floor cleared")
	}
	rec, err := readAdmissionRecord(state, "history-waiter")
	if err != nil || rec.Status != StatusStarting {
		t.Fatalf("admitted record = %+v, err=%v", rec, err)
	}
	cleanupAdmission(state, "history-waiter", "test complete")
}

// case: S-237.64
func TestLegacyTerminalRecordsRetireFromLiveSet(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	code := 0
	legacy := record{
		RunID: "legacy-finished", Tag: "legacy", Status: StatusCompleted, QueueOrder: 1,
		StateDir: state, Command: []string{"/bin/true"}, ExitCode: &code,
	}
	legacyBytes, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(state, "runs", legacy.RunID+".json")
	if err := os.WriteFile(legacyPath, legacyBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetQuota(state, "", "", "18446744073709551615"); err != nil {
		t.Fatal(err)
	}
	source := fakeHostResourceSource{sample: HostResourceSnapshot{
		PhysicalMemory: 1 << 30, AvailableMemory: 1 << 29, MemoryAvailableKnown: true,
		LogicalCPUs: 4, Pressure: "normal", PressureAvailable: true, LoadAvailable: true,
	}}
	decision, err := admissionStateLocked(state, record{RunID: "fresh-candidate", QueueOrder: 2}, source)
	if err != nil {
		t.Fatalf("admission with legacy finished history: %v", err)
	}
	if decision.Status != StatusBlocked || !strings.Contains(decision.Reason, "disk budget") {
		t.Fatalf("legacy finished history changed the admission decision: %+v", decision)
	}
	if err := withStateLock(state, func() error { return pruneStateLocked(state) }); err != nil {
		t.Fatalf("prune with legacy finished history: %v", err)
	}
	if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
		t.Fatalf("terminal record still sits in the live set after prune: stat=%v", err)
	}
	retired, err := os.ReadFile(filepath.Join(state, "runs", "finished", legacy.RunID+".json"))
	if err != nil {
		t.Fatalf("read retired record: %v", err)
	}
	if string(retired) != string(legacyBytes) {
		t.Fatal("retirement rewrote the finished record instead of preserving it")
	}
	var all []record
	if err := withStateLock(state, func() error {
		var readErr error
		all, readErr = readAllRecordsLocked(state)
		return readErr
	}); err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].RunID != legacy.RunID || all[0].Status != StatusCompleted {
		t.Fatalf("finished history no longer lists through the registry: %+v", all)
	}
}

// case: S-237.64
func TestTerminalTransitionRetiresRecordAndKeepsItVisible(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	identity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("identify test process for admission: alive=%t err=%v", alive, err)
	}
	cfg := Config{StateDir: state, Tag: "completing", Command: []string{"/bin/true"}}
	if err := reserveAdmission(context.Background(), cfg, "completing", os.Getpid(), identity, fakeHostResourceSource{sample: HostResourceSnapshot{
		PhysicalMemory: 1 << 30, AvailableMemory: 1 << 29, MemoryAvailableKnown: true,
		LogicalCPUs: 4, Pressure: "normal", PressureAvailable: true, LoadAvailable: true,
	}}); err != nil {
		t.Fatalf("admit completing run: %v", err)
	}
	livePath := filepath.Join(state, "runs", "completing.json")
	if _, err := os.Stat(livePath); err != nil {
		t.Fatalf("live record missing before completion: %v", err)
	}
	if err := updateRecord(state, "completing", func(rec *record) error {
		code := 0
		rec.Status, rec.ExitCode = exitStatus(&code, "", ""), &code
		return nil
	}); err != nil {
		t.Fatalf("complete record: %v", err)
	}
	if _, err := os.Stat(livePath); !os.IsNotExist(err) {
		t.Fatalf("completed record still sits in the live set: stat=%v", err)
	}
	rec, err := readRecordLocked(state, "completing")
	if err != nil || rec.Status != StatusCompleted || rec.ExitCode == nil || *rec.ExitCode != 0 {
		t.Fatalf("completed record = %+v, err=%v", rec, err)
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	info, err := WaitTag(waitCtx, state, "completing")
	if err != nil {
		t.Fatalf("wait for completed run: %v", err)
	}
	if info.Status != StatusCompleted || info.ExitCode == nil || *info.ExitCode != 0 {
		t.Fatalf("waited run info = %+v", info)
	}
}

func deadProcessPID(t *testing.T) int {
	t.Helper()
	out, err := os.Create(filepath.Join(t.TempDir(), "stdio"))
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	cmd := exec.Command("/bin/sh", "-c", "exit 0")
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Run(); err != nil {
		t.Fatalf("run dead-PID fixture child: %v", err)
	}
	return cmd.Process.Pid
}

// case: S-237.64
func TestWaitRunCostIsIndependentOfFinishedHistory(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	seedFinishedRecords(t, state, 4000)
	identity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("identify test process for admission: alive=%t err=%v", alive, err)
	}
	if err := writeRecordAtomic(record{
		RunID: "waited", Tag: "waited", Status: StatusQueued, QueueOrder: 10001,
		StateDir: state, PID: os.Getpid(), StartedAt: identity, Command: []string{"/bin/true"},
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type waitResult struct {
		info RunInfo
		err  error
	}
	result := make(chan waitResult, 1)
	go func() {
		info, err := waitRun(ctx, state, "waited", waitByTag, 0)
		result <- waitResult{info: info, err: err}
	}()
	window := 3 * time.Second
	time.Sleep(500 * time.Millisecond)
	before, err := processCPUSeconds()
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(window)
	after, err := processCPUSeconds()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("wait waiter used %.3fs CPU over %s with finished history present", after-before, window)
	if cpu := after - before; cpu > 0.25 {
		cancel()
		<-result
		t.Fatalf("tag wait consumed %.2fs CPU over %s with finished history present; want at most 0.25s", cpu, window)
	}
	if err := updateRecord(state, "waited", func(rec *record) error {
		code := 7
		rec.Status, rec.ExitCode = StatusFailed, &code
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case outcome := <-result:
		if outcome.err != nil {
			t.Fatalf("wait for completed run: %v", outcome.err)
		}
		if outcome.info.Status != StatusFailed || outcome.info.ExitCode == nil || *outcome.info.ExitCode != 7 {
			t.Fatalf("waited run info = %+v, want failed with exit 7", outcome.info)
		}
	case <-time.After(testdeadline.Budget(t)):
		cancel()
		t.Fatal("tag wait did not return before the test deadline after the run completed")
	}
}

// case: S-237.64
func TestWaitRunReturnsRunThatFinishesBetweenPolls(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan RunInfo, 1)
	errs := make(chan error, 1)
	go func() {
		info, err := waitRun(ctx, state, "late", waitByTag, 0)
		errs <- err
		done <- info
	}()
	// Let the wait pass its initial registry consult before the run exists.
	time.Sleep(500 * time.Millisecond)
	code := 0
	// Enqueue through the owner's locking discipline: the sequence bump and
	// the record write share one state lock, exactly like reserveAdmission.
	if err := withStateLock(state, func() error {
		order, err := nextQueueOrderLocked(state)
		if err != nil {
			return err
		}
		return writeRecordAtomic(record{
			RunID: "between-polls", Tag: "late", Status: StatusCompleted, QueueOrder: order,
			StateDir: state, ExitCode: &code, Command: []string{"/bin/true"},
		})
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errs:
		if err != nil {
			t.Fatalf("wait for between-polls run: %v", err)
		}
		info := <-done
		if info.Status != StatusCompleted || info.ExitCode == nil || *info.ExitCode != 0 {
			t.Fatalf("between-polls run info = %+v, want completed with exit 0", info)
		}
	case <-time.After(testdeadline.Budget(t)):
		cancel()
		t.Fatal("wait never observed the run that finished between two polls")
	}
}

// case: S-237.138
func TestWaitLatestTagAppearanceWindowAcceptsAppearingRecord(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := make(chan struct {
		info RunInfo
		err  error
	}, 1)
	go func() {
		info, err := WaitLatestTagWithin(ctx, state, "appearing", time.Second)
		result <- struct {
			info RunInfo
			err  error
		}{info: info, err: err}
	}()
	time.Sleep(100 * time.Millisecond)
	code := 0
	if err := withStateLock(state, func() error {
		order, err := nextQueueOrderLocked(state)
		if err != nil {
			return err
		}
		return writeRecordAtomic(record{
			RunID: "appeared", Tag: "agent:stream:appeared", LatestTag: "appearing", Status: StatusCompleted,
			QueueOrder: order, StateDir: state, ExitCode: &code, Command: []string{"/bin/true"},
		})
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case outcome := <-result:
		if outcome.err != nil || outcome.info.RunID != "appeared" || outcome.info.ExitCode == nil || *outcome.info.ExitCode != 0 {
			t.Fatalf("wait result = %+v err=%v", outcome.info, outcome.err)
		}
	case <-ctx.Done():
		t.Fatal("wait did not accept a latest-tag record that appeared within its window")
	}
}

// case: S-237.65
func TestFinishedRecordIsTheTruthOverStaleLiveLeftover(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	deadPID := deadProcessPID(t)
	code := 0
	finished := record{
		RunID: "crashed", Tag: "crashed", Status: StatusCompleted, QueueOrder: 1,
		StateDir: state, PID: deadPID, StartedAt: "0:1", ExitCode: &code, Command: []string{"/bin/true"},
	}
	if err := writeRecordAtomic(finished); err != nil {
		t.Fatal(err)
	}
	finishedPath := recordLocation(state, "crashed").path(StatusCompleted)
	finishedBytes, err := os.ReadFile(finishedPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRecordAtomic(record{
		RunID: "crashed", Tag: "crashed", Status: StatusRunning, QueueOrder: 1,
		StateDir: state, PID: deadPID, StartedAt: "0:1", Command: []string{"/bin/true"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := withStateLock(state, func() error { return pruneStateLocked(state) }); err != nil {
		t.Fatalf("prune with stale live leftover: %v", err)
	}
	if _, err := os.Stat(recordLocation(state, "crashed").path(StatusRunning)); !os.IsNotExist(err) {
		t.Fatalf("stale live leftover survived prune: stat=%v", err)
	}
	afterBytes, err := os.ReadFile(finishedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterBytes) != string(finishedBytes) {
		t.Fatalf("prune overwrote the finished record instead of treating it as the truth")
	}
	var survived record
	if err := json.Unmarshal(afterBytes, &survived); err != nil {
		t.Fatal(err)
	}
	if survived.Status != StatusCompleted || survived.ExitCode == nil || *survived.ExitCode != 0 {
		t.Fatalf("finished record after prune = %+v, want completed with exit 0", survived)
	}
}

// case: S-237.65
func TestPruneRefusesRecordWithoutStatus(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	corrupt, err := json.Marshal(record{
		RunID: "status-less", Tag: "status-less", QueueOrder: 1,
		StateDir: state, Command: []string{"/bin/true"},
	})
	if err != nil {
		t.Fatal(err)
	}
	corruptPath := recordLocation(state, "status-less").path(StatusRunning)
	if err := os.WriteFile(corruptPath, corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	pruneErr := withStateLock(state, func() error { return pruneStateLocked(state) })
	if pruneErr == nil {
		t.Fatal("prune accepted a record without a status")
	}
	if !strings.Contains(pruneErr.Error(), "decode run record") || !strings.Contains(pruneErr.Error(), corruptPath) {
		t.Fatalf("status-less record error = %v, want a decode error naming %s", pruneErr, corruptPath)
	}
}

// case: S-237.69
func TestRunRecordLocationTracksTransitionsAndFallback(t *testing.T) {
	state := t.TempDir()
	runID := "location-transition"
	location := recordLocation(state, runID)
	wantTemporary := filepath.Join(state, "runs", runID+".json.tmp")
	if got := location.temporaryPath(StatusStarting); got != wantTemporary {
		t.Fatalf("starting-record temp path=%q, want %q", got, wantTemporary)
	}
	identity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("inspect current process identity: alive=%t err=%v", alive, err)
	}
	rec := record{RunID: runID, Tag: runID, StateDir: state, PID: os.Getpid(), StartedAt: identity, Status: StatusRunning}
	if err := writeRecordAtomic(rec); err != nil {
		t.Fatal(err)
	}
	path, err := location.currentPath()
	if err != nil || path != location.path(StatusRunning) {
		t.Fatalf("live record location=%q err=%v, want %q", path, err, location.path(StatusRunning))
	}
	rec.Status = StatusCompleted
	if err := writeRecordAtomic(rec); err != nil {
		t.Fatal(err)
	}
	path, err = location.currentPath()
	if err != nil || path != location.path(StatusCompleted) {
		t.Fatalf("finished record location=%q err=%v, want %q", path, err, location.path(StatusCompleted))
	}
	stored, err := readRecordLocked(state, runID)
	if err != nil || stored.Status != StatusCompleted {
		t.Fatalf("read transitioned record status=%q err=%v, want completed", stored.Status, err)
	}

	fallbackID := "location-fallback"
	fallback := record{RunID: fallbackID, Tag: fallbackID, StateDir: state, PID: os.Getpid(), StartedAt: identity, Status: StatusRunning}
	if err := recordObservedKeeperLoss(state, fallbackID, fallback); err != nil {
		t.Fatalf("restore missing fallback record through location owner: %v", err)
	}
	fallbackPath, err := recordLocation(state, fallbackID).currentPath()
	if err != nil || fallbackPath != recordLocation(state, fallbackID).path(StatusRunning) {
		t.Fatalf("restored fallback location=%q err=%v", fallbackPath, err)
	}
}
