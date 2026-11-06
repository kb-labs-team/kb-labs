//go:build darwin || linux

package proc_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/kb-runner/internal/proc"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
)

// case: S-237.138
func TestStartWaitsForKeeperReadyHandshake(t *testing.T) {
	state := t.TempDir()
	falseCommand, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatalf("locate sleep command fixture: %v", err)
	}
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "ready-handshake", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{falseCommand, "30"},
	})
	if err != nil {
		t.Fatalf("Start before ready handshake: %v", err)
	}
	cleanupRun(t, run)
	if run.PID <= 0 || run.StartedAt == "" {
		t.Fatalf("ready run identity = pid %d, started_at %q", run.PID, run.StartedAt)
	}
}

// case: S-237.139
func TestStartRejectsNonCancellableContextBeforeSpawning(t *testing.T) {
	state := filepath.Join(t.TempDir(), "unused-state")
	command, err := exec.LookPath("true")
	if err != nil {
		t.Fatal(err)
	}
	run, err := proc.Start(context.Background(), proc.Config{
		StateDir: state, Tag: "non-cancellable-context", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{command},
	})
	if run != nil {
		_ = run.Kill()
		_ = run.Wait()
		t.Fatalf("Start returned run %s for a non-cancellable context", run.RunID)
	}
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || diagnostic.Code != "KB_RUNTIME_START_CONTEXT_NOT_CANCELLABLE" {
		t.Fatalf("Start error = %v, want diagnostic KB_RUNTIME_START_CONTEXT_NOT_CANCELLABLE", err)
	}
	if _, err := os.Stat(state); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Start touched state before rejecting context: stat err = %v", err)
	}
}

