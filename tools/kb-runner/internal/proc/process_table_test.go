//go:build darwin || linux

package proc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// case: S-237.70
func TestGovernorStopsAndContinuesOwnedChildTree(t *testing.T) {
	if outputPath := os.Getenv("KB_CLIPROC_GOVERNOR_TICKER"); outputPath != "" {
		file, err := os.OpenFile(outputPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatalf("open child ticker output: %v", err)
		}
		defer file.Close()
		for {
			if _, err := file.Write([]byte("x")); err != nil {
				t.Fatalf("write child ticker output: %v", err)
			}
			if err := file.Sync(); err != nil {
				t.Fatalf("sync child ticker output: %v", err)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}

	outputPath := filepath.Join(t.TempDir(), "ticks")
	child := exec.Command(os.Args[0], "-test.run=^TestGovernorStopsAndContinuesOwnedChildTree$")
	child.Env = append(os.Environ(), "KB_CLIPROC_GOVERNOR_TICKER="+outputPath)
	child.Stdout = io.Discard
	child.Stderr = io.Discard
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Signal(syscall.SIGCONT); _ = child.Process.Kill(); _ = child.Wait() })
	waitForOutput := func(previous int64) int64 {
		t.Helper()
		deadline := time.Now().Add(testdeadline.Budget(t))
		for time.Now().Before(deadline) {
			info, statErr := os.Stat(outputPath)
			if statErr == nil && info.Size() > previous {
				return info.Size()
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("ticker child did not produce output after size %d", previous)
		return previous
	}
	waitForOutput(0)
	identity, alive, err := ProcessIdentity(child.Process.Pid)
	if err != nil || !alive {
		t.Fatalf("inspect child identity: alive=%t err=%v", alive, err)
	}
	keeperIdentity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("inspect test process identity: alive=%t err=%v", alive, err)
	}
	rec := record{RunID: "governor-test", Tag: "governor-test", PID: os.Getpid(), StartedAt: keeperIdentity,
		Observed: []Process{{PID: child.Process.Pid, PPID: os.Getpid(), Identity: identity}}}
	source := ownedProcessTreeSource{processes: rec.Observed}
	if err := signalRunTreeWithSource(rec, syscall.SIGSTOP, source); err != nil {
		t.Fatalf("pause process tree: %v", err)
	}
	waitForStopped := func(want bool) {
		t.Helper()
		deadline := time.Now().Add(testdeadline.Budget(t))
		for time.Now().Before(deadline) {
			stopped, present, inspectErr := testProcessStopped(child.Process.Pid)
			if inspectErr == nil && present && stopped == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		stopped, present, inspectErr := testProcessStopped(child.Process.Pid)
		t.Fatalf("child stopped state = %t present=%t err=%v, want stopped=%t", stopped, present, inspectErr, want)
	}
	waitForStopped(true)
	pausedSize := fileSize(t, outputPath)
	time.Sleep(200 * time.Millisecond)
	if got := fileSize(t, outputPath); got != pausedSize {
		t.Fatalf("stopped child produced output while paused: size %d -> %d", pausedSize, got)
	}
	if err := signalRunTreeWithSource(rec, syscall.SIGCONT, source); err != nil {
		t.Fatalf("resume process tree: %v", err)
	}
	waitForStopped(false)
	deadline := time.Now().Add(testdeadline.Budget(t))
	for fileSize(t, outputPath) == pausedSize && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := fileSize(t, outputPath); got <= pausedSize {
		t.Fatalf("resumed child produced no output: size stayed at %d", got)
	}
	if err := child.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("stop test child: %v", err)
	}
	if err := child.Wait(); err == nil {
		t.Fatal("sleep child unexpectedly exited successfully")
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat ticker output: %v", err)
	}
	return info.Size()
}

type ownedProcessTreeSource struct{ processes []Process }

func (source ownedProcessTreeSource) Snapshot(string) ([]Process, error) {
	return source.processes, nil
}
func (source ownedProcessTreeSource) Metrics(tree []Process) ([]Process, error) {
	out := append([]Process(nil), tree...)
	for index := range out {
		out[index].MetricsAvailable = true
	}
	return out, nil
}
func (ownedProcessTreeSource) Identity(pid int) (string, bool, error) { return ProcessIdentity(pid) }
func (ownedProcessTreeSource) Signal(pid int, _ string, signal syscall.Signal) error {
	return syscall.Kill(pid, signal)
}

func TestProcessMarkerCacheCachesNonRootPIDStartIdentities(t *testing.T) {
	processes := []Process{
		{PID: 100, PPID: 1, Identity: "root-start", uid: 501},
		{PID: 101, PPID: 100, Identity: "child-start", uid: 501},
		{PID: 102, PPID: 1, Identity: "sibling-start", uid: 501},
		{PID: 103, PPID: 1, Identity: "other-user-start", uid: 0},
	}
	candidates := processInspectionCandidates(processes, 100)
	if candidates[100] || !candidates[101] || !candidates[102] || !candidates[103] {
		t.Fatalf("marker candidates = %v, want every non-keeper process regardless of UID", candidates)
	}
	cache := newProcessMarkerCache()
	inspections := make(map[int]int)
	inspect := func(pid int) (string, bool, error) {
		inspections[pid]++
		if pid == 102 {
			return "run-102", false, nil
		}
		return "", false, nil
	}
	for i := 0; i < 10; i++ {
		processes = applyCachedProcessMarkers(processes, candidates, "run-102", cache, inspect)
	}
	if inspections[101] != 1 || inspections[102] != 1 || inspections[103] != 1 {
		t.Fatalf("marker inspections = %v, want one lookup per non-root PID/start identity", inspections)
	}
	processes[2].Identity = "sibling-exec-start"
	candidates = processInspectionCandidates(processes, 100)
	applyCachedProcessMarkers(processes, candidates, "run-102", cache, inspect)
	if inspections[102] != 2 {
		t.Fatalf("new start identity inspection count = %d, want 2", inspections[102])
	}
}

// case: S-237.7
func TestMarkerInventoryPreservesReadErrorText(t *testing.T) {
	process := Process{PID: 102, Identity: "child-start"}
	marked := applyCachedProcessMarkers(
		[]Process{process},
		map[int]bool{102: true},
		"outer-run",
		newProcessMarkerCache(),
		func(int) (string, bool, error) { return "", false, errors.New("permission denied") },
	)
	if len(marked) != 1 || marked[0].markerReadError != "permission denied" {
		t.Fatalf("marker read error evidence = %+v; want the OS error text", marked)
	}
	evidence := processTreeInventorySample(1, marked, nil, nil, map[string]string{processObservationKey(marked[0]): "rejected:marker-unreadable-without-parent-history"}, nil)
	data, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	var decoded ProcessTreeInventorySample
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.RejectedExamples) != 1 || decoded.RejectedExamples[0].MarkerError != "permission denied" {
		t.Fatalf("inventory marker error = %+v; want serialized read error text", decoded)
	}
}

// case: S-237.7
func TestMergeCleanupRetainsHistoryAndAllInventorySamples(t *testing.T) {
	root := ProcessIdentityEvidence{PID: 100, Identity: "root-start"}
	child := ProcessIdentityEvidence{PID: 102, Identity: "child-start"}
	firstErr := errors.New("first cleanup failed")
	secondErr := errors.New("second cleanup failed")
	first := treeCleanup{
		Reaped:    []Process{{PID: 100, Identity: "root-start"}},
		History:   []ProcessIdentityEvidence{root},
		Inventory: []ProcessTreeInventorySample{{Index: 1, Processes: []ProcessTreeInventoryEvidence{{PID: 100, Identity: "root-start", Membership: "root:keeper-run-owner"}}}},
		err:       firstErr,
	}
	second := treeCleanup{
		Unverified: []Process{{PID: 103, Identity: "unverified-start", Unverified: true}},
		Remaining:  []Process{{PID: 104, Identity: "remaining-start"}},
		History:    []ProcessIdentityEvidence{root, child},
		Inventory:  []ProcessTreeInventorySample{{Index: 1, Processes: []ProcessTreeInventoryEvidence{{PID: 102, Identity: "child-start", MarkerResult: "match", Membership: "accepted:run-marker"}}}},
		err:        secondErr,
	}
	merged := mergeCleanup(first, second)
	if len(merged.Reaped) != 1 || len(merged.Unverified) != 1 || len(merged.Remaining) != 1 {
		t.Fatalf("merged cleanup process outcomes = %+v; want each outcome retained", merged)
	}
	if len(merged.History) != 2 || merged.History[0] != root || merged.History[1] != child {
		t.Fatalf("merged cleanup history = %+v; want identity-deduplicated root and child", merged.History)
	}
	if len(merged.Inventory) != 2 || merged.Inventory[0].Index != 1 || merged.Inventory[1].Index != 2 || merged.Inventory[1].Processes[0].PID != 102 {
		t.Fatalf("merged cleanup inventory = %+v; want both samples with monotonic indices", merged.Inventory)
	}
	if !errors.Is(merged.err, firstErr) || !errors.Is(merged.err, secondErr) {
		t.Fatalf("merged cleanup errors = %v; want both cleanup errors", merged.err)
	}
}

// case: S-237.7
func TestKeeperTeardownEventIncludesMergedCleanupInventory(t *testing.T) {
	source := &markerInventoryProcessSource{
		rootPID:     100,
		alive:       true,
		markerCache: newProcessMarkerCache(),
		processes: []Process{
			{PID: 100, Identity: "root-start"},
			{PID: 102, PPID: 1, Identity: "child-start", uid: 0},
		},
		markers: map[int]string{102: "outer-run"},
	}
	first := cleanupTreeWithSource(100, "outer-run", nil, source)
	merged := mergeCleanup(treeCleanup{}, first)
	if len(merged.Inventory) == 0 {
		t.Fatalf("cleanup fixture took no inventory snapshots: %+v", merged)
	}
	event := Event{Type: EventTeardown, RunID: "outer-run"}
	applyCleanupToEvent(&event, merged)
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Event
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.TeardownInventory) == 0 || len(decoded.TeardownHistory) == 0 {
		t.Fatalf("keeper teardown event omitted cleanup evidence: %+v", decoded)
	}
}

// case: S-237.7
func TestCleanupCompletionDependsOnOwnedTargets(t *testing.T) {
	if !canFinishTreeCleanup(true, 2, nil) {
		t.Fatal("cleanup did not finish after two empty, error-free snapshots with all owned targets gone")
	}
	if canFinishTreeCleanup(true, 2, errors.New("snapshot failed")) {
		t.Fatal("cleanup finished after an inventory error")
	}
	if canFinishTreeCleanup(false, 2, nil) {
		t.Fatal("cleanup finished while an owned process remained live")
	}
}

// case: S-237.7
func TestCleanupDeadlineReturnsPersistentOwnedMarkerInRemaining(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(100, 0), now: time.Unix(100, 0)}
	source := &persistentMarkerProcessSource{}
	cleanup := cleanupTreeWithClock(100, "outer-run", nil, source, clock)
	if !clock.now.Equal(clock.start.Add(cleanupBound)) {
		t.Fatalf("cleanup clock ended at %s, want the single deadline %s", clock.now, clock.start.Add(cleanupBound))
	}
	if len(cleanup.Remaining) != 1 || cleanup.Remaining[0].PID != 102 {
		t.Fatalf("persistent owned marker cleanup remaining = %+v, want PID 102", cleanup.Remaining)
	}
	if cleanup.err == nil || !strings.Contains(cleanup.err.Error(), "deadline expired") {
		t.Fatalf("persistent owned marker cleanup error = %v, want deadline error", cleanup.err)
	}
	if len(source.signals) < 2 || source.signals[0] != syscall.SIGTERM || source.signals[1] != syscall.SIGKILL {
		t.Fatalf("persistent marker signals = %v, want SIGTERM then SIGKILL", source.signals)
	}
}

