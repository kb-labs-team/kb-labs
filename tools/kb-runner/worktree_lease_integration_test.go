//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/command"
)

// case: S-276.1
func TestRunCommandLeaseBlocksWorktreeRemovalForChildLifetime(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "worker")
	gitTest(t, integration, "worktree", "add", "-b", "agent/worker", worktree, "HEAD")
	state := filepath.Join(root, "logs", "runner")
	t.Setenv("KBLABS_WORKTREES_ROOT", root)
	t.Setenv("GOCACHE", filepath.Join(root, "go-cache"))
	childReady := filepath.Join(root, "run-child-ready")
	previousWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(worktree); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previousWD); err != nil {
			t.Errorf("restore current directory: %v", err)
		}
	})
	runnerStdout, runnerStderr := &bytes.Buffer{}, &bytes.Buffer{}
	ctx, cancel := context.WithCancel(context.Background())
	type commandResult struct {
		code int
		err  error
	}
	result := make(chan commandResult, 1)
	commandRoot := runnerRoot{Root: command.InvocationRoot("kb-runner"), invocation: "kb-runner"}
	go func() {
		code, err := runCommandWithContext(ctx, commandRoot, []string{"--tag", "lease-child", "--state", state, "--stall", "1m", "--stdout", filepath.Join(state, "child.stdout"), "--stderr", filepath.Join(state, "child.stderr"), "--", "/bin/sh", "-c", "printf ready > \"$1\"; exec /bin/sleep 60", "sh", childReady}, runnerStdout, runnerStderr)
		result <- commandResult{code: code, err: err}
	}()
	waited := false
	t.Cleanup(func() {
		if !waited {
			cancel()
			<-result
		}
	})
	if err := waitForFile(childReady); err != nil {
		cancel()
		outcome := <-result
		waited = true
		childStderr, _ := os.ReadFile(filepath.Join(state, "child.stderr"))
		t.Fatalf("runner child did not reach its readiness marker: %v; runner-code=%d runner-error=%v stdout=%q stderr=%q child-stderr=%q", err, outcome.code, outcome.err, runnerStdout.String(), runnerStderr.String(), childStderr)
	}

	leasePath := derivedWorktreeLeasePath(t, worktree)
	if !waitForWorktreeLeaseBusy(t, leasePath) {
		t.Fatal("real kb-runner run command did not hold its derived worktree lease")
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("runner child worktree was removed while its lease was held: %v", err)
	}
	cancel()
	outcome := <-result
	waited = true
	if outcome.code != 143 {
		t.Fatalf("run command exit = %d, err=%v; want cancellation 143", outcome.code, outcome.err)
	}
	lease, acquired, err := tryExclusiveWorktreeLease(leasePath)
	if err != nil || !acquired {
		t.Fatalf("runner lease remained after child exit: acquired=%t err=%v", acquired, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
}

// case: S-276.1
func TestAgentStartLeaseBlocksWorktreeRemovalForChildLifetime(t *testing.T) {
	root, integration := hygieneGitFixture(t)
	worktree := filepath.Join(root, "agent-worker")
	gitTest(t, integration, "worktree", "add", "-b", "agent/worker", worktree, "HEAD")
	state := filepath.Join(root, "logs", "runner")
	t.Setenv("KBLABS_WORKTREES_ROOT", root)
	prompt := filepath.Join(root, "prompt.md")
	if err := os.WriteFile(prompt, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	startedPath, releaseFIFO := filepath.Join(root, "provider-started.txt"), filepath.Join(root, "provider-release.fifo")
	if err := syscall.Mkfifo(releaseFIFO, 0o600); err != nil {
		t.Fatal(err)
	}
	releaseWriter, err := os.OpenFile(releaseFIFO, os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("open test-owned provider release FIFO: %v", err)
	}
	var releaseOnce sync.Once
	var releaseErr error
	releaseProvider := func() error {
		releaseOnce.Do(func() {
			_, writeErr := releaseWriter.WriteString("release\n")
			releaseErr = errors.Join(writeErr, releaseWriter.Close())
		})
		return releaseErr
	}
	fakeCodex := filepath.Join(root, "codex")
	script := "#!/bin/sh\nprintf 'started\\n' > " + shellQuote(startedPath) + "\nIFS= read -r _ < " + shellQuote(releaseFIFO) + "\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"lease-session\"}' '{\"type\":\"turn.completed\",\"message\":\"done\"}'\n"
	if err := os.WriteFile(fakeCodex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", fakeCodex)
	runner := buildRunnerBinary(t)
	commandRoot := runnerRoot{Root: command.InvocationRoot(runner), invocation: runner, executable: runner}
	var runnerStdout, runnerStderr bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	type commandResult struct {
		code int
		err  error
	}
	result := make(chan commandResult, 1)
	go func() {
		code, err := agentStartCommandWithContext(ctx, commandRoot, []string{"--state", state, "--stream", "worker", "--vendor", "codex", "--workdir", worktree, "--prompt-file", prompt, "--stall", "1m"}, &runnerStdout, &runnerStderr)
		result <- commandResult{code: code, err: err}
	}()
	waited := false
	t.Cleanup(func() {
		if !waited {
			if err := releaseProvider(); err != nil {
				t.Errorf("release fake provider during cleanup: %v", err)
			}
			cancel()
			<-result
		}
	})
	if err := waitForFile(startedPath); err != nil {
		cancel()
		if err := releaseProvider(); err != nil {
			t.Errorf("release fake provider after startup timeout: %v", err)
		}
		outcome := <-result
		waited = true
		t.Fatalf("agent start did not reach the provider child: %v; runner-code=%d runner-error=%v stdout=%q stderr=%q", err, outcome.code, outcome.err, runnerStdout.String(), runnerStderr.String())
	}
	leasePath := derivedWorktreeLeasePath(t, worktree)
	if !waitForWorktreeLeaseBusy(t, leasePath) {
		t.Fatal("real agent start command did not hold its derived worktree lease")
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("worktree removed while agent child was live: %v", err)
	}
	cancel()
	if err := releaseProvider(); err != nil {
		t.Fatalf("release fake provider after lease assertion: %v", err)
	}
	outcome := <-result
	waited = true
	if outcome.code != 1 {
		t.Fatalf("agent start cancellation exit = %d, err=%v; want 1", outcome.code, outcome.err)
	}
	lease, acquired, err := tryExclusiveWorktreeLease(leasePath)
	if err != nil || !acquired {
		t.Fatalf("agent start lease remained after child exit: acquired=%t err=%v", acquired, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
}

func derivedWorktreeLeasePath(t *testing.T, worktree string) string {
	t.Helper()
	paths, err := runnerWorktreeLeasePaths(worktree)
	if err != nil {
		t.Fatalf("derive production worktree lease path: %v", err)
	}
	if len(paths) != 1 {
		t.Fatalf("production worktree lease paths = %q, want one path", paths)
	}
	return paths[0]
}

func waitForWorktreeLeaseBusy(t *testing.T, path string) bool {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		lease, acquired, err := tryExclusiveWorktreeLease(path)
		if err != nil {
			t.Fatalf("probe derived worktree lease: %v", err)
		}
		if !acquired {
			return true
		}
		if err := lease.Close(); err != nil {
			t.Fatalf("close free lease probe: %v", err)
		}
		runtime.Gosched()
	}
	return false
}

func waitForFile(path string) error {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		runtime.Gosched()
	}
	return errors.New("timed out waiting for child readiness marker")
}
