package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/operationlock"
	"github.com/kb-labs/create/v2/contracts"
)

func TestStateHomeIsPerUserAndFollowsKBHome(t *testing.T) {
	root := t.TempDir()
	t.Setenv(KBHomeEnv, root)
	state, err := StateHome(root)
	if err != nil {
		t.Fatal(err)
	}
	if state.Dir != filepath.Join(root, "launcher") {
		t.Fatalf("state dir = %s", state.Dir)
	}
	if state.Control() != filepath.Join(state.Dir, "control.json") || state.HostPID() != filepath.Join(state.Dir, "host.pid") {
		t.Fatalf("state files are not under the launcher home: %s %s", state.Control(), state.HostPID())
	}
}

// case: S-285.11
func TestStateHomeDefaultsToInstallationRoot(t *testing.T) {
	t.Setenv(KBHomeEnv, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(t.TempDir(), "install")
	state, err := StateHome(root)
	if err != nil {
		t.Fatal(err)
	}
	homePath, err := DefaultKBHome(root)
	if err != nil {
		t.Fatal(err)
	}
	if state.Dir != filepath.Join(homePath, "launcher") {
		t.Fatalf("state dir = %s", state.Dir)
	}
	if err := state.Ensure(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".kb")); !os.IsNotExist(err) {
		t.Fatalf("unexpected HOME state: %v", err)
	}
}

// case: PC-001.10, PC-001.12, PC-001.16
func TestStateForRootSeparatesConcurrentInstallations(t *testing.T) {
	rootA := filepath.Join(t.TempDir(), "platform-a")
	rootB := filepath.Join(t.TempDir(), "platform-b")
	stateA, err := StateForRoot(rootA)
	if err != nil {
		t.Fatal(err)
	}
	stateB, err := StateForRoot(rootB)
	if err != nil {
		t.Fatal(err)
	}
	if stateA.Dir == stateB.Dir || stateA.HostPID() == stateB.HostPID() {
		t.Fatalf("installation lifecycle state collides: A=%q B=%q", stateA.Dir, stateB.Dir)
	}
	canonicalRoot, err := filepath.EvalSymlinks(filepath.Dir(rootA))
	if err != nil {
		t.Fatal(err)
	}
	if stateA.Dir != filepath.Join(canonicalRoot, filepath.Base(rootA), "installer", "host") {
		t.Fatalf("host lifecycle state = %q; it must survive version switches inside the installation root", stateA.Dir)
	}
	stateAAgain, err := StateForRoot(rootA)
	if err != nil || stateAAgain.Dir != stateA.Dir {
		t.Fatalf("root state is not stable: %q / %q / %v", stateA.Dir, stateAAgain.Dir, err)
	}
}

func TestStateForRootDerivesTheSameInstallContainerFromEveryPlatformPath(t *testing.T) {
	installRoot := filepath.Join(t.TempDir(), "install")
	versionRoot := filepath.Join(installRoot, "versions", "v1")
	if err := os.MkdirAll(versionRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("versions", "v1"), filepath.Join(installRoot, "current")); err != nil {
		t.Fatal(err)
	}
	inputs := []string{installRoot, filepath.Join(installRoot, "current"), versionRoot}
	var expected string
	for _, input := range inputs {
		state, err := StateForRoot(input)
		if err != nil {
			t.Fatalf("StateForRoot(%q): %v", input, err)
		}
		if expected == "" {
			expected = state.Dir
		}
		if state.Dir != expected {
			t.Fatalf("StateForRoot(%q) = %q, want shared install state %q", input, state.Dir, expected)
		}
	}
}

func operationCode(err error) string {
	var typed *diag.Diag
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
	var typed *diag.Diag
	errors.As(err, &typed)
	if typed.Meta["pid"] != strconv.Itoa(os.Getpid()) || typed.Hint == "" {
		t.Fatalf("error = %#v (%s)", typed, typed.Hint)
	}
	release()
	release() // releasing twice must not fail or remove another holder's lock
	again, err := state.AcquireOperation("rollback")
	if err != nil {
		t.Fatalf("the lock must be free after release: %v", err)
	}
	again()
}

func TestOperationLockIgnoresUnownedFileContentsAndKeepsPath(t *testing.T) {
	state := State{Dir: t.TempDir()}
	if err := os.WriteFile(state.OperationLock(), []byte("garbage from a dead process"), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := state.AcquireOperation("update")
	if err != nil {
		t.Fatalf("a stale lock must be replaced: %v", err)
	}
	release()
	if _, err := os.Stat(state.OperationLock()); err != nil {
		t.Fatalf("the stable lock path must remain after release: %v", err)
	}
}

func TestOperationLockFailuresKeepTheirCauseClass(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code string
	}{
		{name: "unsupported platform", err: operationlock.ErrUnsupportedPlatform, code: contracts.CodeOperationLockUnsupported},
		{name: "filesystem I/O", err: fmt.Errorf("%w: %w", operationlock.ErrIO, &os.PathError{Op: "open", Path: "operation.lock", Err: os.ErrPermission}), code: contracts.CodeHostStateDirUnwritable},
		{name: "unknown cause", err: errors.New("unclassified lock failure"), code: "KB_RUNTIME_UNEXPECTED"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "launcher", "operation.lock")
			failure := operationLockFailure(State{Dir: filepath.Dir(path)}, path, test.err)
			if failure.Code != test.code {
				t.Fatalf("diagnostic code = %s; want %s", failure.Code, test.code)
			}
			if !errors.Is(failure, test.err) {
				t.Fatalf("diagnostic does not preserve cause %v", test.err)
			}
			if test.name == "unsupported platform" &&
				(!strings.Contains(failure.Message, "Linux and macOS") || strings.Contains(failure.Hint, "permission") || strings.Contains(failure.Hint, "disk")) {
				t.Fatalf("unsupported platform diagnosis is misleading: %#v", failure)
			}
		})
	}
}