// case: S-237.7
func TestCleanupDoesNotWaitOnMarkerOutsideSignalableTargets(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(200, 0), now: time.Unix(200, 0)}
	source := &rootMarkerProcessSource{}
	cleanup := cleanupTreeWithClock(100, "outer-run", nil, source, clock)
	if cleanup.err != nil || len(cleanup.Remaining) != 0 {
		t.Fatalf("cleanup for a dead root marker = %+v; want clean empty targets", cleanup)
	}
	if source.snapshots != 2 || !clock.now.Equal(clock.start.Add(cleanupPoll)) {
		t.Fatalf("cleanup sampled %d times and ended at %s; want two empty owned-target snapshots then return", source.snapshots, clock.now)
	}
}

// case: S-237.5
func TestTeardownNeverSignalsKeeperOrItsAncestors(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(300, 0), now: time.Unix(300, 0)}
	source := &supervisorAncestorProcessSource{alive: map[int]bool{98: true, 99: true, 100: true, 101: true}}
	snapshot, err := source.Snapshot("ancestor-protection")
	if err != nil {
		t.Fatal(err)
	}
	_, membership, err := processTreeWithHistorySnapshot(source, 100, nil, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, pid := range []int{98, 99} {
		process := Process{PID: pid, Identity: map[int]string{98: "grandparent", 99: "caller"}[pid]}
		if membership[processObservationKey(process)] != "rejected:keeper-ancestor" {
			t.Errorf("PID %d attribution = %q, want rejected:keeper-ancestor", pid, membership[processObservationKey(process)])
		}
	}
	cleanup := cleanupTreeWithClock(100, "ancestor-protection", nil, source, clock)
	if cleanup.err != nil {
		t.Fatalf("cleanup error = %v", cleanup.err)
	}
	if len(source.signals) != 1 || source.signals[0] != 101 {
		t.Fatalf("signalled identities = %v, want only command descendant PID 101", source.signals)
	}
	if len(cleanup.Inventory) == 0 {
		t.Fatal("teardown did not retain its process attribution inventory")
	}
	command := Process{PID: 101, Identity: "command"}
	if membership[processObservationKey(command)] != "accepted:run-token-fd" {
		t.Errorf("command attribution = %q, want accepted:run-token-fd", membership[processObservationKey(command)])
	}
	if source.alive[98] == false || source.alive[99] == false || source.alive[100] == false {
		t.Fatalf("teardown changed protected process liveness: %+v", source.alive)
	}
}

// case: S-237.5
func TestRecordedSupervisorIdentityIsNeverSignalledWhenSnapshotFails(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(400, 0), now: time.Unix(400, 0)}
	source := &unavailableSnapshotWithLiveIdentity{alive: map[int]bool{99: true, 101: true}}
	observed := []Process{
		{PID: 99, PPID: 98, Identity: "caller"},
		{PID: 101, PPID: 100, Identity: "command"},
	}
	protected := []ProcessIdentityEvidence{{PID: 99, Identity: "caller"}}
	cleanup := cleanupTreeWithProtectedClock(100, "known-caller", observed, protected, source, clock)
	if cleanup.err == nil {
		t.Fatal("cleanup reported clean observation after process-table denial")
	}
	if len(source.signals) != 1 || source.signals[0] != 101 {
		t.Fatalf("signalled identities = %v, want only recorded command PID 101", source.signals)
	}
}

// case: S-237.5
func TestRunKillRefusesCallingKeeperIdentity(t *testing.T) {
	state := t.TempDir()
	identity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("inspect calling process: identity=%q alive=%t err=%v", identity, alive, err)
	}
	rec := record{RunID: "caller-keeper", StateDir: state, PID: os.Getpid(), StartedAt: identity, Status: StatusRunning}
	if err := writeRecordAtomic(rec); err != nil {
		t.Fatalf("seed caller keeper record through record owner: %v", err)
	}
	callerProcess, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatalf("open caller process handle: %v", err)
	}
	run := &Run{
		PID: RecordedKeeperPID(os.Getpid()), RunID: rec.RunID, StartedAt: identity,
		stateDir: state, cmd: &exec.Cmd{Process: callerProcess}, done: make(chan struct{}),
	}
	err = run.Kill()
	var signalErr *KeeperSignalError
	if !errors.As(err, &signalErr) || signalErr.Outcome != KeeperSignalRefusedCaller {
		t.Fatalf("teardown signal outcome = %v, want typed %q refusal", err, KeeperSignalRefusedCaller)
	}
	after, stillAlive, err := ProcessIdentity(os.Getpid())
	if err != nil || !stillAlive || after != identity {
		t.Fatalf("caller did not survive refusal: before=%q after=%q alive=%t err=%v", identity, after, stillAlive, err)
	}
}

// case: S-237.5
func TestKeeperPIDFieldsRemainBranded(t *testing.T) {
	typeOfRecordedPID := reflect.TypeOf(RecordedKeeperPID(0))
	for _, field := range []struct {
		name   string
		typeOf reflect.Type
	}{
		{name: "Run.PID", typeOf: recordedKeeperPIDField(t, reflect.TypeOf(Run{}))},
		{name: "RunInfo.PID", typeOf: recordedKeeperPIDField(t, reflect.TypeOf(RunInfo{}))},
	} {
		if field.typeOf != typeOfRecordedPID {
			t.Errorf("%s type = %v, want branded %v", field.name, field.typeOf, typeOfRecordedPID)
		}
	}
}

func recordedKeeperPIDField(t *testing.T, owner reflect.Type) reflect.Type {
	t.Helper()
	field, found := owner.FieldByName("PID")
	if !found {
		t.Fatalf("%s is missing the keeper PID field", owner)
	}
	return field.Type
}

func TestKeeperSignalOwnerRefusesCallerAncestor(t *testing.T) {
	callerPID := os.Getpid()
	ancestorPID := callerPID + 100000
	source := &keeperSignalProcessSource{
		processes: []Process{
			{PID: callerPID, PPID: ancestorPID, Identity: "caller-start"},
			{PID: ancestorPID, PPID: 1, Identity: "ancestor-start"},
		},
		identities: map[int]string{ancestorPID: "ancestor-start"},
		alive:      map[int]bool{ancestorPID: true},
		parents:    map[int]int{callerPID: ancestorPID, ancestorPID: 1},
	}
	err := signalKeeper(RecordedKeeperPID(ancestorPID), "ancestor-start", "ancestor-run", syscall.SIGKILL, source)
	var signalErr *KeeperSignalError
	if !errors.As(err, &signalErr) || signalErr.Outcome != KeeperSignalRefusedCaller {
		t.Fatalf("signal outcome = %v, want typed %q refusal", err, KeeperSignalRefusedCaller)
	}
	if len(source.signals) != 0 {
		t.Fatalf("signal owner signalled caller ancestor: %v", source.signals)
	}
}

type keeperSignalProcessSource struct {
	processes  []Process
	identities map[int]string
	alive      map[int]bool
	parents    map[int]int
	signals    []int
}

func (source *keeperSignalProcessSource) Snapshot(string) ([]Process, error) {
	return source.processes, nil
}

func (source *keeperSignalProcessSource) Identity(pid int) (string, bool, error) {
	return source.identities[pid], source.alive[pid], nil
}

func (source *keeperSignalProcessSource) ParentPID(pid int) (int, error) {
	parent, exists := source.parents[pid]
	if !exists {
		return 0, fmt.Errorf("missing fake parent for %d", pid)
	}
	return parent, nil
}

func (source *keeperSignalProcessSource) Signal(pid int, _ string, _ syscall.Signal) error {
	source.signals = append(source.signals, pid)
	return nil
}

type unavailableSnapshotWithLiveIdentity struct {
	alive   map[int]bool
	signals []int
}

func (*unavailableSnapshotWithLiveIdentity) Snapshot(string) ([]Process, error) {
	return nil, errors.New("process table unavailable")
}

func (source *unavailableSnapshotWithLiveIdentity) Identity(pid int) (string, bool, error) {
	identities := map[int]string{99: "caller", 101: "command"}
	return identities[pid], source.alive[pid], nil
}

func (source *unavailableSnapshotWithLiveIdentity) Signal(pid int, _ string, _ syscall.Signal) error {
	source.signals = append(source.signals, pid)
	source.alive[pid] = false
	return nil
}

func TestRunOwnershipTokenDescriptorIsCloseOnExec(t *testing.T) {
	token, err := createRunToken(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := token.Close(); err != nil {
			t.Errorf("close run ownership token descriptor: %v", err)
		}
	})
	flags, err := unix.FcntlInt(token.Fd(), unix.F_GETFD, 0)
	if err != nil {
		t.Fatalf("inspect run token descriptor flags: %v", err)
	}
	if flags&unix.FD_CLOEXEC == 0 {
		t.Fatalf("run token descriptor flags = %#x, want FD_CLOEXEC", flags)
	}
}

type supervisorAncestorProcessSource struct {
	alive   map[int]bool
	signals []int
}

func (source *supervisorAncestorProcessSource) Snapshot(string) ([]Process, error) {
	processes := []Process{
		{PID: 98, PPID: 1, Identity: "grandparent", runToken: true},
		{PID: 99, PPID: 98, Identity: "caller", runToken: true},
		{PID: 100, PPID: 99, Identity: "keeper", runToken: true},
		{PID: 101, PPID: 100, Identity: "command", runToken: true},
	}
	filtered := processes[:0]
	for _, process := range processes {
		if source.alive[process.PID] {
			filtered = append(filtered, process)
		}
	}
	return filtered, nil
}

func (source *supervisorAncestorProcessSource) Identity(pid int) (string, bool, error) {
	identities := map[int]string{98: "grandparent", 99: "caller", 100: "keeper", 101: "command"}
	return identities[pid], source.alive[pid], nil
}

func (source *supervisorAncestorProcessSource) Signal(pid int, _ string, _ syscall.Signal) error {
	source.signals = append(source.signals, pid)
	source.alive[pid] = false
	return nil
}

// case: S-237.7
func TestTeardownInventoryOmitsUnrelatedHostProcessesAndStaysBelowJSONLBound(t *testing.T) {
	sample := worstCaseTeardownInventorySample()
	if got := len(sample.Processes); got != maxTeardownProcessesPerSample {
		t.Fatalf("full inventory rows = %d, want cap %d", got, maxTeardownProcessesPerSample)
	}
	var rootFound, targetFound bool
	for _, process := range sample.Processes {
		rootFound = rootFound || process.Membership == "root:keeper-run-owner"
		targetFound = targetFound || process.PID == 2003
	}
	if !rootFound || !targetFound {
		t.Fatalf("bounded inventory did not prioritize root and cleanup target: %+v", sample.Processes)
	}
	if sample.OmittedProcesses != 4994 {
		t.Fatalf("omitted process count = %d, want 4,994 including capped accepted members", sample.OmittedProcesses)
	}
	if len(sample.RejectedExamples) != maxTeardownRejectedExamples {
		t.Fatalf("rejected examples = %d, want fixed cap %d", len(sample.RejectedExamples), maxTeardownRejectedExamples)
	}
	for _, example := range sample.RejectedExamples {
		if example.UID != uint32(os.Getuid()) || example.MarkerResult != "unreadable" {
			t.Fatalf("example order did not prioritize same-UID unreadable markers: %+v", sample.RejectedExamples)
		}
	}
	counts := make(map[string]ProcessTreeInventoryRejectedCount)
	for _, count := range sample.RejectedCounts {
		counts[count.MarkerResult+":"+count.UIDClass] = count
	}
	if len(counts) != 3 || counts["unreadable:same"].Count != 1000 || counts["unreadable:foreign"].Count != 2000 || !counts["unreadable:foreign"].PotentialSetuidOwner || counts["no-marker:foreign"].Count != 1897 {
		t.Fatalf("rejected counts = %+v, want 1,000 same-UID unreadable, 2,000 potential setuid owners, and 1,897 foreign unmarked", sample.RejectedCounts)
	}
}