// case: S-237.138
func TestStartCancellationReapsKeeperWaitingForReady(t *testing.T) {
	state := t.TempDir()
	fifo := filepath.Join(state, "stdout.fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	leasePath := filepath.Join(state, "worktree.lock")
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan error, 1)
	startDone := make(chan struct{})
	go func() {
		defer close(startDone)
		_, err := startTest(ctx, proc.Config{
			StateDir: state, Tag: "cancel-ready", Stall: time.Hour,
			StdoutPath: fifo, StderrPath: filepath.Join(state, "stderr.log"),
			SharedLeasePaths: []string{leasePath},
			Command:          []string{"true"},
		})
		resultCh <- err
	}()
	t.Cleanup(func() {
		cancel()
		<-startDone
	})
	keeperPID := waitForKeeperPID(t, state, "cancel-ready")
	cancel()
	if err := <-resultCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("Start after context cancellation = %v, want context.Canceled", err)
	}
	if identity, alive := identityForTest(t, keeperPID); alive {
		t.Fatalf("cancelled keeper %d remains alive with identity %s", keeperPID, identity)
	}
	lease, acquired, err := proc.AcquireFileLease(leasePath, proc.LeaseExclusiveTry)
	if err != nil || !acquired {
		t.Fatalf("canceled Start retained its worktree lease: acquired=%t err=%v", acquired, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
}

// case: S-237.138
func TestStartCancellationAtReadyPublicationReapsRunTree(t *testing.T) {
	state := t.TempDir()
	ctx := &cancelAtReadyPublicationContext{
		Context: context.Background(), done: make(chan struct{}),
		readySelected: make(chan struct{}), release: make(chan struct{}),
	}
	type startResult struct {
		run *proc.Run
		err error
	}
	resultCh := make(chan startResult, 1)
	startDone := make(chan struct{})
	t.Cleanup(func() {
		ctx.cancelAndRelease()
		<-startDone
		select {
		case result := <-resultCh:
			if result.run != nil {
				_ = result.run.Kill()
				_ = result.run.Wait()
			}
		default:
		}
	})
	go func() {
		defer close(startDone)
		run, err := startTest(ctx, proc.Config{
			StateDir: state, Tag: "cancel-at-ready-publication", Stall: time.Hour,
			StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
			Command: []string{"/bin/sleep", "30"},
		})
		resultCh <- startResult{run: run, err: err}
	}()
	deadline := time.NewTimer(testdeadline.Budget(t))
	defer deadline.Stop()
	select {
	case <-ctx.readySelected:
	case <-deadline.C:
		t.Fatal("Start did not reach the ready publication boundary")
	}
	keeperPID := waitForKeeperPID(t, state, "cancel-at-ready-publication")
	ctx.releasePublication()
	result := <-resultCh
	if result.run != nil {
		t.Fatalf("Start published run %s after caller cancellation", result.run.RunID)
	}
	if !errors.Is(result.err, context.Canceled) {
		t.Fatalf("Start at ready publication = %v, want context.Canceled", result.err)
	}
	if identity, alive := identityForTest(t, keeperPID); alive {
		t.Fatalf("cancelled keeper %d remains alive with identity %s", keeperPID, identity)
	}
	listing := proc.List(state)
	if listing.Error != nil {
		t.Fatalf("list state after ready-boundary cancellation: %s", listing.Error)
	}
	for _, run := range listing.Runs {
		if int(run.PID) == keeperPID && run.Status == proc.StatusRunning {
			t.Fatalf("cancelled keeper %d remains recorded as running", keeperPID)
		}
		for _, child := range run.Tree {
			if identity, alive := identityForTest(t, child.PID); alive && identity == child.Identity {
				t.Fatalf("cancelled run child %d remains alive with identity %s", child.PID, identity)
			}
		}
	}
	<-startDone // Start joins its readiness reader before returning cancellation.
}

type cancelAtReadyPublicationContext struct {
	context.Context
	done          chan struct{}
	readySelected chan struct{}
	release       chan struct{}
	readyOnce     sync.Once
	releaseOnce   sync.Once
	cancelOnce    sync.Once
	canceled      atomic.Bool
	checks        int
}

func (ctx *cancelAtReadyPublicationContext) Done() <-chan struct{} { return ctx.done }

func (ctx *cancelAtReadyPublicationContext) Err() error {
	ctx.checks++
	if ctx.checks >= 3 {
		ctx.readyOnce.Do(func() { close(ctx.readySelected) })
		<-ctx.release
		ctx.cancelOnce.Do(func() {
			ctx.canceled.Store(true)
			close(ctx.done)
		})
	}
	if ctx.canceled.Load() {
		return context.Canceled
	}
	return nil
}

func (ctx *cancelAtReadyPublicationContext) releasePublication() {
	ctx.releaseOnce.Do(func() { close(ctx.release) })
}

func (ctx *cancelAtReadyPublicationContext) cancelAndRelease() {
	ctx.releasePublication()
	ctx.cancelOnce.Do(func() {
		ctx.canceled.Store(true)
		close(ctx.done)
	})
}

// case: S-237.138
func TestCommandFD3IsRunTokenNotReadinessFD(t *testing.T) {
	state := t.TempDir()
	marker := filepath.Join(state, "fd-result")
	statArguments := "-f %i"
	descriptor := "/dev/fd/3"
	if runtime.GOOS == "linux" {
		statArguments = "-L -c %i"
		descriptor = "/proc/self/fd/3"
	}
	statCommand := "expected=$(stat " + statArguments + " \"$KB_RUNNER_SCRATCH/.run-token\") || exit 2\n" +
		"actual=$(stat " + statArguments + " " + descriptor + ") || exit 3\n" +
		"if [ \"$actual\" = \"$expected\" ]; then printf run-token > \"$1\"; else printf wrong-descriptor > \"$1\"; fi"
	command := []string{"/bin/sh", "-c", statCommand, "sh", marker}
	run, err := startTest(cancellableTestContext(t), proc.Config{
		StateDir: state, Tag: "ready-fd-cloexec", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: command,
	})
	if err != nil {
		t.Fatalf("start keeper with fd inspection command: %v", err)
	}
	t.Cleanup(func() {
		if err := run.Kill(); err != nil {
			t.Logf("stop fd inspection run during cleanup: %v", err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("reap fd inspection run during cleanup: %v", err)
		}
	})
	waitForTestFile(t, marker)
	result, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read descendant fd inspection result: %v", err)
	}
	if string(result) != "run-token" {
		t.Fatalf("command fd 3 identity = %q, want run-token and not readiness pipe", result)
	}
}

// case: S-237.138
func TestStartReturnsKeeperExitWhileOutputOpenIsGated(t *testing.T) {
	state := t.TempDir()
	fifo := filepath.Join(state, "stdout.fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	type startResult struct {
		run *proc.Run
		err error
	}
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan startResult, 1)
	startDone := make(chan struct{})
	go func() {
		defer close(startDone)
		run, err := startTest(ctx, proc.Config{
			StateDir: state, Tag: "keeper-exits-before-ready", Stall: time.Hour,
			StdoutPath: fifo, StderrPath: filepath.Join(state, "stderr.log"),
			Command: []string{"/bin/sleep", "30"},
		})
		resultCh <- startResult{run: run, err: err}
	}()
	t.Cleanup(func() {
		cancel()
		<-startDone
		select {
		case result := <-resultCh:
			if result.run != nil {
				_ = result.run.Kill()
				_ = result.run.Wait()
			}
		default:
		}
	})
	keeperPID := waitForKeeperPID(t, state, "keeper-exits-before-ready")
	if err := syscall.Kill(keeperPID, syscall.SIGKILL); err != nil {
		t.Fatalf("terminate keeper blocked before readiness: %v", err)
	}
	timer := time.NewTimer(testdeadline.Budget(t))
	defer timer.Stop()
	var result startResult
	select {
	case result = <-resultCh:
	case <-timer.C:
		t.Fatal("Start did not observe keeper exit while stdout remained gated")
	}
	if result.run != nil {
		t.Fatal("Start returned a Run after the keeper exited before readiness")
	}
	var exitErr *proc.KeeperExitError
	if !errors.As(result.err, &exitErr) {
		t.Fatalf("Start error = %v, want KeeperExitError", result.err)
	}
	if exitErr.Status != "signal: killed" {
		t.Fatalf("keeper exit status = %q, want signal: killed", exitErr.Status)
	}
	if identity, alive := identityForTest(t, keeperPID); alive {
		t.Fatalf("keeper %d remains alive with identity %s", keeperPID, identity)
	}
	if listing := proc.List(state); listing.Error != nil {
		t.Fatalf("list state after early keeper exit: %s", listing.Error)
	} else {
		for _, run := range listing.Runs {
			if int(run.PID) == keeperPID && run.Status == proc.StatusRunning {
				t.Fatalf("early-exit keeper %d remains recorded as running", keeperPID)
			}
		}
	}
}

