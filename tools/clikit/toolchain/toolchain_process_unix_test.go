//go:build darwin || linux

package toolchain

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/internal/testdeadline"
)

// case: S-179.27
func TestExternalToolRunKillsGrandchildHoldingOutputPipes(t *testing.T) {
	dir := t.TempDir()
	ready := filepath.Join(dir, "tree-ready")
	grandchildPID := filepath.Join(dir, "grandchild.pid")
	rootPID := filepath.Join(dir, "root.pid")
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	runDone := make(chan struct{})
	started := time.Now()
	script := `sleep 30 &
printf '%s\n' "$$" > "$CLIKIT_PROCESS_TREE_ROOT_PID"
printf '%s\n' "$!" > "$CLIKIT_PROCESS_TREE_GRANDCHILD_PID"
printf 'grandchild-started\n' >&2
: > "$CLIKIT_PROCESS_TREE_READY"
wait`
	go func() {
		defer close(runDone)
		_, err := run(ctx, Invocation{
			Tool: "process-tree-fixture", Executable: "/bin/sh", Args: []string{"-c", script},
			Env:       append(os.Environ(), "CLIKIT_PROCESS_TREE_READY="+ready, "CLIKIT_PROCESS_TREE_GRANDCHILD_PID="+grandchildPID, "CLIKIT_PROCESS_TREE_ROOT_PID="+rootPID),
			Operation: OperationWorkspaceTask,
		}, 10*time.Second)
		errCh <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(time.Second):
		}
		for _, path := range []string{rootPID, grandchildPID} {
			data, err := os.ReadFile(path)
			if err != nil {
				if !errors.Is(err, os.ErrNotExist) {
					t.Errorf("read owned process id for cleanup from %s: %v", path, err)
				}
				continue
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
			if err != nil {
				t.Errorf("parse owned process id for cleanup from %s: %v", path, err)
				continue
			}
			if path == rootPID {
				checkCleanupSignal(t, -pid)
			} else {
				checkCleanupSignal(t, pid)
			}
		}
		select {
		case <-runDone:
		case <-time.After(time.Second):
			t.Errorf("process-tree runner remained alive after cancellation and forced cleanup")
		}
	})
	deadline := time.NewTimer(testdeadline.Budget(t))
	defer deadline.Stop()
	readyPoll := time.NewTicker(time.Millisecond)
	defer readyPoll.Stop()
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("process-tree fixture did not signal readiness")
		case <-readyPoll.C:
		}
	}
	cancel()
	var runErr error
	select {
	case runErr = <-errCh:
		if runErr == nil {
			t.Fatal("canceled process tree returned success")
		}
	case <-time.After(testdeadline.Budget(t)):
		t.Fatal("Run did not return promptly after canceling the process group")
	}
	if elapsed := time.Since(started); elapsed > testdeadline.ProcessCancellationBound(t) {
		t.Fatalf("process tree cancellation took %s", elapsed)
	}
	data, err := os.ReadFile(grandchildPID)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	err = syscall.Kill(pid, 0)
	if err == nil {
		t.Fatalf("grandchild %d remains alive after Run returned with error %v", pid, runErr)
	}
	if !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("check grandchild %d after Run with signal 0: %v", pid, err)
	}
}

func checkCleanupSignal(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		t.Errorf("kill owned process %d during cleanup: %v", pid, err)
	}
}