func worstCaseTeardownInventorySample() ProcessTreeInventorySample {
	processes := make([]Process, 0, 5000)
	membership := make(map[string]string, 5000)
	currentUID := uint32(os.Getuid())
	foreignUID := currentUID + 1
	for i := 0; i < 1000; i++ {
		process := Process{PID: i + 1000, Identity: fmt.Sprintf("same-unreadable-%d", i), uid: currentUID, markerResult: "unreadable", markerReadError: "operation not permitted"}
		processes = append(processes, process)
		membership[processObservationKey(process)] = "rejected:marker-unreadable-without-parent-history"
	}
	for i := 0; i < 2000; i++ {
		process := Process{PID: i + 2000, Identity: fmt.Sprintf("foreign-unreadable-%d", i), uid: foreignUID, markerResult: "unreadable", markerReadError: "operation not permitted"}
		processes = append(processes, process)
		membership[processObservationKey(process)] = "rejected:marker-unreadable-without-parent-history"
	}
	for i := 0; i < 1897; i++ {
		process := Process{PID: i + 5000, Identity: fmt.Sprintf("other-%d", i), uid: foreignUID, markerResult: "no-marker"}
		processes = append(processes, process)
		membership[processObservationKey(process)] = "rejected:no-run-marker-or-parent-history"
	}
	for i := 0; i < 100; i++ {
		process := Process{PID: 10000 + i, Identity: fmt.Sprintf("accepted-%d", i), uid: currentUID, markerResult: "match"}
		processes = append(processes, process)
		membership[processObservationKey(process)] = "accepted:parent-ancestry"
	}
	marker := Process{PID: 2001, Identity: "accepted-marker", runMarker: true, markerResult: "match"}
	target := Process{PID: 2003, Identity: "cleanup-target"}
	root := Process{PID: 2000, Identity: "root"}
	processes = append(processes, root, marker, target)
	targets := map[string]Process{processObservationKey(target): target}
	membership[processObservationKey(marker)] = "accepted:run-marker"
	membership[processObservationKey(root)] = "root:keeper-run-owner"
	membership[processObservationKey(target)] = "accepted:cleanup-target"
	return processTreeInventorySample(1, processes, nil, targets, membership, nil)
}

// case: S-237.4
func TestTeardownEventWriterFitsMaximumShapeWithMargin(t *testing.T) {
	state := t.TempDir()
	sample := worstCaseTeardownInventorySample()
	worstText := worstEncodedTestText()
	var inventory []ProcessTreeInventorySample
	for i := 0; i < maxTeardownInventorySamples+5; i++ {
		sample.Index = i + 1
		current := sample
		current.SnapshotErr = worstText
		for j := range current.Processes {
			current.Processes[j].Identity = fmt.Sprintf("inventory-%d-process-%d-identity", i, j)
			current.Processes[j].SIDError = worstText
			current.Processes[j].MarkerResult = worstText
			current.Processes[j].MarkerError = worstText
			current.Processes[j].TokenResult = worstText
			current.Processes[j].TokenError = worstText
			current.Processes[j].OwnershipUnverifiedReason = OwnershipUnverifiedReason(worstText)
			current.Processes[j].Membership = worstText
		}
		for j := range current.RejectedExamples {
			current.RejectedExamples[j].Identity = fmt.Sprintf("inventory-%d-rejected-%d-identity", i, j)
			current.RejectedExamples[j].SIDError = worstText
			current.RejectedExamples[j].MarkerResult = worstText
			current.RejectedExamples[j].MarkerError = worstText
			current.RejectedExamples[j].TokenResult = worstText
			current.RejectedExamples[j].TokenError = worstText
			current.RejectedExamples[j].OwnershipUnverifiedReason = OwnershipUnverifiedReason(worstText)
			current.RejectedExamples[j].Membership = worstText
		}
		for j := range current.RejectedCounts {
			current.RejectedCounts[j].Membership = worstText
			current.RejectedCounts[j].MarkerResult = worstText
			current.RejectedCounts[j].TokenResult = worstText
			current.RejectedCounts[j].UIDClass = worstText
		}
		inventory = appendTeardownInventorySample(inventory, current)
	}
	for i := range inventory {
		row := inventory[i].Processes[0]
		inventory[i].Processes = make([]ProcessTreeInventoryEvidence, 5000)
		for j := range inventory[i].Processes {
			inventory[i].Processes[j] = row
		}
	}
	event := maximumShapeTeardownEvent(inventory)
	seedTeardownRunRecord(t, state, event)
	if err := appendEvent(state, event); err != nil {
		t.Fatalf("append maximum-shape teardown event: %v", err)
	}
	line, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	writerLimit := MaxJSONLLineBytes - jsonlWriterSafetyMarginBytes
	t.Logf("maximum-shape teardown JSONL line = %d bytes (writer budget %d)", len(line), writerLimit)
	if len(line) > writerLimit {
		t.Fatalf("maximum-shape teardown line is %d bytes, want at most writer limit %d (reader maximum %d)", len(line), writerLimit, MaxJSONLLineBytes)
	}
	if err := ReadEvents(bytes.NewReader(line), func(Event) error { return nil }); err != nil {
		t.Fatalf("reader rejected writer-bounded maximum-shape event: %v", err)
	}
	var decoded Event
	if err := ReadEvents(bytes.NewReader(line), func(event Event) error { decoded = event; return nil }); err != nil {
		t.Fatalf("decode writer-bounded maximum-shape event: %v", err)
	}
	if decoded.TeardownEvidenceOmitted == 0 || len(decoded.ProcessTree) > maxTeardownEventRows || len(decoded.Leaves) > maxTeardownEventRows ||
		len(decoded.Reaped) > maxTeardownEventRows || len(decoded.Unverified) > maxTeardownEventRows || len(decoded.Remaining) > maxTeardownEventRows ||
		len(decoded.TeardownHistory) > maxTeardownEventRows || len(decoded.Resources.Remaining) > len(event.Resources.Remaining) ||
		decoded.Resources.Omitted != event.Resources.Omitted+len(event.Resources.Remaining)-len(decoded.Resources.Remaining) ||
		decoded.Resources.Counts[ResourceFailed] != event.Resources.Counts[ResourceFailed] ||
		len(decoded.TeardownInventory) > maxTeardownEventInventorySamples {
		t.Fatalf("writer did not bound teardown samples and account for omitted resource identities: omitted=%d event=%+v", decoded.TeardownEvidenceOmitted, decoded)
	}
	for _, sample := range decoded.TeardownInventory {
		if len(sample.Processes) > maxTeardownInventoryRowsPerSample || len(sample.RejectedExamples) > 1 || len(sample.RejectedCounts) > maxTeardownRejectedCountClasses {
			t.Fatalf("writer did not cap inventory rows with an omission count: %+v", sample)
		}
	}
	if decoded.RunID != event.RunID {
		t.Fatalf("writer changed run identity: got %q want %q", decoded.RunID, event.RunID)
	}
	for i := range decoded.Resources.Remaining {
		got, want := decoded.Resources.Remaining[i].Resource, event.Resources.Remaining[i].Resource
		if got.Kind != want.Kind || got.ID != want.ID || len(got.Files) != len(want.Files) || got.Files[0] != want.Files[0] ||
			got.Device != want.Device || got.Inode != want.Inode || got.ownerToken != want.ownerToken {
			t.Fatalf("writer changed teardown resource identity %d: decoded=%+v want=%+v", i, got, want)
		}
	}
}

func maximumShapeTeardownEvent(inventory []ProcessTreeInventorySample) Event {
	text := worstEncodedTestText()
	processes := make([]Process, maxTeardownProcessesPerSample)
	history := make([]ProcessIdentityEvidence, maxTeardownProcessesPerSample)
	for i := range processes {
		identity := fmt.Sprintf("process-%d-full-identity", i)
		processes[i] = Process{PID: i + 100, PPID: i + 99, Command: text, Identity: identity, sessionIDError: text, markerResult: text, markerReadError: text, tokenResult: text, tokenReadError: text, OwnershipUnverifiedReason: OwnershipUnverifiedReason(text), StartedAt: time.Unix(1_800_000_000, 999_999_999), ElapsedMS: int64(^uint64(0) >> 1), RSSBytes: ^uint64(0), CPUSeconds: 999999.999}
		history[i] = ProcessIdentityEvidence{PID: i + 100, PPID: i + 99, PGID: 100, SID: 100, UID: ^uint32(0), Identity: identity}
	}
	resources := make([]ResourceOutcomeSummaryItem, maxTeardownEventRows)
	for i := range resources {
		files := make([]string, maxTeardownEventRows*2)
		composePrefix := make([]string, maxTeardownEventRows*2)
		volumes := make([]string, maxTeardownEventRows*2)
		for j := range files {
			files[j], composePrefix[j], volumes[j] = fmt.Sprintf("/very/long/owned/path/%s/%d", strings.Repeat("identity", 3), j), fmt.Sprintf("compose-prefix-%d", j), fmt.Sprintf("protected-volume-%d", j)
		}
		resources[i] = ResourceOutcomeSummaryItem{Resource: Resource{Kind: ResourcePath, ID: fmt.Sprintf("/very/long/resource/id/%s/%d", strings.Repeat("identity", 3), i), Files: files, ComposePrefix: composePrefix,
			ProtectedVolumes: volumes, Device: ^uint64(0), Inode: ^uint64(0), ownerToken: fmt.Sprintf("owner-token-full-%d-%s", i, strings.Repeat("x", 96)), Error: text},
			Outcome: ResourceFailed}
	}
	return Event{
		Schema: EventSchema, At: time.Unix(1_800_000_000, 999_999_999).UTC(), Type: EventTeardown,
		Status: StatusDirty, RunID: strings.Repeat("r", 32), Tag: text, KeeperPID: 999999,
		Command: text, Binary: text, ProcessTree: processes,
		ExitCode: new(int), Signal: "SIGTERM", Error: text, Reason: text,
		WaitingItems: []string{text, text, text, text, text, text, text, text}, Position: 999999,
		DiskNeedBytes: ^uint64(0), DiskFreeBytes: ^uint64(0), DurationMS: int64(^uint64(0) >> 1),
		Leaves: processes, Reaped: processes, Unverified: processes, TeardownHistory: history,
		TeardownInventory: inventory, TeardownInventoryOmitted: 999999,
		MemoryBytes: ^uint64(0), CPUsMin: 999999, CPUsMax: 999999, DiskBytes: ^uint64(0), GrantedCPUs: 999999,
		PeakRSSBytes: ^uint64(0), AverageCPU: 999999.999, MeasurementPartial: true,
		LimitsAdvisory: text, OverBudget: true, ResourceNotice: text,
		CostClass: CostHeavy, PausedMS: int64(^uint64(0) >> 1), GovernorDecision: text,
		Pressure: HostResourceSnapshot{PhysicalMemory: ^uint64(0), AvailableMemory: ^uint64(0), MemoryAvailableKnown: true,
			PressureAvailable: true, LoadAvailable: true, LogicalCPUs: 999999, Pressure: text,
			Load1: 999999.999, CPUPressure: 999999.999, Swap: text, SwapUsedBytes: ^uint64(0),
			SwapTotalBytes: ^uint64(0), SwapOuts: ^uint64(0), SwapOutsKnown: true, FreeDiskBytes: ^uint64(0),
			FreeDiskKnown: true, Unavailable: map[string]string{text: text, "metric-b": text}},
		Remaining: processes,
		Resources: ResourceOutcomeSummary{Counts: map[string]int{ResourceFailed: len(resources)}, Remaining: resources},
	}
}