// case: S-237.138
func TestStartExitsWithoutEOFWhenKeeperChildRetainsReadinessWriter(t *testing.T) {
	helper := proc.BuildRetainingKeeperForTest(t)
	for _, handshake := range []string{"none", "partial"} {
		t.Run(handshake, func(t *testing.T) {
			type startResult struct {
				run *proc.Run
				err error
			}
			state := t.TempDir()
			tag := "retained-readiness-" + handshake
			reportPath := filepath.Join(state, "helper-processes.json")
			resultCh := make(chan startResult, 1)
			startDone := make(chan struct{})
			go func() {
				defer close(startDone)
				run, err := proc.StartWithExecutableForTest(cancellableTestContext(t), proc.Config{
					StateDir: state, Tag: tag, Stall: time.Hour,
					StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
					Command: []string{"true"},
					Env: []string{
						"X199_RETAINING_KEEPER_REPORT=" + reportPath,
						"X199_RETAINING_KEEPER_HANDSHAKE=" + handshake,
					},
				}, stableHostResourceSource{}, helper)
				resultCh <- startResult{run: run, err: err}
			}()

			var processes struct {
				KeeperPID  int `json:"keeper_pid"`
				HolderPID  int `json:"holder_pid"`
				ExitStatus int `json:"exit_status"`
			}
			cleanupWait := testdeadline.Budget(t)
			t.Cleanup(func() {
				if processes.KeeperPID > 0 {
					if err := syscall.Kill(-processes.KeeperPID, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
						t.Logf("kill retained-writer fixture process group: %v", err)
					}
				}
				timer := time.NewTimer(cleanupWait)
				defer timer.Stop()
				select {
				case <-startDone:
				case <-timer.C:
					t.Log("Start goroutine did not return after retained-writer fixture cleanup")
				}
			})
			waitForTestFile(t, reportPath)
			report, err := os.ReadFile(reportPath)
			if err != nil {
				t.Fatalf("read retained-writer fixture process report: %v", err)
			}
			if err := json.Unmarshal(report, &processes); err != nil {
				t.Fatalf("decode retained-writer fixture process report: %v", err)
			}
			if processes.KeeperPID <= 0 || processes.HolderPID <= 0 || processes.ExitStatus <= 0 {
				t.Fatalf("fixture process identities = %+v", processes)
			}
			if _, alive := identityForTest(t, processes.HolderPID); !alive {
				t.Fatalf("retained-writer holder %d was not alive after its ready signal", processes.HolderPID)
			}
			listing := proc.List(state)
			if listing.Error != nil {
				t.Fatalf("inspect Start's run record before releasing fake keeper: %v", listing.Error)
			}
			foundRecord := false
			for _, run := range listing.Runs {
				if run.Tag == tag {
					foundRecord = true
				}
			}
			if !foundRecord {
				t.Fatalf("Start did not create real run record %q before keeper exit", tag)
			}
			if err := syscall.Kill(processes.KeeperPID, syscall.SIGUSR1); err != nil {
				t.Fatalf("release fake keeper after observing its retained writer: %v", err)
			}

			timer := time.NewTimer(testdeadline.Budget(t))
			defer timer.Stop()
			var result startResult
			select {
			case result = <-resultCh:
			case <-timer.C:
				t.Fatalf("Start waited for retained readiness writer (%s handshake)", handshake)
			}
			if result.run != nil {
				t.Fatalf("Start returned run %s for keeper that exited before readiness", result.run.RunID)
			}
			var keeperExit *proc.KeeperExitError
			if !errors.As(result.err, &keeperExit) {
				t.Fatalf("Start error = %v, want KeeperExitError", result.err)
			}
			wantKeeperExit := fmt.Sprintf("exit status %d", processes.ExitStatus)
			if keeperExit.Status != wantKeeperExit {
				t.Fatalf("keeper exit status = %q, want diag-selected %s", keeperExit.Status, wantKeeperExit)
			}
			<-startDone // Start returns only after the readiness reader is joined.

			awaitProcessGone(t, processes.KeeperPID)
			awaitProcessGone(t, processes.HolderPID)
			listing = proc.List(state)
			if listing.Error != nil {
				t.Fatalf("list state after retained-writer keeper exit: %v", listing.Error)
			}
			for _, run := range listing.Runs {
				if run.Tag == tag && run.Status == proc.StatusRunning {
					t.Fatalf("retained-writer run %q remains recorded as running", tag)
				}
			}
			eventData, err := os.ReadFile(filepath.Join(state, "events.jsonl"))
			if err != nil {
				t.Fatalf("read real run lifecycle events: %v", err)
			}
			foundTeardown := false
			for _, line := range strings.Split(strings.TrimSpace(string(eventData)), "\n") {
				var event proc.Event
				if err := json.Unmarshal([]byte(line), &event); err != nil {
					t.Fatalf("decode run lifecycle event: %v", err)
				}
				if event.Tag == tag && event.Type == proc.EventTeardown {
					foundTeardown = true
				}
			}
			if !foundTeardown {
				t.Fatalf("Start did not tear down real run record %q", tag)
			}
		})
	}
}

