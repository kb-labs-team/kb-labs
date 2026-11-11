//go:build darwin || linux

package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func TestHygieneKeepsActiveStreamTestCacheAndReapsTerminalStreamCache(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	job, err := store.Create(Job{ID: "test-cache-active", Stream: "stream-one", Vendor: "codex", State: JobRunning, Phase: PhaseRun})
	if err != nil {
		t.Fatal(err)
	}
	cache := testChannelCachePath(state, job.Stream)
	if cache == testChannelCachePath(state, "stream-two") {
		t.Fatal("different streams share an outside-test Go build cache")
	}
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "entry"), []byte("stream cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	report := hygieneReport{Actions: []hygieneAction{}, eventRoot: state}
	if err := sweepTestChannelCaches(state, context.Background(), false, &report); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cache, "entry")); err != nil {
		t.Fatalf("active stream cache was reaped: %v", err)
	}
	if err := store.Update(job.ID, func(job *Job) error { job.State = JobOK; return nil }); err != nil {
		t.Fatal(err)
	}
	report = hygieneReport{Actions: []hygieneAction{}, eventRoot: state}
	if err := sweepTestChannelCaches(state, context.Background(), false, &report); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cache); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("terminal stream cache remains: %v", err)
	}
	if !hasHygieneAction(report, "test-channel-cache", "reaped") {
		t.Fatalf("stream cache reap was not journaled in hygiene report: %+v", report.Actions)
	}
}

// case: S-276.1
func TestHygieneLivenessUsesSchedulerStateAndObservedWorktreePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker")
	for _, state := range []SchedulerStreamState{SchedulerReady, SchedulerRunning} {
		live, err := streamIsLive("worker", path, map[string]SchedulerStream{"worker": {Stream: "worker", State: state}}, nil, nil)
		if err != nil || !live {
			t.Fatalf("scheduler %s stream was not live: %v", state, err)
		}
	}
	processes := []processInfo{{cwd: filepath.Join(path, "nested"), argv: strings.Join([]string{"tool", "--workdir", path}, "\x00")}}
	live, err := streamIsLive("worker", path, map[string]SchedulerStream{}, nil, processes)
	if err != nil || !live {
		t.Fatalf("process using worktree was not live: %v", err)
	}
}

func TestHygieneUnreadableProcessBlocksOnlyWithVerifiedCandidatePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker")
	for _, test := range []struct {
		name, argv string
		wantLive   bool
	}{
		{name: "unrelated unreadable cwd", argv: strings.Join([]string{"systemd", "--user"}, "\x00")},
		{name: "absolute candidate argument", argv: strings.Join([]string{"runner", "--workdir", path}, "\x00"), wantLive: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			process := processInfo{pid: 19, identity: "start-19", command: "process", argv: test.argv, cwdError: "permission denied"}
			live, err := streamIsLive("worker", path, nil, nil, []processInfo{process})
			if err != nil || live != test.wantLive {
				t.Fatalf("candidate liveness = %t, %v; want %t", live, err, test.wantLive)
			}
		})
	}
}

func TestHygieneKeepsQueuedZeroCommitStreamLive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queued-stream")
	states := map[string]SchedulerStream{
		"queued-stream": {
			Stream:  "queued-stream",
			State:   SchedulerAwaitingOrchestrator,
			Advance: &StreamAdvance{State: AdvanceVerifying, Round: 0},
		},
	}
	live, err := streamIsLive("queued-stream", path, states, nil, nil)
	if err != nil || !live {
		t.Fatalf("queued zero-commit stream was not live: live=%v err=%v", live, err)
	}
}

// case: S-276.6
func TestHygieneProcessSnapshotSeparatesUnreadableUIDClasses(t *testing.T) {
	entries := []proc.ProcessInventoryEntry{
		{PID: 9001, UID: 501, Command: "runner", CwdError: "permission denied"},
		{PID: 9002, UID: 0, Command: "daemon", CwdError: "permission denied"},
		{PID: 9003, UID: 0, Command: "gone", Identity: "old-start", CWD: ""},
	}
	snapshot := processSnapshotFromEntries(entries, 501)
	if len(snapshot.UnreadableOwned) != 1 || snapshot.UnreadableOwned[0].pid != 9001 || snapshot.UnreadableOther != 1 || len(snapshot.Processes) != 0 {
		t.Fatalf("process inventory classification = %+v", snapshot)
	}
}

// case: S-276.1
func TestWorktreeSweepSkipsSharedLeaseHolder(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "worker")
	gitTest(t, integration, "worktree", "add", "-b", "agent/worker", worktree, "HEAD")
	shared, acquired, err := proc.AcquireFileLease(worktreeLeasePath(root, worktree), proc.LeaseShared)
	if err != nil || !acquired {
		t.Fatalf("hold runner worker lease: acquired=%t err=%v", acquired, err)
	}
	defer func() {
		if err := shared.Close(); err != nil {
			t.Errorf("release runner worker lease: %v", err)
		}
	}()
	report := hygieneReport{Actions: []hygieneAction{}, eventRoot: root}
	candidate := ownedWorktree{gitWorktree: gitWorktree{Path: worktree, Branch: "agent/worker"}, ResolvedPath: worktree}
	if err := sweepWorktreeCandidate(hygieneOptions{Root: root, Integration: integration}, root, integration, candidate, nil, nil, livenessSnapshot{}, &report); err != nil {
		t.Fatal(err)
	}
	if !hasHygieneActionWithCause(report, "worktree", "skipped", "owned worktree has an active runner lease") {
		t.Fatalf("sweep did not report a held shared worktree lease: %+v", report.Actions)
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("shared lease holder worktree was removed: %v", err)
	}
}

