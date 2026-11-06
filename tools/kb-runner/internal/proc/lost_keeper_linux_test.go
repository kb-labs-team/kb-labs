//go:build linux

package proc_test

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
	"unsafe"

	"github.com/kb-labs/kb-runner/internal/proc"
	"golang.org/x/sys/unix"
)

// case: S-237.69
func TestKilledKeeperRecoveryUsesDurableRecordToStopDetachedTree(t *testing.T) {
	state := t.TempDir()
	pidFile := filepath.Join(state, "detached.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	run, err := proc.StartWithHostResourceSource(ctx, proc.Config{
		StateDir: state, Tag: "keeper-sigkill", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"),
		StderrPath: filepath.Join(state, "stderr.log"),
		Command:    []string{"/bin/sh", "-c", `setsid /bin/sh -c 'echo "$$" > "$1"; exec /bin/sleep 30' sh "$1" & wait`, "sh", pidFile},
	}, stableHostResourceSource{})
	if err != nil {
		t.Fatal(err)
	}
	pid, err := waitPIDFile(pidFile, 5*time.Second)
	if err != nil {
		t.Fatalf("detached descendant did not start: %v", err)
	}
	identity, alive := identityForTest(t, pid)
	if !alive || identity == "" {
		t.Fatalf("detached descendant is not live before keeper SIGKILL: pid=%d identity=%q alive=%t", pid, identity, alive)
	}
	t.Cleanup(func() {
		state, current, exists := linuxProcessStateAndIdentity(pid)
		if exists && current == identity && state != "Z" && state != "X" {
			if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				t.Logf("stop test-owned detached PID %d after failed recovery: %v", pid, err)
			}
		}
		if _, exists := identityForTest(t, int(run.PID)); exists {
			if err := syscall.Kill(int(run.PID), syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				t.Logf("stop test-owned keeper PID %d: %v", run.PID, err)
			}
		}
	})
	if _, err := proc.ReadRunRecord(state, run.RunID); err != nil {
		t.Fatalf("durable run record was not available before keeper SIGKILL: %v", err)
	}
	if err := syscall.Kill(int(run.PID), syscall.SIGKILL); err != nil {
		t.Fatalf("SIGKILL keeper PID %d: %v", run.PID, err)
	}
	if err := run.Wait(); err == nil {
		t.Fatal("wait after keeper SIGKILL returned success")
	}
	if !waitUntil(5*time.Second, func() bool {
		_, current, exists := linuxProcessStateAndIdentity(pid)
		return !exists || current != identity
	}) {
		processState, current, exists := linuxProcessStateAndIdentity(pid)
		t.Fatalf("durable-record recovery left detached PID %d state=%s identity=%s exists=%t", pid, processState, current, exists)
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Status != proc.StatusLost {
		t.Fatalf("lost keeper recovery state = %+v, err=%v", listing.Runs, listing.Error)
	}
	event := eventForRunAndType(t, state, run.RunID, proc.EventTeardown)
	if event.Error != "" || len(event.Remaining) != 0 {
		t.Fatalf("lost keeper teardown = error %q remaining=%+v, want empty cleanup", event.Error, event.Remaining)
	}
}

func TestRunDoesNotMakeCallingProcessAChildSubreaper(t *testing.T) {
	assertNotChildSubreaper(t)
	state := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	run, err := proc.StartWithHostResourceSource(ctx, proc.Config{
		StateDir: state, Tag: "caller-subreaper", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/bin/true"},
	}, stableHostResourceSource{})
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Wait(); err != nil {
		t.Fatalf("wait for successful child run: %v", err)
	}
	assertNotChildSubreaper(t)
}

func assertNotChildSubreaper(t *testing.T) {
	t.Helper()
	var enabled int32
	if err := unix.Prctl(unix.PR_GET_CHILD_SUBREAPER, uintptr(unsafe.Pointer(&enabled)), 0, 0, 0); err != nil {
		t.Fatalf("inspect caller child-subreaper state: %v", err)
	}
	if enabled != 0 {
		t.Fatal("proc run changed its calling process into a child subreaper")
	}
}

func linuxProcessStateAndIdentity(pid int) (state, identity string, exists bool) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", "", false
		}
		return "unreadable", "", true
	}
	close := strings.LastIndexByte(string(data), ')')
	if close < 0 || close+2 >= len(data) {
		return "malformed", "", true
	}
	fields := strings.Fields(string(data[close+1:]))
	if len(fields) <= 19 {
		return "malformed", "", true
	}
	return fields[0], fields[19], true
}