func worstEncodedTestText() string {
	return "<>&\x00\x01\u2028界\xff" + strings.Repeat("<", maxTeardownFreeTextJSONBytes+64)
}

func TestBoundedTextUsesJSONEncodedLengthAndValidUTF8(t *testing.T) {
	for name, input := range map[string]string{
		"html escapes":       strings.Repeat("<>&", 32),
		"control escapes":    strings.Repeat("\x00\x01\n", 32),
		"invalid UTF-8":      string([]byte{'a', 0xff, 'b'}),
		"multibyte boundary": strings.Repeat("a", 63) + "界🙂",
	} {
		t.Run(name, func(t *testing.T) {
			got := boundedText(input)
			encoded, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			if len(encoded) > maxTeardownFreeTextJSONBytes {
				t.Fatalf("JSON-encoded bounded text is %d bytes, limit %d", len(encoded), maxTeardownFreeTextJSONBytes)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("bounded output is invalid UTF-8: %q", got)
			}
		})
	}
}

// case: S-237.4
func TestTeardownWriterPreservesIdentitiesErrorsAndReportsExactOmissions(t *testing.T) {
	state := t.TempDir()
	path := "/private/tmp/owned/" + strings.Repeat("identity-segment/", 12)
	owner := "owner-token:" + strings.Repeat("nonce", 32)
	errorReason := "path device/inode changed after registration: " + strings.Repeat("detail-", 80)
	event := Event{
		Type: EventTeardown, RunID: "run-identity-1234567890", KeeperPID: 8432,
		Error:           errorReason,
		ProcessTree:     []Process{{PID: 8432, Identity: "pid-start-identity-full-value", Command: worstEncodedTestText()}},
		TeardownHistory: []ProcessIdentityEvidence{{PID: 8432, Identity: "history-start-identity-full-value"}},
		Resources: ResourceOutcomeSummary{Counts: map[string]int{ResourceRefused: 6}, Remaining: []ResourceOutcomeSummaryItem{{
			Resource: Resource{Kind: ResourcePath, ID: path, Files: []string{path + "file-one", path + "file-two"},
				ComposePrefix: []string{"compose-project-full-name"}, ProtectedVolumes: []string{"volume-full-name"},
				Device: 0x123456789, Inode: 0x987654321, ownerToken: owner, Error: errorReason},
			Outcome: ResourceRefused,
		},
			{Resource: Resource{Kind: ResourcePath, ID: "refused-identity-2"}, Outcome: ResourceRefused},
			{Resource: Resource{Kind: ResourcePath, ID: "refused-identity-3"}, Outcome: ResourceRefused},
			{Resource: Resource{Kind: ResourcePath, ID: "refused-identity-4"}, Outcome: ResourceRefused},
			{Resource: Resource{Kind: ResourcePath, ID: "refused-identity-5"}, Outcome: ResourceRefused},
			{Resource: Resource{Kind: ResourcePath, ID: "refused-identity-6"}, Outcome: ResourceRefused},
		}},
		TeardownInventory: []ProcessTreeInventorySample{{
			Index: 1, Processes: []ProcessTreeInventoryEvidence{{PID: 1, Identity: "inventory-identity-full-value"}},
			RejectedExamples: []ProcessTreeInventoryEvidence{
				{PID: 2, Identity: "rejected-example-one-full-identity"},
				{PID: 3, Identity: "rejected-example-two-full-identity"},
			},
		}, {Index: 2}, {Index: 3}},
	}
	seedTeardownRunRecord(t, state, event)
	if err := appendEvent(state, event); err != nil {
		t.Fatalf("append identity-preserving teardown event: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > MaxJSONLLineBytes-jsonlWriterSafetyMarginBytes {
		t.Fatalf("writer line has %d bytes, budget %d", len(data), MaxJSONLLineBytes-jsonlWriterSafetyMarginBytes)
	}
	var decoded Event
	if err := ReadEvents(bytes.NewReader(data), func(actual Event) error { decoded = actual; return nil }); err != nil {
		t.Fatalf("read writer event: %v", err)
	}
	resource := decoded.Resources.Remaining[0].Resource
	if decoded.RunID != event.RunID || decoded.ProcessTree[0].Identity != event.ProcessTree[0].Identity ||
		decoded.TeardownHistory[0].Identity != event.TeardownHistory[0].Identity ||
		resource.Kind != ResourcePath || resource.ID != path || len(resource.Files) != 2 || resource.Files[1] != path+"file-two" ||
		resource.ComposePrefix[0] != "compose-project-full-name" || resource.ProtectedVolumes[0] != "volume-full-name" ||
		resource.Device != 0x123456789 || resource.Inode != 0x987654321 || resource.ownerToken != owner {
		t.Fatalf("writer changed an identity field: decoded resource=%+v event=%+v", resource, decoded)
	}
	if decoded.Error != errorReason || resource.Error != errorReason {
		t.Fatalf("writer truncated a cleanup reason: event=%q resource=%q", decoded.Error, resource.Error)
	}
	if decoded.TeardownInventoryOmitted != 1 || decoded.TeardownEvidenceOmitted != 1 ||
		len(decoded.TeardownInventory) != 2 || len(decoded.TeardownInventory[0].RejectedExamples) != 1 {
		t.Fatalf("writer omission counts are inventory=%d evidence=%d; want 1 and 1: %+v", decoded.TeardownInventoryOmitted, decoded.TeardownEvidenceOmitted, decoded.TeardownInventory)
	}
	if decoded.Resources.Counts[ResourceRefused] != 6 || len(decoded.Resources.Remaining) != maxTeardownResourceIdentities || decoded.Resources.Omitted != 2 ||
		decoded.Resources.Remaining[3].Resource.ID != "refused-identity-4" {
		t.Fatalf("writer did not preserve bounded failed identities and count omissions: %+v", decoded.Resources)
	}
}

func seedTeardownRunRecord(t *testing.T, state string, event Event) {
	t.Helper()
	resources := make([]Resource, 0, len(event.Resources.Remaining))
	for _, item := range event.Resources.Remaining {
		resource := item.Resource
		resource.Outcome = item.Outcome
		resources = append(resources, resource)
	}
	if err := writeRecordAtomic(record{RunID: event.RunID, StateDir: state, Status: StatusRunning, Resources: resources}); err != nil {
		t.Fatal(err)
	}
}

func TestTeardownWriterReturnsTypedErrorWhenIdentitiesExceedBudget(t *testing.T) {
	event := Event{Type: EventTeardown, RunID: strings.Repeat("r", MaxJSONLLineBytes*2)}
	_, err := marshalEventWithinBudget(event)
	var sizeErr *EventSizeError
	if !errors.As(err, &sizeErr) || sizeErr.EventType != EventTeardown || !strings.Contains(err.Error(), "teardown event") {
		t.Fatalf("oversized identity error = %T %v, want typed teardown event budget error", err, err)
	}
}

func TestTeardownWriterDropsLastWholeSampleWithOmissionCount(t *testing.T) {
	state := t.TempDir()
	errorText := strings.Repeat("<", maxTeardownErrorJSONBytes)
	makeEvidence := func(identity string, pid int) ProcessTreeInventoryEvidence {
		return ProcessTreeInventoryEvidence{PID: pid, Identity: identity, SIDError: errorText, MarkerError: errorText, TokenError: errorText,
			OwnershipUnverifiedReason: OwnershipUnverifiedReason(errorText)}
	}
	event := Event{Type: EventTeardown, RunID: "sample-budget-run", TeardownInventory: []ProcessTreeInventorySample{
		{Index: 1, Processes: []ProcessTreeInventoryEvidence{makeEvidence("first-process-one", 11), makeEvidence("first-process-two", 12)},
			RejectedExamples: []ProcessTreeInventoryEvidence{makeEvidence("first-rejected", 13)}},
		{Index: 2, Processes: []ProcessTreeInventoryEvidence{makeEvidence("last-process-one", 21), makeEvidence("last-process-two", 22)},
			RejectedExamples: []ProcessTreeInventoryEvidence{makeEvidence("last-rejected", 23)}},
	}}
	seedTeardownRunRecord(t, state, event)
	if err := appendEvent(state, event); err != nil {
		t.Fatalf("append sample-budget teardown event: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > MaxJSONLLineBytes-jsonlWriterSafetyMarginBytes {
		t.Fatalf("writer line has %d bytes, budget %d", len(data), MaxJSONLLineBytes-jsonlWriterSafetyMarginBytes)
	}
	var decoded Event
	if err := ReadEvents(bytes.NewReader(data), func(actual Event) error { decoded = actual; return nil }); err != nil {
		t.Fatalf("read sample-budget event: %v", err)
	}
	if decoded.TeardownInventoryOmitted != 1 || decoded.TeardownEvidenceOmitted != 2 || len(decoded.TeardownInventory) != 1 || decoded.TeardownInventory[0].Index != 1 ||
		decoded.TeardownInventory[0].Processes[0].Identity != "first-process-one" {
		t.Fatalf("writer did not drop only the last whole sample: omitted=%d samples=%+v", decoded.TeardownInventoryOmitted, decoded.TeardownInventory)
	}
}

func TestOtherRunMarkerStopsParentAncestryOwnership(t *testing.T) {
	root := Process{PID: 100, Identity: "outer-root"}
	outerCommand := Process{PID: 101, PPID: 100, Identity: "outer-command", runToken: true, tokenResult: "match", runMarker: true, markerResult: "match"}
	innerKeeper := Process{PID: 102, PPID: 101, Identity: "inner-keeper", markerResult: "other-run"}
	innerChild := Process{PID: 103, PPID: 102, Identity: "inner-child", markerResult: "other-run", tokenResult: "absent"}
	tree, membership := processTreeFromSnapshotWithMembership([]Process{root, outerCommand, innerKeeper, innerChild}, root.PID)
	if len(tree) != 1 || tree[0].PID != outerCommand.PID {
		t.Fatalf("outer tree=%+v, want only its command PID %d", tree, outerCommand.PID)
	}
	for _, process := range []Process{innerKeeper, innerChild} {
		if got := membership[processObservationKey(process)]; got != "rejected:other-run-marker" {
			t.Fatalf("inner PID %d membership=%q, want rejected:other-run-marker", process.PID, got)
		}
	}
}

// case: S-237.69
func TestOtherRunMarkerDoesNotReenterThroughRecordedHistory(t *testing.T) {
	root := Process{PID: 100, Identity: "outer-root"}
	outerCommand := Process{PID: 101, PPID: 100, Identity: "outer-command", runToken: true, tokenResult: "match", runMarker: true, markerResult: "match"}
	innerKeeper := Process{PID: 102, PPID: 101, Identity: "inner-keeper", markerResult: "other-run"}
	innerChild := Process{PID: 103, PPID: 102, Identity: "inner-child", markerResult: "other-run", tokenResult: "absent"}
	snapshot := []Process{root, outerCommand, innerKeeper, innerChild}
	source := staticIdentityProcessSource{processes: snapshot}
	tree, membership, err := processTreeWithHistorySnapshot(source, root.PID, []Process{innerKeeper, innerChild}, snapshot)
	if err != nil {
		t.Fatalf("build tree with nested-run history: %v", err)
	}
	if len(tree) != 1 || tree[0].PID != outerCommand.PID {
		t.Fatalf("outer tree with nested-run history=%+v, want only outer command PID %d", tree, outerCommand.PID)
	}
	for _, process := range []Process{innerKeeper, innerChild} {
		if got := membership[processObservationKey(process)]; got != "rejected:other-run-marker" {
			t.Fatalf("recorded inner PID %d membership=%q, want rejected:other-run-marker", process.PID, got)
		}
	}
}

type staticIdentityProcessSource struct{ processes []Process }

func (source staticIdentityProcessSource) Snapshot(string) ([]Process, error) {
	return source.processes, nil
}
func (source staticIdentityProcessSource) Identity(pid int) (string, bool, error) {
	for _, process := range source.processes {
		if process.PID == pid {
			return process.Identity, true, nil
		}
	}
	return "", false, nil
}
func (staticIdentityProcessSource) Signal(int, string, syscall.Signal) error { return nil }

// case: S-237.4
func TestEventWriterBoundsTeardownTextAndRejectsOtherOversizedRecords(t *testing.T) {
	state := t.TempDir()
	event := Event{Type: EventTeardown, RunID: "over-budget", Command: strings.Repeat("x", MaxJSONLLineBytes)}
	seedTeardownRunRecord(t, state, event)
	if err := appendEvent(state, event); err != nil {
		t.Fatalf("append bounded teardown event: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || len(data) > MaxJSONLLineBytes-jsonlWriterSafetyMarginBytes {
		t.Fatalf("bounded teardown line is %d bytes, want 1..%d", len(data), MaxJSONLLineBytes-jsonlWriterSafetyMarginBytes)
	}
	if err := appendEvent(state, Event{Type: EventStart, RunID: "oversized", Command: strings.Repeat("x", MaxJSONLLineBytes)}); err == nil {
		t.Fatal("event writer accepted an oversized non-teardown record")
	}
}

// case: S-237.7
func TestDetachedRunTokenProcessIsOwnedWithoutMarkerOrAncestry(t *testing.T) {
	root := Process{PID: 100, Identity: "root", markerResult: "absent"}
	detached := Process{PID: 200, PPID: 1, Identity: "detached", markerResult: "absent", tokenResult: "match", runToken: true}
	tree, membership := processTreeFromSnapshotWithMembership([]Process{root, detached}, root.PID)
	if len(tree) != 1 || tree[0].PID != detached.PID {
		t.Fatalf("detached token holder tree = %+v, want PID %d", tree, detached.PID)
	}
	if got := membership[processObservationKey(detached)]; got != "accepted:run-token-fd" {
		t.Fatalf("detached token holder membership = %q, want accepted:run-token-fd", got)
	}
}

// case: S-237.7
func TestTreeCleanupSignalsDetachedRunTokenHolder(t *testing.T) {
	detached := Process{PID: 102, PPID: 1, Identity: "detached-start", tokenResult: "match", runToken: true}
	source := detachedHistorySource{alive: true, identity: detached.Identity, snapshot: []Process{{PID: 100, Identity: "keeper-start"}, detached}}
	cleanup := cleanupTreeWithSource(100, "run-token-test", nil, &source)
	if cleanup.err != nil || len(cleanup.Remaining) != 0 {
		t.Fatalf("token-owned cleanup = %+v, want clean teardown", cleanup)
	}
	if len(source.signals) == 0 || source.signals[0] != syscall.SIGTERM {
		t.Fatalf("signals to detached token holder = %v, want SIGTERM", source.signals)
	}
	if len(cleanup.History) != 1 || cleanup.History[0].PID != detached.PID || cleanup.History[0].Identity != detached.Identity {
		t.Fatalf("token-owned cleanup history = %+v, want detached PID/start", cleanup.History)
	}
}

// case: S-237.7
func TestRecordedProcessLosingRunTokenGetsTypedOwnershipReason(t *testing.T) {
	recorded := Process{PID: 102, PPID: 100, Identity: "same-start", markerResult: "absent", tokenResult: "match", runToken: true}
	current := Process{PID: 102, PPID: 1, Identity: "same-start", markerResult: "absent", tokenResult: "absent"}
	source := detachedHistorySource{alive: true, identity: "same-start", snapshot: []Process{{PID: 100, Identity: "root"}, current}}
	tree, membership, err := processTreeWithHistorySnapshot(&source, 100, []Process{recorded}, []Process{{PID: 100, Identity: "root"}, current})
	if err != nil {
		t.Fatalf("build tree with recorded token history: %v", err)
	}
	if len(tree) != 1 || tree[0].PID != recorded.PID {
		t.Fatalf("recorded process losing token tree = %+v, want PID %d", tree, recorded.PID)
	}
	if tree[0].OwnershipUnverifiedReason != OwnershipUnverifiedRunTokenClosed {
		t.Fatalf("ownership unverified reason = %q, want %q", tree[0].OwnershipUnverifiedReason, OwnershipUnverifiedRunTokenClosed)
	}
	if got := membership[processObservationKey(current)]; got != "accepted:recorded-pid-start-identity" {
		t.Fatalf("recorded process membership = %q, want accepted history", got)
	}
}

func TestSharedJSONLReaderReturnsTypedErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		line []byte
		kind JSONLLineErrorKind
	}{
		{name: "oversized", line: append(bytes.Repeat([]byte(" "), MaxJSONLLineBytes+1), '\n'), kind: JSONLLineTooLong},
		{name: "invalid", line: []byte("{broken}\n"), kind: JSONLLineInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := ReadJSONL(bytes.NewReader(test.line), func([]byte) error { return nil })
			var lineErr *JSONLLineError
			if !errors.As(err, &lineErr) || lineErr.Kind != test.kind || lineErr.Line != 1 {
				t.Fatalf("reader error = %v, want typed %s on line 1", err, test.kind)
			}
		})
	}
}