// case: S-276.2
func TestWorktreeCleanTreatsIgnoredUserFileAsDirty(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "ignored-work")
	gitTest(t, integration, "worktree", "add", "-b", "agent/ignored-work", worktree, "HEAD")
	addGitIgnoreFixture(t, integration, "ignored-local.txt")
	if err := os.WriteFile(filepath.Join(worktree, "ignored-local.txt"), []byte("user config"), 0o600); err != nil {
		t.Fatal(err)
	}
	clean, err := worktreeClean(worktree)
	if err != nil || clean {
		t.Fatalf("ignored user file was treated as clean: clean=%t err=%v", clean, err)
	}
}

// case: S-276.2
func TestAbandonedArchivePreservesIgnoredFilesAndAgentReport(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "ignored-dirty")
	gitTest(t, integration, "worktree", "add", "-b", "agent/ignored-dirty", worktree, "HEAD")
	addGitIgnoreFixture(t, integration, "ignored-local.txt", ".agent-report.md")
	for name, content := range map[string]string{"ignored-local.txt": "user config", ".agent-report.md": "agent report"} {
		if err := os.WriteFile(filepath.Join(worktree, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := archiveAbandoned(root, worktree, "ignored-dirty"); err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "reports", "abandoned", "ignored-dirty")
	report, err := os.ReadFile(filepath.Join(archiveDir, "agent-report.md"))
	if err != nil || string(report) != "agent report" {
		t.Fatalf("agent report copy = %q, err=%v", report, err)
	}
	listing, err := os.ReadFile(filepath.Join(archiveDir, "untracked.list"))
	if err != nil || !strings.Contains(string(listing), "ignored-local.txt") {
		t.Fatalf("ignored file missing from untracked manifest: %q, err=%v", listing, err)
	}
	assertTarContains(t, filepath.Join(archiveDir, "untracked.tgz"), "ignored-local.txt")
}

// case: S-276.1
func TestHygieneLiveProcessCwdKeepsWorktree(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "x-live")
	gitTest(t, integration, "worktree", "add", "-b", "agent/x-live", worktree, "HEAD")
	child := exec.Command("sleep", "60")
	child.Dir = worktree
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := child.Process.Kill(); err != nil {
			t.Logf("stop fixture process: %v", err)
		}
		if err := child.Wait(); err != nil {
			t.Logf("reap fixture process: %v", err)
		}
	})
	_, err := runHygieneSweep(hygieneOptions{Root: root, State: filepath.Join(root, "logs", "runner"), Integration: integration, WorktreeOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("live process worktree was removed: %v", err)
	}
}