// case: S-237.138
func TestStartWaitsPastFormerReadinessDeadlineUntilFIFOReader(t *testing.T) {
	state := t.TempDir()
	fifo := filepath.Join(state, "stdout.fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	type startResult struct {
		run *proc.Run
		err error
	}
	resultCh := make(chan startResult, 1)
	startDone := make(chan struct{})
	go func() {
		defer close(startDone)
		run, err := startTest(ctx, proc.Config{
			StateDir: state, Tag: "gated-ready", Stall: time.Hour,
			StdoutPath: fifo, StderrPath: filepath.Join(state, "stderr.log"),
			Command: []string{"true"},
		})
		resultCh <- startResult{run: run, err: err}
	}()
	var reader *os.File
	t.Cleanup(func() {
		cancel()
		if reader != nil {
			_ = reader.Close()
		}
		<-startDone
		select {
		case result := <-resultCh:
			if result.run != nil {
				_ = result.run.Kill()
				_ = result.run.Wait()
			}
		default:
		}
	})
	waitForKeeperPID(t, state, "gated-ready")
	stimulus := time.NewTimer(testdeadline.FormerFixedReadinessDeadlinePlusMarginStimulus)
	defer stimulus.Stop()
	<-stimulus.C
	file, err := os.OpenFile(fifo, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		t.Fatalf("open readiness-gated stdout FIFO: %v", err)
	}
	reader = file
	result := <-resultCh
	if result.err != nil {
		t.Fatalf("Start after FIFO reader release: %v", result.err)
	}
	if result.run == nil {
		t.Fatal("Start returned no run after FIFO reader release")
	}
	t.Cleanup(func() {
		if err := result.run.Kill(); err != nil {
			t.Logf("stop FIFO-gated run during cleanup: %v", err)
		}
		if err := result.run.Wait(); err != nil {
			t.Logf("reap FIFO-gated run during cleanup: %v", err)
		}
	})
}

func waitForTestFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.NewTimer(testdeadline.Budget(t))
	defer deadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !os.IsNotExist(err) {
			t.Fatalf("inspect test signal file %s: %v", path, err)
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatalf("test signal file %s was not created before the deadline", path)
		}
	}
}

func awaitProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.NewTimer(testdeadline.Budget(t))
	defer deadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for {
		_, alive, err := proc.ProcessIdentity(pid)
		if err != nil {
			t.Fatalf("inspect process %d after Start cleanup: %v", pid, err)
		}
		if !alive {
			return
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatalf("process %d survived Start cleanup", pid)
		}
	}
}

func waitForKeeperPID(t *testing.T, state, tag string) int {
	t.Helper()
	deadline := time.NewTimer(testdeadline.Budget(t))
	defer deadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for {
		files, err := filepath.Glob(filepath.Join(state, "runs", "*.json"))
		if err != nil {
			t.Fatalf("list run records: %v", err)
		}
		for _, path := range files {
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			var rec struct {
				Tag       string `json:"tag"`
				PID       int    `json:"pid"`
				StartedAt string `json:"started_at"`
			}
			if err := json.Unmarshal(data, &rec); err != nil {
				continue
			}
			if rec.Tag == tag && rec.PID > 0 && rec.PID != os.Getpid() && strings.TrimSpace(rec.StartedAt) != "" {
				return rec.PID
			}
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatalf("keeper for %q did not publish its starting identity", tag)
		}
	}
}