// case: S-237.7
func TestTeardownInventorySampleRetentionKeepsFirstLastAndMembershipChanges(t *testing.T) {
	var samples []ProcessTreeInventorySample
	for i := 0; i < maxTeardownInventorySamples+5; i++ {
		process := Process{PID: 100 + i, Identity: fmt.Sprintf("identity-%d", i)}
		reason := "accepted:parent-ancestry"
		if i == 3 || i == maxTeardownInventorySamples+4 {
			reason = "accepted:run-marker"
		}
		membership := map[string]string{processObservationKey(process): reason}
		sample := processTreeInventorySample(i+1, []Process{process}, nil, nil, membership, nil)
		samples = appendTeardownInventorySample(samples, sample)
	}
	if len(samples) != maxTeardownInventorySamples {
		t.Fatalf("retained samples = %d, want cap %d", len(samples), maxTeardownInventorySamples)
	}
	if samples[0].Index != 1 || samples[len(samples)-1].Index != maxTeardownInventorySamples+5 {
		t.Fatalf("retained sample boundaries = first %d last %d", samples[0].Index, samples[len(samples)-1].Index)
	}
	for i := 1; i < len(samples)-1; i++ {
		if !samples[i].MembershipChanged {
			t.Fatalf("retained interior sample %d is not a membership transition: %+v", samples[i].Index, samples)
		}
	}
}

// case: S-237.7
func TestMergeCleanupBoundsSamplesAndCountsDroppedObservations(t *testing.T) {
	var merged treeCleanup
	for i := 1; i <= 20; i++ {
		process := Process{PID: 200 + i, Identity: fmt.Sprintf("inventory-%d", i)}
		membership := "accepted:parent-ancestry"
		if i == 3 || i == 20 {
			membership = "accepted:run-marker"
		}
		sample := ProcessTreeInventorySample{Index: 1, Processes: []ProcessTreeInventoryEvidence{{PID: process.PID, Identity: process.Identity, Membership: membership}}}
		merged = mergeCleanup(merged, treeCleanup{Inventory: []ProcessTreeInventorySample{sample}})
	}
	if len(merged.Inventory) != maxTeardownInventorySamples || merged.InventorySamplesOmitted != 20-maxTeardownInventorySamples {
		t.Fatalf("merged inventory retained=%d omitted=%d, want cap=%d and exact omission count", len(merged.Inventory), merged.InventorySamplesOmitted, maxTeardownInventorySamples)
	}
	if merged.Inventory[0].Index != 1 || merged.Inventory[len(merged.Inventory)-1].Index != 20 {
		t.Fatalf("merged inventory sample boundaries = %d..%d, want 1..20", merged.Inventory[0].Index, merged.Inventory[len(merged.Inventory)-1].Index)
	}
	for i := 1; i < len(merged.Inventory)-1; i++ {
		if !merged.Inventory[i].MembershipChanged {
			t.Fatalf("merged interior sample %d is not a membership transition: %+v", merged.Inventory[i].Index, merged.Inventory)
		}
	}
	event := Event{Type: EventTeardown, RunID: "bounded-merge"}
	applyCleanupToEvent(&event, merged)
	if event.TeardownInventoryOmitted != merged.InventorySamplesOmitted {
		t.Fatalf("teardown event omitted sample count = %d, want %d", event.TeardownInventoryOmitted, merged.InventorySamplesOmitted)
	}
}

type advancingCleanupClock struct {
	start time.Time
	now   time.Time
}

func (clock *advancingCleanupClock) Now() time.Time              { return clock.now }
func (clock *advancingCleanupClock) Wait(duration time.Duration) { clock.now = clock.now.Add(duration) }

type persistentMarkerProcessSource struct{ signals []syscall.Signal }

func (*persistentMarkerProcessSource) Snapshot(string) ([]Process, error) {
	return []Process{{PID: 102, PPID: 1, Identity: "marker-start", runMarker: true, markerResult: "match"}}, nil
}

func TestCleanupEscalatesPreviouslySignalledIdentityAtDeadline(t *testing.T) {
	clock := &deadlineAfterTermClock{start: time.Unix(250, 0), now: time.Unix(250, 0)}
	source := &deadlineAfterTermSource{clock: clock}
	cleanup := cleanupTreeWithClock(100, "outer-run", nil, source, clock)
	if !reflect.DeepEqual(source.signals, []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL}) {
		t.Fatalf("signals for previously verified process = %v, want SIGTERM then SIGKILL", source.signals)
	}
	if len(cleanup.Remaining) != 1 || cleanup.Remaining[0].PID != 102 {
		t.Fatalf("persistent process outcome = %+v, want retained PID 102 after verified escalation", cleanup)
	}
}

type deadlineAfterTermSource struct {
	clock     *deadlineAfterTermClock
	snapshots int
	signals   []syscall.Signal
}

type deadlineAfterTermClock struct{ start, now time.Time }