// case: S-276.6
func TestHygieneRefusesForeignWorktreeAndLogsCause(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	foreignRoot := t.TempDir()
	foreign := filepath.Join(foreignRoot, "agent-foreign")
	gitTest(t, integration, "worktree", "add", "-b", "agent/foreign", foreign, "HEAD")
	state := filepath.Join(root, "logs", "runner")
	if _, err := runHygieneSweep(hygieneOptions{Root: root, State: state, Integration: integration, WorktreeOnly: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatalf("foreign worktree was changed: %v", err)
	}
	events, err := os.ReadFile(filepath.Join(root, "logs", "events.log"))
	if err != nil || !strings.Contains(string(events), "outside the orchestration root") {
		t.Fatalf("foreign refusal was not logged: %s, %v", events, err)
	}
}

func TestRunnerOwnsGoCacheOnlyWhenItIsInTheConfiguredRoot(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "cache")
	if err := os.Mkdir(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	owned, err := runnerOwnsGoCache(root, inside)
	if err != nil || !owned {
		t.Fatalf("cache inside orchestration root was not owned: owned=%v err=%v", owned, err)
	}
	external := t.TempDir()
	t.Setenv("GOCACHE", external)
	t.Setenv("KBLABS_WORKTREES_ROOT", "")
	owned, err = runnerOwnsGoCache(root, external)
	if err != nil || owned {
		t.Fatalf("unconfigured external cache was treated as owned: owned=%v err=%v", owned, err)
	}
	t.Setenv("KBLABS_WORKTREES_ROOT", root)
	owned, err = runnerOwnsGoCache(root, external)
	if err != nil || !owned {
		t.Fatalf("configured Go cache was not owned: owned=%v err=%v", owned, err)
	}
}

// case: S-276.4
func TestHygieneSkipsExternalGoCacheWithoutMeasuringIt(t *testing.T) {
	root := t.TempDir()
	cache := t.TempDir()
	if err := os.WriteFile(filepath.Join(cache, "entry"), []byte("shared cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	report := hygieneReport{Actions: []hygieneAction{}, eventRoot: root}
	if err := sweepGoCache(hygieneOptions{Root: root, State: filepath.Join(root, "logs", "runner"), Cache: cache, CacheBudget: 1}, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Actions) != 1 || report.Actions[0].Action != "skipped" || report.Actions[0].ObservedBytes != 0 {
		t.Fatalf("external cache was measured before ownership refusal: %+v", report.Actions)
	}
}

// case: S-276.4
func TestHygieneSkipsGoCacheWhenGoTestCostKeyIsHeld(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	state := filepath.Join(root, "logs", "runner")
	cache := filepath.Join(root, "go-cache")
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "entry"), []byte("cache data"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := buildRunnerBinary(t)
	command := exec.Command(runner, "run", "--tag", "go-test-holder", "--state", state, "--stall", "1m", "--stdout", filepath.Join(state, "holder.out"), "--stderr", filepath.Join(state, "holder.err"), "--cost", "heavy", "--cost-key", "go-test", "--", "/bin/sleep", "60")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			if err := command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Logf("stop go-test cost-key holder: %v", err)
			}
			if err := command.Wait(); err != nil {
				t.Logf("reap go-test cost-key holder: %v", err)
			}
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		if hasCostKeyRun(state, "go-test-holder", "go-test") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner did not register the go-test cost-key holder")
		}
		time.Sleep(10 * time.Millisecond)
	}
	report, err := runHygieneSweep(hygieneOptions{Root: root, State: state, Integration: integration, Cache: cache, CacheBudget: 1, Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if !hasHygieneActionWithCause(report, "go-cache", "skipped", "go-test cost-key slot is held by another run") {
		t.Fatalf("go-test holder was not reported: %+v", report.Actions)
	}
	if _, err := os.Stat(filepath.Join(cache, "entry")); err != nil {
		t.Fatalf("busy cache was changed: %v", err)
	}
}

// case: S-276.6
func TestHygieneDryRunPreservesEligibleWorktreeAndReportsPlan(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "x-clean")
	gitTest(t, integration, "worktree", "add", "-b", "agent/x-clean", worktree, "HEAD")
	state := filepath.Join(root, "logs", "runner")
	var stdout, stderr bytes.Buffer
	code, err := hygieneCommand(runnerRoot{invocation: "kb-runner"}, []string{"sweep", "--root", root, "--integration-tree", integration, "--state", state, "--dry-run", "--json"}, &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("dry-run command failed: code=%d err=%v stderr=%s", code, err, stderr.String())
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("dry-run removed worktree: %v", err)
	}
	var report hygieneReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil || len(report.Actions) == 0 || report.Actions[0].Rule != "worktree" {
		t.Fatalf("JSON plan omitted worktree action: %s, %v", stdout.String(), err)
	}
}

// case: S-276.3
func TestHygieneSweepCommandPrintsDryRunPlanForFixture(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	state := filepath.Join(root, "logs", "runner-zcode")
	cache := filepath.Join(root, "go-cache")
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "small"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(state, "jobs", "orphaned", "tmp")
	if err := os.MkdirAll(temp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(temp, "cache.bin"), []byte("temporary bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := buildRunnerBinary(t)
	t.Setenv("GOCACHE", cache)
	command := exec.Command(runner, "hygiene", "sweep", "--root", root, "--integration-tree", integration, "--state", state, "--dry-run", "--json")
	stdout, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture dry-run command failed: %v output=%s", err, stdout)
	}
	var report hygieneReport
	if err := json.Unmarshal(stdout, &report); err != nil {
		t.Fatalf("decode dry-run JSON %q: %v", stdout, err)
	}
	if len(report.Actions) != 1 || report.Actions[0].Rule != "job-temp" || report.Actions[0].Bytes != uint64(len("temporary bytes")) {
		t.Fatalf("unexpected dry-run plan: %+v", report)
	}
	if _, err := os.Stat(temp); err != nil {
		t.Fatalf("dry-run changed fixture: %v", err)
	}
}

// case: S-276.2
func TestHygieneDirtyRetiredWorktreeArchivesBeforeRemoval(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "x-dirty")
	gitTest(t, integration, "worktree", "add", "-b", "agent/x-dirty", worktree, "HEAD")
	if err := os.WriteFile(filepath.Join(worktree, "tracked.txt"), []byte("modified\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "loose.txt"), []byte("untracked\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "logs", "runner")
	store := newSchedulerStore(state)
	if err := store.writeJSON(store.streamPath("x-dirty"), SchedulerStream{Stream: "x-dirty", State: SchedulerDone, ChangedAt: time.Now().Add(-72 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	report, err := runHygieneSweep(hygieneOptions{Root: root, State: state, Integration: integration, Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Fatalf("dirty retired worktree still exists: %v; hygiene actions=%+v", err, report.Actions)
	}
	archive := filepath.Join(root, "reports", "abandoned", "x-dirty")
	for _, name := range []string{"tracked.diff", "untracked.list", "untracked.tgz", "head"} {
		if _, err := os.Stat(filepath.Join(archive, name)); err != nil {
			t.Fatalf("archive missing %s: %v", name, err)
		}
	}
	assertTarReadable(t, filepath.Join(archive, "untracked.tgz"))
}

// case: S-276.6
func TestUnreadableRelativeArgvStillArchivesDirtyRetiredWorktree(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "x-unreadable-cwd")
	gitTest(t, integration, "worktree", "add", "-b", "agent/x-unreadable-cwd", worktree, "HEAD")
	if err := os.WriteFile(filepath.Join(worktree, "tracked.txt"), []byte("modified\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "loose.txt"), []byte("untracked\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "logs", "runner")
	store := newSchedulerStore(state)
	stream := SchedulerStream{Stream: "x-unreadable-cwd", State: SchedulerDone, ChangedAt: time.Now().Add(-72 * time.Hour)}
	if err := store.writeJSON(store.streamPath(stream.Stream), stream); err != nil {
		t.Fatal(err)
	}
	snapshot := processSnapshotFromEntries([]proc.ProcessInventoryEntry{{
		PID: 45, UID: uint32(os.Getuid()), Identity: "process-start", Command: "go test",
		Argv: []string{"go", "test", "./..."}, CwdError: "permission denied",
	}}, uint32(os.Getuid()))
	report := hygieneReport{Actions: []hygieneAction{}, eventRoot: root}
	candidate := ownedWorktree{gitWorktree: gitWorktree{Path: worktree, Branch: "agent/x-unreadable-cwd"}, ResolvedPath: worktree}
	if err := sweepWorktreeCandidate(hygieneOptions{Root: root, State: state, Integration: integration, Now: time.Now()}, root, integration, candidate, map[string]SchedulerStream{stream.Stream: stream}, nil, snapshot, &report); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Fatalf("dirty retired worktree with unreadable relative-argv process still exists: %v; actions=%+v", err, report.Actions)
	}
	archive := filepath.Join(root, "reports", "abandoned", stream.Stream)
	for _, name := range []string{"tracked.diff", "untracked.list", "untracked.tgz", "head"} {
		if _, err := os.Stat(filepath.Join(archive, name)); err != nil {
			t.Fatalf("unreadable-process path archive missing %s: %v", name, err)
		}
	}
	diff, err := os.ReadFile(filepath.Join(archive, "tracked.diff"))
	if err != nil || !strings.Contains(string(diff), "modified") {
		t.Fatalf("unreadable-process archive tracked diff lacks the edit: %s, %v", diff, err)
	}
	listing, err := os.ReadFile(filepath.Join(archive, "untracked.list"))
	if err != nil || !strings.Contains(string(listing), "loose.txt") {
		t.Fatalf("unreadable-process archive manifest lacks loose.txt: %s, %v", listing, err)
	}
	assertTarFileContent(t, filepath.Join(archive, "untracked.tgz"), "loose.txt", "untracked\n")
}

// case: S-276.2
func TestHygieneDirtyWorktreeIsArchivedBeforeRemoval(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "x-dirty")
	gitTest(t, integration, "worktree", "add", "-b", "agent/x-dirty", worktree, "HEAD")
	if err := os.WriteFile(filepath.Join(worktree, "tracked.txt"), []byte("modified\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "loose.txt"), []byte("untracked\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := archiveAndRemoveWorktree(&hygieneReport{eventRoot: root}, integration, worktree, "x-dirty"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Fatalf("dirty worktree was not removed after archive: %v", err)
	}
	archive := filepath.Join(root, "reports", "abandoned", "x-dirty")
	diff, err := os.ReadFile(filepath.Join(archive, "tracked.diff"))
	if err != nil || !strings.Contains(string(diff), "modified") {
		t.Fatalf("tracked diff is missing edit: %s, %v", diff, err)
	}
	listing, err := os.ReadFile(filepath.Join(archive, "untracked.list"))
	if err != nil || !strings.Contains(string(listing), "loose.txt") {
		t.Fatalf("untracked manifest is missing path: %s, %v", listing, err)
	}
	assertTarReadable(t, filepath.Join(archive, "untracked.tgz"))
}

// case: S-276.3, S-276.5
func TestHygieneSweepReapsFinishedJobTempAndArchivesOldArtifacts(t *testing.T) {
	root, _ := hygieneGitFixture(t)
	state := filepath.Join(root, "logs", "runner-zcode")
	jobID := "finished-job"
	jobTemp := filepath.Join(state, "jobs", jobID, "tmp")
	if err := os.MkdirAll(jobTemp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(jobTemp, "cache"), []byte("junk"), 0o600); err != nil {
		t.Fatal(err)
	}
	job := Job{ID: jobID, State: JobOK, UpdatedAt: time.Now()}
	if err := newJobStore(state).write(job); err != nil {
		t.Fatal(err)
	}
	batch := filepath.Join(root, "reports", "j-old-local")
	for _, name := range []string{"j-old-local", "j-old-shared", "j-older-local", "j-oldest-shared"} {
		path := filepath.Join(root, "reports", name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "result.json"), []byte("result"), 0o600); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-96 * time.Hour)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	report, err := runHygieneSweep(hygieneOptions{Root: root, State: state, Integration: filepath.Join(root, "integration"), Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(jobTemp); !os.IsNotExist(err) {
		t.Fatalf("finished job temp remains: %v", err)
	}
	if _, err := os.Stat(batch); !os.IsNotExist(err) {
		t.Fatalf("archived batch directory remains: %v", err)
	}
	assertTarReadable(t, batch+".tar.gz")
	if len(report.Actions) == 0 || report.Bytes == 0 {
		t.Fatalf("sweep omitted reclaim actions/bytes: %+v", report)
	}
	events, err := os.ReadFile(filepath.Join(root, "logs", "events.log"))
	if err != nil || !strings.Contains(string(events), "HYGIENE reaped") || !strings.Contains(string(events), "HYGIENE compressed") {
		t.Fatalf("sweep reclaim events missing byte records: %s, %v", events, err)
	}
	var tempIntent hygieneJournalRecord
	for _, line := range strings.Split(string(events), "\n") {
		payload, ok := strings.CutPrefix(line, "HYGIENE_JOURNAL ")
		if !ok {
			continue
		}
		var record hygieneJournalRecord
		if err := json.Unmarshal([]byte(payload), &record); err != nil {
			t.Fatal(err)
		}
		if record.Kind == "intent" && record.Rule == "job-temp" {
			tempIntent = record
			break
		}
	}
	if tempIntent.Bytes != uint64(len("junk")) {
		t.Fatalf("normal job-temp intent bytes = %d, want %d", tempIntent.Bytes, len("junk"))
	}
	assertRecoveredReclaimEvent(t, root, tempIntent.ID, jobTemp, tempIntent.Bytes)
}

// case: S-276.5
func TestBatchArchiveRestoresSymlinkEmptyDirectoryAndBinaryFile(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "report")
	if err := os.MkdirAll(filepath.Join(source, "empty"), 0o751); err != nil {
		t.Fatal(err)
	}
	binary := []byte{0, 1, 2, 255, 128, 0}
	if err := os.WriteFile(filepath.Join(source, "payload.bin"), binary, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "target.txt"), []byte("target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.txt", filepath.Join(source, "link")); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "report.tar.gz")
	if err := createTarGz(context.Background(), source, archive); err != nil {
		t.Fatal(err)
	}
	if err := verifyTarGz(source, archive); err != nil {
		t.Fatalf("archive did not round trip: %v", err)
	}
}

// case: S-276.3
func TestHygieneFailureAlertsAndContinuesToLaterItemsAndRules(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	state := filepath.Join(root, "logs", "runner")
	invalid := filepath.Join(state, "jobs", " ", "tmp")
	if err := os.MkdirAll(invalid, 0o700); err != nil {
		t.Fatal(err)
	}
	valid := filepath.Join(state, "jobs", "finished", "tmp")
	if err := os.MkdirAll(valid, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(valid, "data"), []byte("temporary"), 0o600); err != nil {
		t.Fatal(err)
	}
	var artifact string
	for index, name := range []string{"j-old-local", "j-newest-a-local", "j-newest-b-local", "j-newest-c-shared"} {
		old := time.Now().Add(time.Duration(-96+index) * time.Hour)
		path := filepath.Join(root, "reports", name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "data"), []byte("batch"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
		if name == "j-old-local" {
			artifact = path
		}
	}
	report, err := runHygieneSweep(hygieneOptions{Root: root, State: state, Integration: integration, Now: time.Now()})
	if err != nil {
		t.Fatalf("one failed item stopped the sweep: %v", err)
	}
	if _, err := os.Stat(valid); !os.IsNotExist(err) {
		t.Fatalf("later finished-job temp was not reaped: %v", err)
	}
	if _, err := os.Stat(artifact); !os.IsNotExist(err) {
		t.Fatalf("later batch artifact was not compressed: %v", err)
	}
	if !hasHygieneAction(report, "job-temp", "alert") || !hasHygieneAction(report, "job-temp", "reaped") || !hasHygieneAction(report, "batch-artifact", "compressed") {
		t.Fatalf("sweep omitted alert or later action: %+v", report.Actions)
	}
}

// case: S-276.7
func TestHygieneBatchSourceRemainsWhenJournalCannotPersistIntent(t *testing.T) {
	root := t.TempDir()
	reports := filepath.Join(root, "reports")
	if err := os.MkdirAll(reports, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for index, name := range []string{"j-old-local", "j-newest-a-local", "j-newest-b-local", "j-newest-c-shared"} {
		path := filepath.Join(reports, name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "data"), []byte("batch data"), 0o600); err != nil {
			t.Fatal(err)
		}
		modified := now.Add(-96*time.Hour + time.Duration(index)*time.Hour)
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "logs", "events.log"), 0o700); err != nil {
		t.Fatal(err)
	}
	oldBatch := filepath.Join(reports, "j-old-local")
	if err := sweepBatchArtifacts(hygieneOptions{Root: root, Now: now}, &hygieneReport{eventRoot: root}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldBatch); err != nil {
		t.Fatalf("batch source was removed without a durable intent: %v", err)
	}
}

// case: S-276.7
func TestHygieneBatchJournalRecordsIntentBeforeCompletion(t *testing.T) {
	root := t.TempDir()
	reports := filepath.Join(root, "reports")
	if err := os.MkdirAll(reports, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for index, name := range []string{"j-old-local", "j-newest-a-local", "j-newest-b-local", "j-newest-c-shared"} {
		path := filepath.Join(reports, name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "data"), []byte("batch data"), 0o600); err != nil {
			t.Fatal(err)
		}
		modified := now.Add(-96*time.Hour + time.Duration(index)*time.Hour)
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	if err := sweepBatchArtifacts(hygieneOptions{Root: root, Now: now}, &hygieneReport{eventRoot: root}); err != nil {
		t.Fatal(err)
	}
	journal, err := os.ReadFile(filepath.Join(root, "logs", "events.log"))
	if err != nil {
		t.Fatal(err)
	}
	intent := bytes.Index(journal, []byte(`"kind":"intent"`))
	completion := bytes.Index(journal, []byte(`"kind":"complete"`))
	if intent < 0 || completion < 0 || intent >= completion || !bytes.Contains(journal[intent:completion], []byte(`"archivePath"`)) || !bytes.Contains(journal[intent:completion], []byte(`"archiveSHA256"`)) {
		t.Fatalf("batch reclaim journal lacks ordered durable intent/completion with archive identity: %s", journal)
	}
}

// case: S-276.7
func TestHygieneJournalReconcilesIncompleteIntents(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "reports", "restored.tar.gz")
	if err := os.MkdirAll(filepath.Dir(archive), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archive, []byte("verified archive bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	hash, err := fileSHA256(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := appendHygieneJournal(root, hygieneJournalRecord{Kind: "intent", ID: "recovered", Rule: "batch-artifact", Path: filepath.Join(root, "reports", "removed-source"), Reason: "test recovery", Action: "compressed", Bytes: 21, Archive: archive, ArchiveSHA: hash}); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "reports", "still-present")
	if err := os.WriteFile(source, []byte("preserved source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := appendHygieneJournal(root, hygieneJournalRecord{Kind: "intent", ID: "retry", Rule: "batch-artifact", Path: source, Reason: "test retry", Action: "compressed", Bytes: 14}); err != nil {
		t.Fatal(err)
	}
	if err := reconcileHygieneJournal(root); err != nil {
		t.Fatal(err)
	}
	journal, err := os.ReadFile(filepath.Join(root, "logs", "events.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(journal, []byte(`"kind":"complete","id":"recovered"`)) || !bytes.Contains(journal, []byte(`"kind":"skip","id":"retry"`)) {
		t.Fatalf("incomplete journal intents were not safely reconciled: %s", journal)
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatalf("reconciliation removed a source whose intent was not complete: %v", err)
	}
}

// case: S-276.7
func TestHygieneJournalRecoveryRecordsReclaimBytesExactlyOnce(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "jobs", "terminal", "temp")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	const contents = "1234567890123456789"
	if err := os.WriteFile(filepath.Join(source, "payload"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	freedBytes, err := treeBytes(source)
	if err != nil {
		t.Fatal(err)
	}
	if freedBytes != uint64(len(contents)) {
		t.Fatalf("fixture bytes = %d, want %d", freedBytes, len(contents))
	}
	intentAction := hygieneAction{Rule: "job-temp", Path: source, Action: "reaped", Bytes: freedBytes, Cause: "terminal job temporary directory"}
	intent, err := beginHygieneReclaim(&hygieneReport{eventRoot: root}, intentAction, "", "")
	if err != nil {
		t.Fatal(err)
	}
	journal, err := os.ReadFile(filepath.Join(root, "logs", "events.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(journal, []byte(`"bytesFreed":19`)) {
		t.Fatalf("durable reclaim intent omitted expected bytes: %s", journal)
	}
	// Model interruption after source removal but before the reclaim event/completion append.
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	if err := reconcileHygieneJournal(root); err != nil {
		t.Fatal(err)
	}
	assertRecoveredReclaimEvent(t, root, intent.ID, source, freedBytes)
	if err := reconcileHygieneJournal(root); err != nil {
		t.Fatal(err)
	}
	assertRecoveredReclaimEvent(t, root, intent.ID, source, freedBytes)
}

// case: S-276.7
func TestHygieneJournalRecoveryDeduplicatesEventBeforeCompletion(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "jobs", "terminal", "temp")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	const contents = "1234567890123456789"
	if err := os.WriteFile(filepath.Join(source, "payload"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	action := hygieneAction{Rule: "job-temp", Path: source, Action: "reaped", Bytes: uint64(len(contents)), Cause: "terminal job temporary directory"}
	intent, err := beginHygieneReclaim(&hygieneReport{eventRoot: root}, action, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	if err := appendHygieneReclaimEvent(root, intent); err != nil {
		t.Fatal(err)
	}
	if err := reconcileHygieneJournal(root); err != nil {
		t.Fatal(err)
	}
	assertRecoveredReclaimEvent(t, root, intent.ID, source, intent.Bytes)
}

func assertRecoveredReclaimEvent(t *testing.T, root, id, source string, bytes uint64) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "logs", "events.log"))
	if err != nil {
		t.Fatal(err)
	}
	reclaimMarker := `reclaim_id="` + id + `"`
	if count := strings.Count(string(data), reclaimMarker); count != 1 {
		t.Fatalf("reclaim event count for %s = %d, want exactly one: %s", id, count, data)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.Contains(line, reclaimMarker) {
			continue
		}
		for _, want := range []string{`HYGIENE reaped`, `path="` + source + `"`, fmt.Sprintf("bytes=%d", bytes)} {
			if !strings.Contains(line, want) {
				t.Fatalf("reclaim event %q lacks %q", line, want)
			}
		}
	}
	completeMarker := `"kind":"complete","id":"` + id + `"`
	if count := strings.Count(string(data), completeMarker); count != 1 {
		t.Fatalf("completion journal count for %s = %d, want exactly one: %s", id, count, data)
	}
}

type controlledSchedulerClock struct {
	mu     sync.Mutex
	now    time.Time
	ticker *controlledSchedulerTicker
}

type controlledSchedulerTicker struct{ ticks chan time.Time }

func (clock *controlledSchedulerClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}
func (clock *controlledSchedulerClock) NewTicker(time.Duration) schedulerTicker {
	clock.ticker = &controlledSchedulerTicker{ticks: make(chan time.Time, 4)}
	return clock.ticker
}
func (ticker *controlledSchedulerTicker) C() <-chan time.Time { return ticker.ticks }
func (ticker *controlledSchedulerTicker) Stop()               {}
func (clock *controlledSchedulerClock) Advance(d time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(d)
	now := clock.now
	clock.mu.Unlock()
	clock.ticker.ticks <- now
}

// case: S-276.3
func TestSchedulerDispatchContinuesAfterStartupHygieneFailure(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	t.Setenv("KBLABS_RUNNER_ORPHAN_AGE", "invalid-duration")
	task := f.addTask(t, "startup-hygiene-alert", "worker")
	startFIFO := filepath.Join(f.home, "startup-agent-started.fifo")
	if err := syscall.Mkfifo(startFIFO, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_AGENT_STARTED_FIFO", startFIFO)
	started := make(chan string, 1)
	go func() {
		file, err := os.Open(startFIFO)
		if err == nil {
			defer file.Close()
			scanner := bufio.NewScanner(file)
			if scanner.Scan() {
				started <- scanner.Text()
			}
		}
	}()
	logPath := filepath.Join(task.WorktreeRoot, "logs", "events.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		t.Fatal(err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(logFile.Fd()), syscall.LOCK_EX); err != nil {
		_ = logFile.Close()
		t.Fatal(err)
	}
	logLocked := true
	t.Cleanup(func() {
		if logLocked {
			_ = syscall.Flock(int(logFile.Fd()), syscall.LOCK_UN)
			_ = logFile.Close()
		}
	})
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: f.state, supervisor: f.supervisor, slots: 1})
	result := make(chan struct {
		code int
		err  error
	}, 1)
	go func() {
		code, err := options.run(t.Context(), true)
		result <- struct {
			code int
			err  error
		}{code, err}
	}()
	select {
	case stream := <-started:
		if stream != task.Stream {
			t.Fatalf("startup dispatch stream = %q, want %q", stream, task.Stream)
		}
	case <-time.After(10 * time.Second):
		_ = syscall.Flock(int(logFile.Fd()), syscall.LOCK_UN)
		_ = logFile.Close()
		logLocked = false
		select {
		case <-result:
		case <-time.After(10 * time.Second):
			t.Fatal("synchronous startup sweep did not finish after journal unlock")
		}
		t.Fatal("scheduler did not dispatch while startup hygiene was blocked on journal persistence")
	}
	if err := syscall.Flock(int(logFile.Fd()), syscall.LOCK_UN); err != nil {
		_ = logFile.Close()
		t.Fatal(err)
	}
	logLocked = false
	if err := logFile.Close(); err != nil {
		t.Fatal(err)
	}
	completed := <-result
	code, err := completed.code, completed.err
	if code != 0 || err != nil {
		t.Fatalf("scheduler stopped after startup hygiene alert: code=%d err=%v", code, err)
	}
	events, err := os.ReadFile(filepath.Join(task.WorktreeRoot, "logs", "events.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(events, []byte("KBLABS_RUNNER_ORPHAN_AGE must be a positive duration")) {
		t.Fatalf("startup hygiene failure was not named in the event log: %s", events)
	}
	calls, err := os.ReadFile(f.launchCalls)
	if err == nil && len(calls) == 0 {
		t.Fatal("queued work was not dispatched after startup hygiene failure")
	}
}

// case: S-276.3
func TestSchedulerDispatchesWhileScheduledHygieneIsSlow(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	first := f.addTask(t, "slow-hygiene-one", "worker")
	startedFIFO := filepath.Join(f.home, "agent-started.fifo")
	releaseFIFO := filepath.Join(f.home, "agent-release.fifo")
	for _, path := range []string{startedFIFO, releaseFIFO} {
		if err := syscall.Mkfifo(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	started := make(chan *os.File, 1)
	go func() {
		file, err := os.Open(startedFIFO)
		if err == nil {
			started <- file
		}
	}()
	t.Setenv("FAKE_AGENT_STARTED_FIFO", startedFIFO)
	t.Setenv("FAKE_AGENT_RELEASE_FIFO", releaseFIFO)
	t.Setenv("FAKE_AGENT_BLOCK_STREAM", first.Stream)
	clock := &controlledSchedulerClock{now: time.Now()}
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: f.state, supervisor: f.supervisor, slots: 2, clock: clock})
	ctx, cancel := context.WithCancel(t.Context())
	var eventsFile *os.File
	var workerRelease *os.File
	var err error
	runDone := make(chan struct {
		code int
		err  error
	}, 1)
	runStarted := false
	startedReaderUsed := false
	t.Cleanup(func() {
		cancel()
		if eventsFile != nil {
			_ = syscall.Flock(int(eventsFile.Fd()), syscall.LOCK_UN)
			_ = eventsFile.Close()
		}
		if workerRelease != nil {
			_, _ = workerRelease.WriteString("release\n")
			_ = workerRelease.Close()
		}
		if !startedReaderUsed {
			select {
			case file := <-started:
				_ = file.Close()
			default:
				writer, openErr := os.OpenFile(startedFIFO, os.O_WRONLY, 0)
				if openErr == nil {
					_, _ = writer.WriteString("cleanup\n")
					_ = writer.Close()
					select {
					case file := <-started:
						_ = file.Close()
					case <-time.After(15 * time.Second):
						t.Errorf("started-FIFO reader did not stop during cleanup")
					}
				}
			}
		}
		if runStarted {
			select {
			case <-runDone:
			case <-time.After(15 * time.Second):
				t.Errorf("scheduler run goroutine did not stop during cleanup")
			}
		}
	})
	runStarted = true
	go func() {
		code, err := options.run(ctx, false)
		runDone <- struct {
			code int
			err  error
		}{code, err}
	}()
	select {
	case file := <-started:
		startedReaderUsed = true
		scanner := bufio.NewScanner(file)
		if !scanner.Scan() || scanner.Text() != first.Stream {
			_ = file.Close()
			cancel()
			t.Fatalf("first task start notification = %q, err=%v", scanner.Text(), scanner.Err())
		}
		_ = file.Close()
		workerRelease, err = os.OpenFile(releaseFIFO, os.O_WRONLY, 0)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("first task did not start")
	}
	if err := waitForHygieneEvent(filepath.Join(first.WorktreeRoot, "logs", "events.log"), "HYGIENE completed"); err != nil {
		cancel()
		t.Fatal(err)
	}
	eventsFile, err = os.OpenFile(filepath.Join(first.WorktreeRoot, "logs", "events.log"), os.O_RDWR, 0)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := syscall.Flock(int(eventsFile.Fd()), syscall.LOCK_EX); err != nil {
		_ = eventsFile.Close()
		cancel()
		t.Fatal(err)
	}
	second := f.addTask(t, "slow-hygiene-two", "worker")
	clock.Advance(2 * time.Hour)
	leasePath := hygieneLeasePath(f.state)
	if !waitForHygieneLeaseBusy(t, leasePath) {
		_ = syscall.Flock(int(eventsFile.Fd()), syscall.LOCK_UN)
		_ = eventsFile.Close()
		cancel()
		t.Fatal("scheduled hygiene did not acquire its dedicated lease")
	}
	secondStarted := make(chan string, 1)
	go func() {
		file, err := os.Open(startedFIFO)
		if err == nil {
			defer file.Close()
			scanner := bufio.NewScanner(file)
			if scanner.Scan() {
				secondStarted <- scanner.Text()
			}
		}
	}()
	select {
	case stream := <-secondStarted:
		if stream != second.Stream {
			cancel()
			t.Fatalf("dispatched stream %q while expected %q", stream, second.Stream)
		}
		lease, acquired, err := proc.AcquireFileLease(leasePath, proc.LeaseExclusiveTry)
		if err != nil || acquired {
			if acquired {
				_ = lease.Close()
			}
			cancel()
			t.Fatalf("scheduled sweep did not remain active during queued dispatch: acquired=%t err=%v", acquired, err)
		}
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("queued task did not dispatch while hygiene was blocked on its journal")
	}
	if err := syscall.Flock(int(eventsFile.Fd()), syscall.LOCK_UN); err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := eventsFile.Close(); err != nil {
		cancel()
		t.Fatal(err)
	}
	_, _ = workerRelease.WriteString("release\n")
	_ = workerRelease.Close()
	workerRelease = nil
	cancel()
	select {
	case <-runDone:
		runStarted = false
	case <-time.After(15 * time.Second):
		t.Fatal("scheduler did not stop after cancellation")
	}
}

func waitForHygieneLeaseBusy(t *testing.T, path string) bool {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		lease, acquired, err := proc.AcquireFileLease(path, proc.LeaseExclusiveTry)
		if err != nil {
			t.Fatalf("probe scheduled hygiene lease: %v", err)
		}
		if !acquired {
			return true
		}
		_ = lease.Close()
		runtime.Gosched()
	}
	return false
}

func waitForHygieneEvent(path, event string) error {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil && bytes.Contains(data, []byte(event)) {
			return nil
		}
		runtime.Gosched()
	}
	return fmt.Errorf("event %q did not appear in %s", event, path)
}

// case: S-276.3
func TestSchedulerCompleteDoesNotAcquireSchedulerRunLease(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "complete-hygiene", "worker")
	root := filepath.Join(t.TempDir(), "missing-root")
	task.RepoRoot = f.repo
	task.WorktreeRoot = root
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(f.repo, "tools", "kb-runner", "scheduler-policy.json")
	if err := os.MkdirAll(filepath.Dir(policyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policyPath, []byte(`{"integration_branch":"agent/integration","risk_zones":["tools/kb-runner/**"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.writeJSON(store.streamPath(task.Stream), SchedulerStream{Stream: task.Stream, TaskID: task.ID, State: SchedulerAwaitingOrchestrator}); err != nil {
		t.Fatal(err)
	}
	runLease, err := store.acquireRunLease()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := releaseRunLease(runLease); err != nil {
			t.Errorf("release fixture scheduler run lease: %v", err)
		}
	}()
	var output bytes.Buffer
	code, err := schedulerCompleteCommand(runnerRoot{invocation: "kb-runner"}, []string{"--state", f.state, task.Stream}, &output)
	if err != nil || code != 0 || !strings.Contains(output.String(), "completed stream "+task.Stream) {
		t.Fatalf("completion under active scheduler lease: code=%d output=%q err=%v", code, output.String(), err)
	}
	completed, err := store.stream(task.Stream)
	if err != nil || completed.State != SchedulerDone {
		t.Fatalf("stream completion state = %+v, err=%v", completed, err)
	}
	if err := waitForHygieneEvent(filepath.Join(root, "logs", "events.log"), "HYGIENE completed"); err != nil {
		t.Fatal(err)
	}
}

func hygieneGitFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	integration := filepath.Join(root, "integration")
	if err := os.MkdirAll(integration, 0o700); err != nil {
		t.Fatal(err)
	}
	gitTest(t, integration, "init", "-b", "agent/integration")
	gitTest(t, integration, "config", "user.email", "runner@example.test")
	gitTest(t, integration, "config", "user.name", "Runner Test")
	if err := os.WriteFile(filepath.Join(integration, "tracked.txt"), []byte("original\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, integration, "add", "tracked.txt")
	gitTest(t, integration, "commit", "-m", "initial")
	return root, integration
}

func addGitIgnoreFixture(t *testing.T, integration string, names ...string) {
	t.Helper()
	output, err := exec.Command("git", "-C", integration, "rev-parse", "--git-path", "info/exclude").Output()
	if err != nil {
		t.Fatalf("resolve Git exclude file: %v", err)
	}
	exclude := strings.TrimSpace(string(output))
	if !filepath.IsAbs(exclude) {
		exclude = filepath.Join(integration, exclude)
	}
	if err := os.MkdirAll(filepath.Dir(exclude), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(exclude, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if _, err := fmt.Fprintln(file, name); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertTarContains(t *testing.T, archivePath, want string) {
	t.Helper()
	file, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	compressed, err := gzip.NewReader(file)
	if err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	reader := tar.NewReader(compressed)
	found := false
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == want {
			found = true
		}
	}
	if err := errors.Join(compressed.Close(), file.Close()); err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatalf("archive %s does not contain %s", archivePath, want)
	}
}

func hasHygieneAction(report hygieneReport, rule, action string) bool {
	for _, item := range report.Actions {
		if item.Rule == rule && item.Action == action {
			return true
		}
	}
	return false
}

func hasHygieneActionWithCause(report hygieneReport, rule, action, cause string) bool {
	for _, item := range report.Actions {
		if item.Rule == rule && item.Action == action && item.Cause == cause {
			return true
		}
	}
	return false
}

func hasCostKeyRun(state, tag, key string) bool {
	paths, err := filepath.Glob(filepath.Join(state, "runs", "*.json"))
	if err != nil {
		return false
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var record struct {
			Tag     string `json:"tag"`
			CostKey string `json:"cost_key"`
		}
		if err := json.Unmarshal(data, &record); err == nil && record.Tag == tag && record.CostKey == key {
			return true
		}
	}
	return false
}

func gitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func assertTarReadable(t *testing.T, archive string) {
	t.Helper()
	file, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	if _, err := tar.NewReader(gz).Next(); err != nil {
		t.Fatalf("archive is not readable: %v", err)
	}
}

func assertTarFileContent(t *testing.T, archive, name, want string) {
	t.Helper()
	file, err := os.Open(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("read archive entry: %v", err)
		}
		if filepath.Base(header.Name) == name {
			contents, err := io.ReadAll(reader)
			if err != nil {
				t.Fatalf("read archived %s: %v", name, err)
			}
			if string(contents) != want {
				t.Fatalf("archived %s = %q, want %q", name, contents, want)
			}
			return
		}
	}
	t.Fatalf("archive %s does not contain %s", archive, name)
}
