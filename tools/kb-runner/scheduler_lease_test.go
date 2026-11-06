//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
)

func replaceTestEnvironment(environment []string, key, value string) []string {
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if strings.HasPrefix(entry, key+"=") {
			continue
		}
		result = append(result, entry)
	}
	return append(result, key+"="+value)
}

// case: S-237.128
func TestSchedulerReadyClaimIsAtomicAcrossStoreInstances(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "atomic-claim", "worker")
	stores := []*schedulerStore{newSchedulerStore(f.state), newSchedulerStore(f.state)}
	start := make(chan struct{})
	var wait sync.WaitGroup
	var mu sync.Mutex
	claimed := 0
	for _, store := range stores {
		wait.Add(1)
		go func(store *schedulerStore) {
			defer wait.Done()
			<-start
			_, ok, err := store.claimReady(task.Stream, task.ID)
			if err != nil {
				t.Errorf("claim READY: %v", err)
				return
			}
			if ok {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		}(store)
	}
	close(start)
	wait.Wait()
	if claimed != 1 {
		t.Fatalf("READY compare-and-set succeeded %d times, want exactly once", claimed)
	}
	stream, err := stores[0].stream(task.Stream)
	if err != nil || stream.State != SchedulerRunning {
		t.Fatalf("claimed stream=%+v err=%v", stream, err)
	}
}

func TestSchedulerLeaseSubprocess(t *testing.T) {
	if os.Getenv("KB_RUNNER_SCHEDULER_LEASE_HELPER") != "1" {
		lease, err := newSchedulerStore(t.TempDir()).acquireRunLease()
		if err != nil {
			t.Fatalf("acquire fixture scheduler lease: %v", err)
		}
		if err := releaseRunLease(lease); err != nil {
			t.Fatalf("release fixture scheduler lease: %v", err)
		}
		return
	}
	state := os.Getenv("KB_RUNNER_SCHEDULER_LEASE_STATE")
	if state == "" {
		t.Fatal("subprocess lease helper requires KB_RUNNER_SCHEDULER_LEASE_STATE")
	}
	status := executeInvocation("kb-runner", []string{"sched", "run", "--state", state}, os.Stdout, os.Stderr)
	os.Exit(status.Code())
}

// case: S-237.128
func TestTwoSchedulerProcessesShareOneRunLeaseAndWatcher(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "lease-owner", "worker")
	f.addAwaitingRemote(t, task, SchedulerSubmission{SHA: schedulerTestSHA, Ref: "verify/lease-owner-0123456", RunID: "41", Status: "queued", DeadlineAt: time.Now().Add(time.Hour)})
	marker := filepath.Join(t.TempDir(), "watcher.started")
	fifo := filepath.Join(t.TempDir(), "watcher.release")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	baseEnv := []string{
		"KB_RUNNER_SCHEDULER_LEASE_HELPER=1",
		"KB_RUNNER_SCHEDULER_LEASE_STATE=" + f.state,
		"FAKE_GH_BLOCK=1",
		"FAKE_GH_STARTED=" + marker,
		"FAKE_GH_FIFO=" + fifo,
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSchedulerLeaseSubprocess$")
	first.Env = append(os.Environ(), baseEnv...)
	first.Stdout = io.Discard
	var firstErrors strings.Builder
	first.Stderr = &firstErrors
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan error, 1)
	go func() { firstDone <- first.Wait() }()
	t.Cleanup(func() {
		cancel()
		if first.ProcessState == nil {
			if err := first.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("kill first scheduler subprocess: %v", err)
			}
			<-firstDone
		}
	})
	deadline := time.NewTimer(10 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer deadline.Stop()
	defer ticker.Stop()
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		select {
		case err := <-firstDone:
			t.Fatalf("first scheduler exited before watcher started: %v stderr=%s", err, firstErrors.String())
		case <-ticker.C:
		case <-deadline.C:
			t.Fatalf("first scheduler did not enter its watcher; stderr=%s", firstErrors.String())
		}
	}
	second := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSchedulerLeaseSubprocess$")
	second.Env = append(replaceTestEnvironment(os.Environ(), "FAKE_GH_BLOCK", "0"), baseEnv[:2]...)
	var secondOutput strings.Builder
	second.Stdout, second.Stderr = &secondOutput, &secondOutput
	secondDone := make(chan error, 1)
	go func() { secondDone <- second.Run() }()
	t.Cleanup(func() {
		if second.ProcessState == nil {
			cancel()
			if err := second.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("kill second scheduler subprocess: %v", err)
			}
			<-secondDone
		}
	})
	select {
	case err := <-secondDone:
		if err == nil || !strings.Contains(secondOutput.String(), "KB_RUNNER_SCHEDULER_ALREADY_RUNNING") {
			t.Fatalf("second scheduler exit=%v output=%s", err, secondOutput.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("second scheduler did not reject the held state-directory lease")
	}
	if _, ok := diag.LookupCatalog("KB_RUNNER_SCHEDULER_ALREADY_RUNNING"); !ok {
		t.Fatal("scheduler lease diagnostic is not in the shared catalog")
	}
	writer, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := writer.WriteString("release\n")
	closeErr := writer.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("release fake watcher: write=%v close=%v", writeErr, closeErr)
	}
	cancel()
	<-firstDone
}

// case: S-237.130
func TestPublicLandRefusesWhileSchedulerOwnsRunLease(t *testing.T) {
	state := t.TempDir()
	lease, err := newSchedulerStore(state).acquireRunLease()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := syscall.Flock(int(lease.Fd()), syscall.LOCK_UN); err != nil {
			t.Errorf("unlock scheduler run lease: %v", err)
		}
		if err := lease.Close(); err != nil {
			t.Errorf("close scheduler run lease: %v", err)
		}
	})
	var output strings.Builder
	root := runnerRoot{Root: command.InvocationRoot("kb-runner"), invocation: "kb-runner"}
	status, runErr := landCommand(root, []string{"some-stream", "--state", state}, &output, &output)
	var diagnostic *diag.Diag
	if status != 2 || !errors.As(runErr, &diagnostic) || diagnostic.Code != "KB_RUNNER_SCHEDULER_ALREADY_RUNNING" {
		t.Fatalf("public land did not refuse the held scheduler lease: status=%d err=%v output=%q", status, runErr, output.String())
	}
}