func (clock *deadlineAfterTermClock) Now() time.Time     { return clock.now }
func (clock *deadlineAfterTermClock) Wait(time.Duration) { clock.now = clock.start.Add(cleanupBound) }

func (source *deadlineAfterTermSource) Snapshot(string) ([]Process, error) {
	source.snapshots++
	if source.snapshots == 1 {
		source.clock.now = source.clock.start.Add(cleanupBound - 100*time.Millisecond)
	} else if source.snapshots == 2 {
		source.clock.now = source.clock.start.Add(cleanupBound)
	}
	return []Process{{PID: 102, PPID: 1, Identity: "marker-start", runMarker: true, markerResult: "match"}}, nil
}
func (*deadlineAfterTermSource) Identity(pid int) (string, bool, error) {
	return "marker-start", pid == 102, nil
}
func (source *deadlineAfterTermSource) Signal(_ int, _ string, signal syscall.Signal) error {
	source.signals = append(source.signals, signal)
	return nil
}
func (*persistentMarkerProcessSource) Identity(pid int) (string, bool, error) {
	if pid == 102 {
		return "marker-start", true, nil
	}
	return "", false, nil
}
func (source *persistentMarkerProcessSource) Signal(_ int, _ string, signal syscall.Signal) error {
	source.signals = append(source.signals, signal)
	return nil
}

// case: S-237.7
func TestCleanupDoesNotSignalAfterSnapshotConsumesDeadline(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(300, 0), now: time.Unix(300, 0)}
	source := &deadlineAdvancingMarkerSource{clock: clock}
	cleanup := cleanupTreeWithClock(100, "outer-run", nil, source, clock)
	if len(source.signals) != 0 {
		t.Fatalf("signals after cleanup deadline = %v, want none", source.signals)
	}
	if len(cleanup.Remaining) != 1 || cleanup.Remaining[0].PID != 102 || cleanup.err == nil || !strings.Contains(cleanup.err.Error(), "deadline expired") {
		t.Fatalf("post-deadline owned process outcome = %+v, want PID 102 in Remaining with deadline error", cleanup)
	}
}

type deadlineAdvancingMarkerSource struct {
	clock   *advancingCleanupClock
	signals []syscall.Signal
}

func (source *deadlineAdvancingMarkerSource) Snapshot(string) ([]Process, error) {
	source.clock.now = source.clock.start.Add(cleanupBound)
	return []Process{{PID: 102, PPID: 1, Identity: "marker-start", runMarker: true, markerResult: "match"}}, nil
}
func (*deadlineAdvancingMarkerSource) Identity(pid int) (string, bool, error) {
	if pid == 102 {
		return "marker-start", true, nil
	}
	return "", false, nil
}
func (source *deadlineAdvancingMarkerSource) Signal(_ int, _ string, signal syscall.Signal) error {
	source.signals = append(source.signals, signal)
	return nil
}

// case: S-237.7
func TestCleanupDoesNotSignalAfterIdentityCheckConsumesDeadline(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(400, 0), now: time.Unix(400, 0)}
	source := &identityAdvancingMarkerSource{clock: clock}
	cleanup := cleanupTreeWithClock(100, "outer-run", nil, source, clock)
	if len(source.signals) != 0 {
		t.Fatalf("signals after cleanup deadline = %v, want none", source.signals)
	}
	if len(cleanup.Remaining) != 1 || cleanup.Remaining[0].PID != 102 || cleanup.err == nil || !strings.Contains(cleanup.err.Error(), "deadline expired") {
		t.Fatalf("post-deadline owned process outcome = %+v, want PID 102 in Remaining with deadline error", cleanup)
	}
}

type identityAdvancingMarkerSource struct {
	clock   *advancingCleanupClock
	signals []syscall.Signal
}

func (*identityAdvancingMarkerSource) Snapshot(string) ([]Process, error) {
	return []Process{{PID: 102, PPID: 1, Identity: "marker-start", runMarker: true, markerResult: "match"}}, nil
}
func (source *identityAdvancingMarkerSource) Identity(pid int) (string, bool, error) {
	source.clock.now = source.clock.start.Add(cleanupBound)
	if pid == 102 {
		return "marker-start", true, nil
	}
	return "", false, nil
}
func (source *identityAdvancingMarkerSource) Signal(_ int, _ string, signal syscall.Signal) error {
	source.signals = append(source.signals, signal)
	return nil
}

type rootMarkerProcessSource struct{ snapshots int }

func (source *rootMarkerProcessSource) Snapshot(string) ([]Process, error) {
	source.snapshots++
	return []Process{{PID: 100, Identity: "root-marker-start", runMarker: true, markerResult: "match"}}, nil
}
func (*rootMarkerProcessSource) Identity(int) (string, bool, error)       { return "", false, nil }
func (*rootMarkerProcessSource) Signal(int, string, syscall.Signal) error { return nil }

func TestRunIdentityHistoryRetainsDetachedDescendantOwnership(t *testing.T) {
	source := &detachedHistorySource{alive: true}
	observed := []Process{{PID: 102, PPID: 101, processGroupID: 101, Identity: "nested-start"}}
	tree, err := processTreeWithHistorySource(source, 100, "outer-run", observed)
	if err != nil || len(tree) != 1 || tree[0].PID != 102 || tree[0].Identity != "nested-start" {
		t.Fatalf("detached process tree = %+v err=%v; want recorded PID/start identity 102", tree, err)
	}
	cleanup := cleanupTreeWithSource(100, "outer-run", observed, source)
	if cleanup.err != nil || len(source.signals) == 0 || source.signals[0] != syscall.SIGTERM || len(cleanup.Remaining) != 0 {
		t.Fatalf("detached identity teardown = %+v signals=%v; want observed identity signaled and reaped", cleanup, source.signals)
	}
	if len(cleanup.History) != 1 || cleanup.History[0].PID != 102 || cleanup.History[0].Identity != "nested-start" || len(cleanup.Inventory) == 0 {
		t.Fatalf("teardown diagnostics history=%+v inventory samples=%d; want the run identity and cleanup snapshots", cleanup.History, len(cleanup.Inventory))
	}
	foundHistory := false
	for _, item := range cleanup.Inventory[0].Processes {
		if item.PID == 102 {
			foundHistory = item.MarkerResult == "not-in-current-inventory" && item.Membership == "accepted:recorded-pid-start-identity"
		}
	}
	if !foundHistory {
		t.Fatalf("first teardown sample does not show detached history membership: %+v", cleanup.Inventory[0])
	}
}

// case: S-237.69
func TestSubreaperContainmentTargetsDescendantsAcrossRunMarkerBoundaries(t *testing.T) {
	source := &subreaperContainmentFixture{
		live: map[int]Process{
			100: {PID: 100, Identity: "keeper-start"},
			101: {PID: 101, PPID: 100, processGroupID: 901, sessionID: 901, Identity: "outer-command", markerResult: "match", runMarker: true, processState: "S"},
			102: {PID: 102, PPID: 101, processGroupID: 902, sessionID: 902, Identity: "inner-keeper", markerResult: "other-run", runToken: true, processState: "S"},
			103: {PID: 103, PPID: 101, processGroupID: 903, sessionID: 903, Identity: "setsid-descendant", markerResult: "match", processState: "S"},
			104: {PID: 104, PPID: 102, processGroupID: 904, sessionID: 904, Identity: "inner-descendant", markerResult: "other-run", processState: "S"},
		},
	}
	cleanup := cleanupTreeWithSource(100, "outer-run", nil, source)
	if cleanup.err != nil || len(cleanup.Remaining) != 0 {
		t.Fatalf("subreaper cleanup = %+v; want empty tree without errors", cleanup)
	}
	if len(source.signals) != 2 {
		t.Fatalf("subreaper signals = %+v; want the outer command and its setsid descendant, excluding the inner keeper's subtree", source.signals)
	}
	if source.snapshots < 3 {
		t.Fatalf("subreaper snapshots = %d, want repeated empty-tree confirmation", source.snapshots)
	}
	gotSignals := map[int]bool{}
	for _, signal := range source.signals {
		if signal.signal != syscall.SIGTERM {
			t.Fatalf("subreaper signal = %+v; want initial SIGTERM", signal)
		}
		gotSignals[signal.pid] = true
	}
	if !gotSignals[101] || !gotSignals[103] || gotSignals[102] || gotSignals[104] {
		t.Fatalf("subreaper ownership signals = %v; want outer PIDs 101 and 103 only", gotSignals)
	}
}

func TestProcessDescendantsFromSnapshotIncludesDetachedSameRunMarker(t *testing.T) {
	snapshot := []Process{
		{PID: 100, Identity: "keeper"},
		{PID: 101, PPID: 100, Identity: "command", markerResult: "match"},
		{PID: 102, PPID: 101, processGroupID: 700, sessionID: 700, Identity: "setsid", markerResult: "match"},
		{PID: 103, PPID: 1, Identity: "unrelated"},
	}
	got := processDescendantsFromSnapshot(snapshot, 100)
	if len(got) != 2 || got[0].PID != 101 || got[1].PID != 102 {
		t.Fatalf("keeper descendants = %+v, want command and detached descendant only", got)
	}
}

func TestProcessDescendantsRespectNestedOwnerAndIgnoreZombie(t *testing.T) {
	snapshot := []Process{
		{PID: 100, Identity: "outer-keeper"},
		{PID: 101, PPID: 100, Identity: "outer-command", markerResult: "match"},
		{PID: 102, PPID: 101, Identity: "inner-keeper", markerResult: "other-run", runToken: true},
		{PID: 103, PPID: 102, Identity: "inner-command", markerResult: "other-run"},
		{PID: 104, PPID: 101, Identity: "exited-child", markerResult: "match", processState: "Z"},
	}
	got := processDescendantsFromSnapshot(snapshot, 100)
	if len(got) != 1 || got[0].PID != 101 {
		t.Fatalf("outer keeper descendants = %+v, want only its live command; nested owner and zombie must be excluded", got)
	}
}

// case: S-237.69
func TestRunRecoveryCandidatesIncludeRecordedDescendantsAndExcludeZombies(t *testing.T) {
	startedAt := time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC)
	processes := []Process{
		{PID: 14223, PPID: 100, Identity: "70213", StartedAt: startedAt, processState: "S"},
		{PID: 14224, PPID: 14223, Identity: "70213", StartedAt: startedAt, processState: "S"},
		{PID: 14225, PPID: 14224, Identity: "70214", StartedAt: startedAt, processState: "S"},
		{PID: 14226, PPID: 1, Identity: "70215", StartedAt: startedAt.Add(4 * time.Second), runMarker: true, markerResult: "match", processState: "S"},
		{PID: 14227, PPID: 14223, Identity: "70216", StartedAt: startedAt.Add(4 * time.Second), runMarker: true, markerResult: "match", processState: "Z"},
		{PID: 14228, PPID: 14223, Identity: "70217", StartedAt: startedAt.Add(4 * time.Second), markerResult: "other-run", runToken: true, processState: "S"},
		{PID: 14229, PPID: 14228, Identity: "70218", StartedAt: startedAt.Add(5 * time.Second), processState: "S"},
		{PID: 14230, PPID: 14223, Identity: "70219", StartedAt: startedAt.Add(-time.Second), processState: "S"},
		{PID: 14231, PPID: 1, Identity: "70220", StartedAt: startedAt.Add(2 * time.Second), processState: "S"},
	}
	recorded := []Process{{PID: 14223, Identity: "70213"}}
	got, err := runRecoveryCandidates(processes, startedAt, recorded)
	if err != nil {
		t.Fatal(err)
	}
	want := []int{14223, 14224, 14225, 14226}
	if len(got) != len(want) {
		t.Fatalf("recovery targets=%+v, want PIDs %v", got, want)
	}
	for index, pid := range want {
		if got[index].PID != pid {
			t.Fatalf("recovery target[%d]=%d, want %d; all=%+v", index, got[index].PID, pid, got)
		}
	}
}

