package host

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestStateHomeIsPerUserAndFollowsKBHome(t *testing.T) {
	root := t.TempDir()
	t.Setenv(KBHomeEnv, root)
	state, err := StateHome()
	if err != nil {
		t.Fatal(err)
	}
	if state.Dir != filepath.Join(root, "launcher") {
		t.Fatalf("state dir = %s", state.Dir)
	}
	if state.Control() != filepath.Join(root, "launcher", "control.json") || state.HostPID() != filepath.Join(root, "launcher", "host.pid") {
		t.Fatalf("state files are not under the launcher home: %s %s", state.Control(), state.HostPID())
	}
}

func TestStateHomeDefaultsToTheUserHome(t *testing.T) {
	t.Setenv(KBHomeEnv, "  ")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no user home on this machine")
	}
	state, err := StateHome()
	if err != nil {
		t.Fatal(err)
	}
	if state.Dir != filepath.Join(home, ".kb", "launcher") {
		t.Fatalf("state dir = %s", state.Dir)
	}
}

func operationCode(err error) string {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		return typed.Code
	}
	return ""
}

func TestOperationLockAdmitsOneLauncherAtATime(t *testing.T) {
	state := State{Dir: filepath.Join(t.TempDir(), "launcher")}
	release, err := state.AcquireOperation("update")
	if err != nil {
		t.Fatal(err)
	}
	_, err = state.AcquireOperation("rollback")
	if operationCode(err) != contracts.CodeOperationInProgress {
		t.Fatalf("second operation: %v", err)
	}
	var typed *contracts.LauncherError
	errors.As(err, &typed)
	if typed.Details["pid"] != strconv.Itoa(os.Getpid()) || problemsOf(typed) != "" {
		t.Fatalf("error = %#v (%s)", typed, problemsOf(typed))
	}
	release()
	release() // releasing twice must not fail or remove another holder's lock
	again, err := state.AcquireOperation("rollback")
	if err != nil {
		t.Fatalf("the lock must be free after release: %v", err)
	}
	again()
}

func problemsOf(err *contracts.LauncherError) string { return strings.Join(err.Validate(), "; ") }

func TestOperationLockIsTakenOverWhenItsHolderIsGone(t *testing.T) {
	state := State{Dir: t.TempDir()}
	if err := os.WriteFile(state.OperationLock(), []byte("2147483646 update\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := state.AcquireOperation("update")
	if err != nil {
		t.Fatalf("a stale lock must be replaced: %v", err)
	}
	release()
	if _, err := os.Stat(state.OperationLock()); !os.IsNotExist(err) {
		t.Fatalf("the lock must be removed on release: %v", err)
	}
}
