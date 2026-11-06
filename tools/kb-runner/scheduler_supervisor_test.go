//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

type fakeSchedulerSupervisor struct {
	mu    sync.Mutex
	runs  map[string]*fakeSchedulerRun
	reads map[string]error
}

type fakeSchedulerRun struct {
	supervisor *fakeSchedulerSupervisor
	key        string
	state      string
	runID      string
	command    *exec.Cmd
	stdout     *os.File
	stderr     *os.File
	stdin      *os.File
	record     proc.RunInfo
	once       sync.Once
	err        error
}

func newFakeSchedulerSupervisor() *fakeSchedulerSupervisor {
	return &fakeSchedulerSupervisor{runs: make(map[string]*fakeSchedulerRun), reads: make(map[string]error)}
}

func schedulerRunKey(state, runID string) string { return filepath.Clean(state) + "\x00" + runID }

func (supervisor *fakeSchedulerSupervisor) Start(ctx context.Context, config proc.Config) (schedulerJobRun, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if config.RunID == "" {
		return nil, errors.New("fake scheduler supervisor requires the journaled run ID")
	}
	if len(config.Command) == 0 {
		return nil, errors.New("fake scheduler supervisor requires a command")
	}
	key := schedulerRunKey(config.StateDir, config.RunID)
	if existing, err := proc.ReadRunRecord(config.StateDir, config.RunID); err == nil {
		return nil, fmt.Errorf("fake scheduler supervisor already has durable run %s with status %s", config.RunID, existing.Status)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect durable run %s before fake start: %w", config.RunID, err)
	}
	supervisor.mu.Lock()
	if _, exists := supervisor.runs[key]; exists {
		supervisor.mu.Unlock()
		return nil, fmt.Errorf("fake scheduler supervisor already owns run %s", config.RunID)
	}
	supervisor.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(config.StdoutPath), 0o700); err != nil {
		return nil, err
	}
	stdout, err := openFakeSchedulerOutput(config.StdoutPath)
	if err != nil {
		return nil, err
	}
	stderr, err := openFakeSchedulerOutput(config.StderrPath)
	if err != nil {
		_ = stdout.Close()
		return nil, err
	}
	command := exec.CommandContext(ctx, config.Command[0], config.Command[1:]...)
	command.Dir = config.Dir
	command.Env = schedulerTestEnvironment(config.Env)
	command.Stdout, command.Stderr = stdout, stderr
	var stdin *os.File
	if config.StdinPath != "" {
		stdin, err = os.Open(config.StdinPath)
		if err != nil {
			_ = stdout.Close()
			_ = stderr.Close()
			return nil, err
		}
		command.Stdin = stdin
	}
	if err := command.Start(); err != nil {
		_ = stdout.Close()
		_ = stderr.Close()
		if stdin != nil {
			_ = stdin.Close()
		}
		return nil, err
	}
	started := time.Now()
	record := proc.RunInfo{RunID: config.RunID, Tag: config.Tag, PID: proc.RecordedKeeperPID(command.Process.Pid), Identity: fmt.Sprintf("fake-run:%s:%d", config.RunID, command.Process.Pid), Status: proc.StatusRunning, Command: append([]string(nil), config.Command...), CostKey: config.CostKey, CostClass: config.CostClass}
	record.StartedAt = &started
	run := &fakeSchedulerRun{supervisor: supervisor, key: key, state: config.StateDir, runID: config.RunID, command: command, stdout: stdout, stderr: stderr, stdin: stdin, record: record}
	supervisor.mu.Lock()
	supervisor.runs[key] = run
	supervisor.mu.Unlock()
	if err := proc.WriteRunRecord(config.StateDir, record); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = closeFakeSchedulerOutput(stdout)
		_ = closeFakeSchedulerOutput(stderr)
		if stdin != nil {
			_ = stdin.Close()
		}
		supervisor.mu.Lock()
		delete(supervisor.runs, key)
		supervisor.mu.Unlock()
		return nil, fmt.Errorf("persist fake scheduler run %s: %w", config.RunID, err)
	}
	return run, nil
}