func TestProcessTreeDoesNotReenterNestedRunThroughInheritedToken(t *testing.T) {
	snapshot := []Process{
		{PID: 100, Identity: "outer-keeper"},
		{PID: 101, PPID: 100, Identity: "outer-command", markerResult: "match", runMarker: true},
		{PID: 102, PPID: 101, Identity: "inner-keeper", markerResult: "other-run", runToken: true},
		{PID: 103, PPID: 102, Identity: "inner-detached", markerResult: "other-run", runToken: true},
	}
	got := processTreeFromSnapshot(snapshot, 100)
	if len(got) != 1 || got[0].PID != 101 {
		t.Fatalf("outer process tree=%+v, want only PID 101; inherited token must not cross the inner marker", got)
	}
}

// case: S-237.69
func TestRunMarkerRecoveryRequiresMarkerAndPostStartIdentity(t *testing.T) {
	startedAt := time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC)
	processes := []Process{
		{PID: 100, runMarker: true, StartedAt: startedAt.Add(-time.Second)},
		{PID: 101, runMarker: true, StartedAt: startedAt},
		{PID: 102, runMarker: true, StartedAt: startedAt.Add(time.Second)},
		{PID: 103, StartedAt: startedAt.Add(time.Second)},
	}
	got, err := runRecoveryCandidates(processes, startedAt, nil)
	if err != nil || len(got) != 2 || got[0].PID != 101 || got[1].PID != 102 {
		t.Fatalf("run-marker recovery candidates=%+v err=%v, want only marked processes started at/after run start", got, err)
	}
	if _, err := runRecoveryCandidates(processes, time.Time{}, nil); err == nil {
		t.Fatal("run-marker recovery accepted a missing run start time")
	}
	processes[1].StartedAt = time.Time{}
	if _, err := runRecoveryCandidates(processes[1:2], startedAt, nil); err == nil {
		t.Fatal("run-marker recovery accepted a marked process without start identity time")
	}
}

func TestSubreaperCleanupReportsNamedSurvivorsAtDeadline(t *testing.T) {
	clock := &advancingCleanupClock{start: time.Unix(400, 0), now: time.Unix(400, 0)}
	source := &subreaperContainmentFixture{
		clock:   clock,
		blocked: true,
		live: map[int]Process{
			100: {PID: 100, Identity: "keeper-start"},
			101: {PID: 101, PPID: 100, processGroupID: 901, sessionID: 901, Identity: "outer-command", processState: "S"},
			102: {PID: 102, PPID: 101, processGroupID: 902, sessionID: 902, Identity: "setsid-survivor", processState: "S"},
		},
	}
	cleanup := cleanupTreeWithClock(100, "outer-run", nil, source, clock)
	if cleanup.err == nil || !strings.Contains(cleanup.err.Error(), "pid=102 state=S ppid=101 pgid=902 sid=902") {
		t.Fatalf("survivor cleanup error = %v, want PID/state/PPID/PGID/SID for PID 102", cleanup.err)
	}
}

type subreaperContainmentFixture struct {
	live      map[int]Process
	blocked   bool
	clock     *advancingCleanupClock
	snapshots int
	signals   []struct {
		pid      int
		signal   syscall.Signal
		identity string
	}
}

func (source *subreaperContainmentFixture) Snapshot(string) ([]Process, error) {
	source.snapshots++
	if source.clock != nil {
		source.clock.now = source.clock.now.Add(cleanupPoll)
	}
	processes := make([]Process, 0, len(source.live))
	for _, process := range source.live {
		processes = append(processes, process)
	}
	return processes, nil
}

func (source *subreaperContainmentFixture) Identity(pid int) (string, bool, error) {
	process, ok := source.live[pid]
	return process.Identity, ok, nil
}

func (source *subreaperContainmentFixture) Signal(pid int, identity string, signal syscall.Signal) error {
	source.signals = append(source.signals, struct {
		pid      int
		signal   syscall.Signal
		identity string
	}{pid: pid, signal: signal, identity: identity})
	if !source.blocked {
		delete(source.live, pid)
	}
	return nil
}

func (source *subreaperContainmentFixture) ContainedDescendants(root int, snapshot []Process) ([]Process, bool, error) {
	if _, exists := source.live[root]; !exists {
		return nil, false, nil
	}
	return processDescendantsFromSnapshot(snapshot, root), true, nil
}