func openFakeSchedulerOutput(path string) (*os.File, error) {
	if path == "" {
		return nil, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
}

func closeFakeSchedulerOutput(file *os.File) error {
	if file == nil {
		return nil
	}
	return file.Close()
}

func schedulerTestEnvironment(extra []string) []string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	for _, entry := range extra {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			values[key] = value
		}
	}
	env := make([]string, 0, len(values))
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}

func (run *fakeSchedulerRun) Wait() error {
	run.once.Do(func() {
		err := run.command.Wait()
		closeErr := errors.Join(closeFakeSchedulerOutput(run.stdout), closeFakeSchedulerOutput(run.stderr))
		if run.stdin != nil {
			closeErr = errors.Join(closeErr, run.stdin.Close())
		}
		var exitCode int
		status := proc.StatusCompleted
		if err != nil {
			status = proc.StatusFailed
			run.err = err
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
		}
		record, _, recordErr := run.supervisor.RunByIDFromKey(run.key)
		if recordErr == nil {
			record.Status = status
			record.ExitCode = &exitCode
			if err != nil {
				record.Error = err.Error()
			}
			run.supervisor.updateRecord(run.key, record)
			if persistErr := proc.WriteRunRecord(run.state, record); persistErr != nil {
				run.err = errors.Join(run.err, fmt.Errorf("persist fake scheduler job completion: %w", persistErr))
			}
		} else {
			run.err = errors.Join(run.err, recordErr)
		}
		run.err = errors.Join(run.err, closeErr)
	})
	return run.err
}

func (supervisor *fakeSchedulerSupervisor) RunByIDFromKey(key string) (proc.RunInfo, bool, error) {
	supervisor.mu.Lock()
	if err := supervisor.reads[key]; err != nil {
		supervisor.mu.Unlock()
		_, runID, ok := strings.Cut(key, "\x00")
		if !ok {
			return proc.RunInfo{}, false, err
		}
		return proc.RunInfo{}, false, schedulerRunUnknownError{RunID: runID, Cause: err}
	}
	run := supervisor.runs[key]
	supervisor.mu.Unlock()
	if run != nil {
		supervisor.mu.Lock()
		record := run.record
		supervisor.mu.Unlock()
		return record, true, nil
	}
	state, runID, ok := strings.Cut(key, "\x00")
	if !ok {
		return proc.RunInfo{}, false, errors.New("invalid fake scheduler run key")
	}
	record, err := proc.ReadRunRecord(state, runID)
	if errors.Is(err, os.ErrNotExist) {
		return proc.RunInfo{}, false, nil
	}
	if err != nil {
		return proc.RunInfo{}, false, schedulerRunUnknownError{RunID: runID, Cause: err}
	}
	if !record.Status.Terminal() {
		// A fresh fake supervisor has no handle for the previous scheduler's
		// process, so its run identity is explicitly no longer live.
		record.Status = proc.StatusLost
		record.Error = "fake process was not alive after scheduler restart"
		if err := proc.WriteRunRecord(state, record); err != nil {
			return proc.RunInfo{}, false, fmt.Errorf("record fake scheduler run loss: %w", err)
		}
	}
	return record, true, nil
}

func (supervisor *fakeSchedulerSupervisor) updateRecord(key string, record proc.RunInfo) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if run := supervisor.runs[key]; run != nil {
		run.record = record
	}
}

func (supervisor *fakeSchedulerSupervisor) List(state string) proc.Listing {
	listing := proc.Listing{}
	listing.Runs, listing.Error = proc.ListRunRecords(state)
	return listing
}

func (supervisor *fakeSchedulerSupervisor) RunByID(state, runID string) (proc.RunInfo, bool, error) {
	return supervisor.RunByIDFromKey(schedulerRunKey(state, runID))
}