func TestDetachedDescendantClosingTokenAndClearingMarkerBeforeFirstSnapshotIsUnowned(t *testing.T) {
	source := &detachedHistorySource{alive: true}
	snapshot := []Process{
		{PID: 100, Identity: "keeper-start"},
		// This is the first observed state after the descendant closed inherited
		// fd 3, cleared KBLABS_CLIPROC_RUN, and detached before sampling.
		{PID: 102, PPID: 1, processGroupID: 1, sessionID: 1, uid: 501, Identity: "detached-start", markerResult: "absent", tokenResult: "absent"},
	}
	_, membership, err := processTreeWithHistorySnapshot(source, 100, nil, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	sample := processTreeInventorySample(1, snapshot, nil, nil, membership, nil)
	if len(sample.Processes) != 1 || sample.Processes[0].PID != 100 {
		t.Fatalf("unmarked unowned candidate was retained in inventory: %+v", sample.Processes)
	}
	if sample.OmittedProcesses != 1 || membership[processObservationKey(snapshot[1])] != "rejected:no-run-marker-or-parent-history" {
		t.Fatalf("unowned candidate accounting=%+v membership=%v; want omission count and production rejection", sample, membership[processObservationKey(snapshot[1])])
	}
}

func TestTeardownHistoryIncludesRunMarkerDiscovery(t *testing.T) {
	source := &detachedHistorySource{
		alive:    true,
		identity: "detached-start",
		snapshot: []Process{
			{PID: 100, Identity: "keeper-start"},
			{PID: 102, PPID: 1, processGroupID: 1, sessionID: 1, uid: 501, Identity: "detached-start", runMarker: true, markerResult: "match"},
		},
	}
	cleanup := cleanupTreeWithSource(100, "outer-run", nil, source)
	if cleanup.err != nil || len(source.signals) == 0 || len(cleanup.History) != 1 {
		t.Fatalf("marker-discovered cleanup=%+v signals=%v; want teardown history and signal", cleanup, source.signals)
	}
	if got := cleanup.History[0]; got.PID != 102 || got.PPID != 1 || got.PGID != 1 || got.SID != 1 || got.Identity != "detached-start" {
		t.Fatalf("marker-discovered identity history = %+v; want detached PID/start evidence", got)
	}
}

// case: S-237.7
func TestTeardownAdoptsDetachedRunMarkerWithUnknownUID(t *testing.T) {
	source := &markerInventoryProcessSource{
		rootPID:     100,
		alive:       true,
		markerCache: newProcessMarkerCache(),
		processes: []Process{
			{PID: 100, PPID: 1, Identity: "keeper-start", uid: 501},
			{PID: 102, PPID: 1, processGroupID: 1, sessionID: 1, Identity: "detached-start", uid: 0},
		},
		markers: map[int]string{102: "outer-run"},
	}
	cleanup := cleanupTreeWithSource(100, "outer-run", nil, source)
	if cleanup.err != nil || len(source.signals) != 1 || source.signals[0] != 102 {
		t.Fatalf("unknown-UID detached cleanup=%+v signals=%v; want marker-owned PID 102 signaled", cleanup, source.signals)
	}
	if len(cleanup.History) != 1 || cleanup.History[0].PID != 102 || cleanup.History[0].Identity != "detached-start" || len(cleanup.Remaining) != 0 {
		t.Fatalf("unknown-UID detached identity history=%+v remaining=%+v; want PID/start recorded and reaped", cleanup.History, cleanup.Remaining)
	}
	foundMarker := false
	for _, process := range cleanup.Inventory[0].Processes {
		if process.PID == 102 {
			foundMarker = process.MarkerResult == "match" && process.Membership == "accepted:run-marker"
		}
	}
	if !foundMarker {
		t.Fatalf("first inventory did not prove detached PID membership by run marker: %+v", cleanup.Inventory[0])
	}
}

type markerInventoryProcessSource struct {
	rootPID     int
	alive       bool
	markerCache *processMarkerCache
	processes   []Process
	markers     map[int]string
	signals     []int
}

func (source *markerInventoryProcessSource) Snapshot(runID string) ([]Process, error) {
	processes := make([]Process, 0, len(source.processes))
	for _, process := range source.processes {
		if process.PID != 102 || source.alive {
			processes = append(processes, process)
		}
	}
	candidates := processInspectionCandidates(processes, source.rootPID)
	return applyCachedProcessMarkers(processes, candidates, runID, source.markerCache, func(pid int) (string, bool, error) {
		return source.markers[pid], false, nil
	}), nil
}

func (source *markerInventoryProcessSource) Identity(pid int) (string, bool, error) {
	if pid == 102 && source.alive {
		return "detached-start", true, nil
	}
	return "", false, nil
}

func (source *markerInventoryProcessSource) Signal(pid int, _ string, signal syscall.Signal) error {
	if pid != 102 {
		return fmt.Errorf("unexpected signal target %d", pid)
	}
	source.signals = append(source.signals, pid)
	source.alive = false
	return nil
}

type detachedHistorySource struct {
	alive    bool
	identity string
	snapshot []Process
	signals  []syscall.Signal
}

func (source *detachedHistorySource) Snapshot(string) ([]Process, error) {
	processes := make([]Process, 0, len(source.snapshot))
	for _, process := range source.snapshot {
		if process.PID != 102 || source.alive {
			processes = append(processes, process)
		}
	}
	return processes, nil
}

func (source *detachedHistorySource) Identity(pid int) (string, bool, error) {
	if pid == 102 && source.alive {
		if source.identity != "" {
			return source.identity, true, nil
		}
		return "nested-start", true, nil
	}
	return "", false, nil
}

func (source *detachedHistorySource) Signal(pid int, _ string, signal syscall.Signal) error {
	if pid != 102 {
		return fmt.Errorf("unexpected signal target %d", pid)
	}
	source.signals = append(source.signals, signal)
	source.alive = false
	return nil
}

type failingProcessSource struct{ err error }

func (s failingProcessSource) Snapshot(string) ([]Process, error)     { return nil, s.err }
func (failingProcessSource) Identity(int) (string, bool, error)       { return "", false, nil }
func (failingProcessSource) Signal(int, string, syscall.Signal) error { return nil }

type emptyProcessSource struct{}

func (emptyProcessSource) Snapshot(string) ([]Process, error)       { return nil, nil }
func (emptyProcessSource) Identity(int) (string, bool, error)       { return "", false, nil }
func (emptyProcessSource) Signal(int, string, syscall.Signal) error { return nil }

func TestLostRunWithoutRecordedTreeIsNotClean(t *testing.T) {
	cleanup := cleanupLostRun(record{PID: 777, RunID: "lost-run"}, emptyProcessSource{})
	if cleanup.err == nil || !strings.Contains(cleanup.err.Error(), "no persisted owned process identity") {
		t.Fatalf("lost run with an empty observation was reported clean: %+v", cleanup)
	}
}

func TestTreeCleanupReportsProcessTableObservationError(t *testing.T) {
	observationErr := errors.New("process table denied")
	result := cleanupTreeWithSource(777, "run", nil, failingProcessSource{err: observationErr})
	if !errors.Is(result.err, observationErr) {
		t.Fatalf("tree cleanup error = %v, want wrapped observation error", result.err)
	}
	if len(result.Reaped) != 0 || len(result.Unverified) != 0 {
		t.Fatalf("failed observation was reported as a clean/empty tree: %+v", result)
	}
}

func TestProcessTreeExcludesUnverifiedSameUIDWithoutOwnershipEvidence(t *testing.T) {
	started := time.Now()
	tree := processTreeFromSnapshot([]Process{
		{PID: 777, PPID: 1, Command: "keeper", StartedAt: started, Identity: "keeper", uid: 501},
		{PID: 778, PPID: 1, Command: "launchd-sibling", StartedAt: started.Add(time.Second), Identity: "sibling", uid: 501, Unverified: true},
	}, 777)
	if len(tree) != 0 {
		t.Fatalf("same-uid process without ancestry, history, or marker was added to tree: %+v", tree)
	}
}

type failedHistoryIdentitySource struct {
	processes []Process
	err       error
}

func (s failedHistoryIdentitySource) Snapshot(string) ([]Process, error) { return s.processes, nil }
func (s failedHistoryIdentitySource) Identity(int) (string, bool, error) {
	return "", false, s.err
}
func (failedHistoryIdentitySource) Signal(int, string, syscall.Signal) error { return nil }

func TestProcessTreeRetainsHistoryAsUnverifiedWhenIdentityReadFails(t *testing.T) {
	identityErr := errors.New("identity denied")
	observed := []Process{{PID: 778, PPID: 777, Command: "detached-child", Identity: "child-start"}}
	tree, err := processTreeWithHistorySource(failedHistoryIdentitySource{
		processes: []Process{{PID: 777, PPID: 1, Command: "keeper", Identity: "keeper-start"}},
		err:       identityErr,
	}, 777, "run", observed)
	if !errors.Is(err, identityErr) {
		t.Fatalf("history identity error = %v, want %v", err, identityErr)
	}
	if len(tree) != 1 || tree[0].PID != 778 || !tree[0].Unverified {
		t.Fatalf("history entry after identity failure = %+v, want PID 778 unverified", tree)
	}
}

type deniedCandidateSource struct {
	processes []Process
	deniedPID int
	uid       uint32
}

func (s *deniedCandidateSource) Snapshot(runID string) ([]Process, error) {
	candidates := processInspectionCandidates(s.processes, 777)
	return applyCachedProcessMarkers(s.processes, candidates, runID, newProcessMarkerCache(), func(pid int) (string, bool, error) {
		if pid == s.deniedPID {
			return "", false, syscall.EACCES
		}
		return "", false, nil
	}), nil
}

func (s *deniedCandidateSource) Identity(pid int) (string, bool, error) {
	for _, process := range s.processes {
		if process.PID == pid {
			return process.Identity, true, nil
		}
	}
	return "", false, nil
}

func (*deniedCandidateSource) Signal(int, string, syscall.Signal) error { return nil }

func newDeniedCandidateSource(deniedPID int) *deniedCandidateSource {
	started := time.Now().Add(-time.Second)
	return &deniedCandidateSource{uid: 501, deniedPID: deniedPID, processes: []Process{
		{PID: 777, PPID: 1, Command: "keeper", StartedAt: started, Identity: "keeper", uid: 501},
		{PID: 778, PPID: 1, Command: "foreign-unrelated", StartedAt: started.Add(time.Millisecond), Identity: "foreign", uid: 0},
		{PID: 779, PPID: 1, Command: "same-user-unrelated", StartedAt: started.Add(time.Millisecond), Identity: "same-user", uid: 501},
		{PID: 780, PPID: 777, Command: "foreign-descendant", StartedAt: started.Add(time.Millisecond), Identity: "descendant", uid: 0},
	}}
}

// case: S-237.13
func TestForeignUIDDenialOutsideAncestryDoesNotDirtyTeardown(t *testing.T) {
	source := newDeniedCandidateSource(778)
	source.processes[3].PPID = 1
	result := cleanupTreeWithSource(777, "denied-run", nil, source)
	if result.err != nil || len(result.Unverified) != 0 || len(result.Remaining) != 0 {
		t.Fatalf("foreign unrelated process made teardown unclean: %+v", result)
	}
}

// case: S-237.13
func TestSameUIDDenialWithoutHistoryDoesNotDirtyTeardown(t *testing.T) {
	source := newDeniedCandidateSource(779)
	source.processes[3].PPID = 1
	result := cleanupTreeWithSource(777, "denied-run", nil, source)
	if result.err != nil || len(result.Unverified) != 0 || len(result.Remaining) != 0 {
		t.Fatalf("same-uid process without history made teardown unclean: %+v", result)
	}
}

// case: S-237.13
func TestAncestryDenialKeepsCurrentDescendantOwned(t *testing.T) {
	source := newDeniedCandidateSource(780)
	snapshot, err := source.Snapshot("denied-run")
	if err != nil {
		t.Fatal(err)
	}
	tree := processTreeFromSnapshot(snapshot, 777)
	for _, process := range tree {
		if process.PID == 780 {
			if process.Unverified {
				t.Fatalf("current ancestry descendant marked unverified after marker denial: %+v", process)
			}
			return
		}
	}
	t.Fatalf("current ancestry descendant omitted after marker denial: %+v", tree)
}

// case: S-237.14
func TestWaitLatestTagSelectsNewestTerminalRun(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	firstCode, latestCode := 0, 7
	base := time.Now().Add(-time.Minute)
	for _, rec := range []record{
		{RunID: "first", Tag: "agent:stream:first", LatestTag: "stream", StateDir: state, Status: StatusCompleted, EnqueuedAt: base, ExitCode: &firstCode},
		{RunID: "latest", Tag: "resume:stream:latest", LatestTag: "stream", StateDir: state, Status: StatusFailed, EnqueuedAt: base.Add(time.Second), ExitCode: &latestCode},
	} {
		if err := writeRecordAtomic(rec); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	info, err := WaitLatestTag(ctx, state, "stream")
	if err != nil {
		t.Fatal(err)
	}
	if info.RunID != "latest" || info.ExitCode == nil || *info.ExitCode != 7 {
		t.Fatalf("latest run = %+v, want terminal run latest with exit 7", info)
	}
}

// case: S-237.11
func TestWaitRunIDSelectsRequestedRunWhenTagIsReused(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	firstCode, secondCode := 0, 7
	base := time.Now().Add(-time.Minute)
	for _, rec := range []record{
		{RunID: "first", Tag: "reused", StateDir: state, Status: StatusCompleted, EnqueuedAt: base, ExitCode: &firstCode},
		{RunID: "second", Tag: "reused", StateDir: state, Status: StatusFailed, EnqueuedAt: base.Add(time.Second), ExitCode: &secondCode},
	} {
		if err := writeRecordAtomic(rec); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	info, err := WaitRunID(ctx, state, "second")
	if err != nil {
		t.Fatal(err)
	}
	if info.RunID != "second" || info.Tag != "reused" || info.ExitCode == nil || *info.ExitCode != 7 {
		t.Fatalf("run ID wait = %+v, want second run with child status 7", info)
	}
}

// case: S-237.11
func TestStartRejectsRelativeStateDirBeforeStartingKeeper(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	run, err := StartWithHostResourceSource(ctx, Config{StateDir: "relative-state"}, systemHostResourceSource())
	if err == nil || !strings.Contains(err.Error(), "state directory must be absolute") {
		t.Fatalf("start with relative state dir = run %v, err %v; want an absolute-path contract error", run, err)
	}
}

// case: S-237.11
func TestCanonicalStateDirResolvesRelativeArgument(t *testing.T) {
	canonical, err := CanonicalStateDir(filepath.Join("logs", "runner"))
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(canonical) || filepath.Clean(canonical) != canonical {
		t.Fatalf("canonical state directory = %q, want a cleaned absolute path", canonical)
	}
}

type deniedEnvironmentSource struct {
	signaled []int
}

func (s *deniedEnvironmentSource) Snapshot(string) ([]Process, error) {
	processes := []Process{{
		PID: 778, PPID: 1, Command: "detached-child", StartedAt: time.Now(),
		Identity: "child-start", uid: uint32(os.Getuid()),
	}}
	return applyCachedProcessMarkers(processes, map[int]bool{778: true}, "denied-run", newProcessMarkerCache(), func(int) (string, bool, error) {
		return "", false, syscall.EACCES
	}), nil
}

func (*deniedEnvironmentSource) Identity(int) (string, bool, error) {
	return "child-start", true, nil
}

func (s *deniedEnvironmentSource) Signal(pid int, _ string, _ syscall.Signal) error {
	s.signaled = append(s.signaled, pid)
	return nil
}

// case: S-237.13
func TestDeniedEnvironmentWithoutHistoryDoesNotDirtyTeardown(t *testing.T) {
	source := &deniedEnvironmentSource{}
	result := cleanupTreeWithSource(777, "denied-run", nil, source)
	if result.err != nil || len(result.Unverified) != 0 || len(result.Remaining) != 0 {
		t.Fatalf("unrelated hidden-environment process made teardown unclean: %+v", result)
	}
	if len(source.signaled) != 0 {
		t.Fatalf("unrelated process was signaled: %v", source.signaled)
	}
}

type lateDescendantSource struct {
	snapshots int
	alive     bool
	signals   []syscall.Signal
}

func (s *lateDescendantSource) Snapshot(string) ([]Process, error) {
	s.snapshots++
	if s.snapshots == 1 || !s.alive {
		return nil, nil
	}
	return []Process{{
		PID: 779, PPID: 1, Command: "late-detached-child", StartedAt: time.Now(),
		Identity: "late-child-start", runMarker: true,
	}}, nil
}

func (s *lateDescendantSource) Identity(pid int) (string, bool, error) {
	if pid == 779 && s.alive {
		return "late-child-start", true, nil
	}
	return "", false, nil
}

func (s *lateDescendantSource) Signal(pid int, _ string, signal syscall.Signal) error {
	if pid != 779 {
		return errors.New("cleanup signaled an unexpected process")
	}
	s.signals = append(s.signals, signal)
	s.alive = false
	return nil
}

// case: S-237.1
func TestCleanupConvergesOnDescendantAfterInitialSnapshot(t *testing.T) {
	source := &lateDescendantSource{alive: true}
	result := cleanupTreeWithSource(777, "late-run", nil, source)
	if result.err != nil {
		t.Fatalf("tree cleanup error = %v", result.err)
	}
	if len(source.signals) == 0 || source.signals[0] != syscall.SIGTERM {
		t.Fatalf("late descendant signals = %v, want SIGTERM", source.signals)
	}
	if len(result.Reaped) != 1 || result.Reaped[0].PID != 779 {
		t.Fatalf("reaped = %+v, want late descendant PID 779", result.Reaped)
	}
	if len(result.Remaining) != 0 {
		t.Fatalf("remaining = %+v, want empty after convergence", result.Remaining)
	}
	if source.snapshots < 4 {
		t.Fatalf("snapshot count = %d, want initial empty, late descendant, and two empty convergence observations", source.snapshots)
	}
}