func (supervisor *fakeSchedulerSupervisor) WaitTag(ctx context.Context, state, tag string) (proc.RunInfo, error) {
	supervisor.mu.Lock()
	var run *fakeSchedulerRun
	for key, candidate := range supervisor.runs {
		if strings.HasPrefix(key, filepath.Clean(state)+"\x00") {
			record := candidate.record
			if record.RunID == tag || record.Tag == tag {
				run = candidate
				break
			}
		}
	}
	supervisor.mu.Unlock()
	if run == nil {
		return proc.RunInfo{}, fmt.Errorf("fake scheduler run %s is missing", tag)
	}
	done := make(chan error, 1)
	go func() { done <- run.Wait() }()
	select {
	case err := <-done:
		record, _, recordErr := supervisor.RunByIDFromKey(run.key)
		return record, errors.Join(err, recordErr)
	case <-ctx.Done():
		return proc.RunInfo{}, ctx.Err()
	}
}

func (supervisor *fakeSchedulerSupervisor) RunOwnsProcess(state, runID string, pid int, identity string) (bool, error) {
	record, exists, err := supervisor.RunByID(state, runID)
	if err != nil || !exists {
		return false, err
	}
	return !record.Status.Terminal() && record.PID == proc.RecordedKeeperPID(pid) && record.Identity == identity, nil
}

func (supervisor *fakeSchedulerSupervisor) RunTagActive(state, tag string) (bool, error) {
	listing := supervisor.List(state)
	for _, run := range listing.Runs {
		if run.Tag == tag && !run.Status.Terminal() {
			return true, nil
		}
	}
	return false, nil
}

func (supervisor *fakeSchedulerSupervisor) ReadOutput(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (supervisor *fakeSchedulerSupervisor) SetReadError(state, runID string, err error) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	supervisor.reads[schedulerRunKey(state, runID)] = err
}

type queuedAdmissionSupervisor struct {
	*fakeSchedulerSupervisor
	entered chan struct{}
	release chan struct{}
}

func (supervisor *queuedAdmissionSupervisor) Start(ctx context.Context, config proc.Config) (schedulerJobRun, error) {
	record := proc.RunInfo{RunID: config.RunID, Tag: config.Tag, Status: proc.StatusQueued, WaitReason: "host pressure: memory warn"}
	if err := proc.WriteRunRecord(config.StateDir, record); err != nil {
		return nil, err
	}
	close(supervisor.entered)
	select {
	case <-supervisor.release:
		record.Status = proc.StatusStarting
		record.WaitReason = ""
		if err := proc.WriteRunRecord(config.StateDir, record); err != nil {
			return nil, err
		}
		return completedAdmissionTestRun{}, nil
	case <-ctx.Done():
		record.Status = proc.StatusFailed
		record.WaitReason = ""
		if err := proc.WriteRunRecord(config.StateDir, record); err != nil {
			return nil, err
		}
		return nil, ctx.Err()
	}
}

func (supervisor *queuedAdmissionSupervisor) RunByID(state, runID string) (proc.RunInfo, bool, error) {
	record, err := proc.ReadRunRecord(state, runID)
	if errors.Is(err, os.ErrNotExist) {
		return proc.RunInfo{}, false, nil
	}
	if err == nil && (record.Status == proc.StatusQueued || record.Status == proc.StatusBlocked) {
		record.WaitReason = "host pressure: memory warn"
	}
	return record, err == nil, err
}

type completedAdmissionTestRun struct{}

func (completedAdmissionTestRun) Wait() error { return nil }

// case: S-237.149
func TestSchedulerAdmissionWaitIsProjectedAndCleared(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	task := fixture.addTask(t, "admission-projection", "worker")
	store := newSchedulerStore(fixture.state)
	claimed, ok, err := store.claimForDispatch(task.Stream, task.ID, task.Stream+"-job", "")
	if err != nil || !ok {
		t.Fatalf("claim scheduler worker: claimed=%t err=%v", ok, err)
	}
	supervisor := &queuedAdmissionSupervisor{fakeSchedulerSupervisor: newFakeSchedulerSupervisor(), entered: make(chan struct{}), release: make(chan struct{})}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: fixture.state, root: fixture.invocationRoot(), lifecycle: context.Background(), supervisor: supervisor})
	result := make(chan error, 1)
	go func() {
		run, startErr := options.startSupervisedJob(context.Background(), task.Stream, proc.Config{StateDir: fixture.state, Tag: claimed.RunID, RunID: claimed.RunID, Command: []string{"unused"}}, time.Second)
		if startErr == nil {
			startErr = run.Wait()
		}
		result <- startErr
	}()
	<-supervisor.entered
	deadline := time.After(time.Second)
	for {
		stream, readErr := store.stream(task.Stream)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if stream.WaitingFor == "admission host pressure: memory warn" && stream.NextStep == "wait for process admission" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("scheduler stream did not expose admission wait: %+v", stream)
		case <-time.After(5 * time.Millisecond):
		}
	}
	close(supervisor.release)
	if err := <-result; err != nil {
		t.Fatalf("admitted job start: %v", err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil || stream.WaitingFor != "agent round" || stream.NextStep != "wait for agent report" {
		t.Fatalf("admission completion projection=%+v err=%v; want original running projection", stream, err)
	}
}

// case: S-237.149
func TestSchedulerAdmissionWaitReturnsTypedBoundedOutcome(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	task := fixture.addTask(t, "admission-timeout", "worker")
	store := newSchedulerStore(fixture.state)
	claimed, ok, err := store.claimForDispatch(task.Stream, task.ID, task.Stream+"-job", "")
	if err != nil || !ok {
		t.Fatalf("claim scheduler worker: claimed=%t err=%v", ok, err)
	}
	supervisor := &queuedAdmissionSupervisor{fakeSchedulerSupervisor: newFakeSchedulerSupervisor(), entered: make(chan struct{}), release: make(chan struct{})}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: fixture.state, root: fixture.invocationRoot(), lifecycle: context.Background(), supervisor: supervisor})
	_, err = options.startSupervisedJob(context.Background(), task.Stream, proc.Config{StateDir: fixture.state, Tag: claimed.RunID, RunID: claimed.RunID, Command: []string{"unused"}}, 300*time.Millisecond)
	var timeout schedulerAdmissionTimeoutError
	if !errors.As(err, &timeout) || timeout.RunID != claimed.RunID || !strings.Contains(timeout.Next, "sched ps --state") {
		t.Fatalf("admission error=%v; want typed timeout with the next diagnostic command", err)
	}
	stream, readErr := store.stream(task.Stream)
	if readErr != nil || stream.WaitingFor != "admission host pressure: memory warn" {
		t.Fatalf("timed-out admission projection=%+v err=%v", stream, readErr)
	}
}

// case: S-237.149
func TestSchedulerAdmissionTimeoutEscalatesWithDiagnostic(t *testing.T) {
	fixture := newSchedulerFixture(t, `[]`, `{}`)
	task := fixture.addTask(t, "admission-timeout-outcome", "worker")
	task.OutsideSuites = []string{"kb-runner:./..."}
	task.Review, task.Reviewers = "", nil
	store := newSchedulerStore(fixture.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "agent round", "wait for agent report"); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: fixture.state, root: fixture.invocationRoot()})
	cause := schedulerAdmissionTimeoutError{RunID: "run-admission-timeout", WaitReason: "host pressure: memory warn", Bound: time.Second, Next: "kb-runner sched ps --json"}
	if err := options.finishWorker(schedulerWorkerResult{task: task, jobID: "preallocated-job", err: cause}); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil || stream.State != SchedulerAwaitingOrchestrator || stream.Cause != "admission-timeout" || stream.Advance.State != AdvanceEscalated || !strings.Contains(stream.Advance.Reason, "next: kb-runner sched ps --json") {
		t.Fatalf("admission timeout outcome=%+v err=%v", stream, err)
	}
}
