package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/operationlock"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

// KBHomeEnv explicitly overrides the installation-owned KB Labs home.
const KBHomeEnv = contracts.KBHomeEnv

// State names the per-installation host lifecycle files.
type State struct{ Dir string }

// StateForRoot returns lifecycle files inside the installation container so
// the running host record survives a switch between immutable version roots.
func StateForRoot(platformRoot string) (State, error) {
	if strings.TrimSpace(platformRoot) == "" {
		return State{}, fmt.Errorf("platform root is empty")
	}
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return State{}, fmt.Errorf("resolve platform root for lifecycle state: %w", err)
	}
	return State{Dir: layout.HostStateDir()}, nil
}

// KBHome resolves the explicitly overridden home or the installation-owned home.
func KBHome(platformRoot string) (string, error) {
	if override := strings.TrimSpace(os.Getenv(KBHomeEnv)); override != "" {
		return override, nil
	}
	return DefaultKBHome(platformRoot)
}

// DefaultKBHome returns the installation-owned home, independent of the environment.
func DefaultKBHome(platformRoot string) (string, error) {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return "", fmt.Errorf("resolve the installation home: %w", err)
	}
	return contracts.KBHomeDirectory(layout.Root), nil
}

// StateHome resolves the per-user launcher state directory.
func StateHome(platformRoot string) (State, error) {
	root, err := KBHome(platformRoot)
	if err != nil {
		return State{}, contracts.NewDiag(contracts.CodeHostStateDirUnwritable, "Cannot resolve the launcher state directory.", "Set KB_HOME to a writable directory.", err)
	}
	return State{Dir: filepath.Join(root, "launcher")}, nil
}

func (s State) HostPID() string { return filepath.Join(s.Dir, "host.pid") }
func (s State) HostLog() string {
	residue, _ := contracts.HostLogFileNames()
	return filepath.Join(s.Dir, residue)
}

// HostStructuredLog is the base path of the host's bounded structured log; the
// platform logger adapter owns its rotation (host.jsonl, host.jsonl.1 …).
func (s State) HostStructuredLog() string {
	_, structured := contracts.HostLogFileNames()
	return filepath.Join(s.Dir, structured)
}
func (s State) LauncherLog() string    { return filepath.Join(s.Dir, "launcher.log") }
func (s State) SupervisorPID() string  { return filepath.Join(s.Dir, "supervisor.pid") }
func (s State) SupervisorLog() string  { return filepath.Join(s.Dir, "supervisor.log") }
func (s State) Control() string        { return filepath.Join(s.Dir, "control.json") }
func (s State) HostExit() string       { return filepath.Join(s.Dir, "host-exit.json") }
func (s State) UpdateRequests() string { return filepath.Join(s.Dir, "update-requests.json") }
func (s State) OperationLock() string  { return operationlock.Path(s.Dir) }

// Ensure creates the state directory with owner-only permissions.
func (s State) Ensure() error { return os.MkdirAll(s.Dir, 0o700) }

func (s State) unwritable(cause error) *diag.Diag {
	return contracts.NewDiag(contracts.CodeHostStateDirUnwritable, "Cannot write to the state directory "+s.Dir+".", "Fix the directory permissions or free disk space.", cause)
}

// AcquireOperation takes the kernel-owned per-installation lifecycle lock so two
// launchers never mutate the same installation at once. Its persistent file is
// only descriptive metadata; process exit releases the descriptor lock. The
// returned function releases it and is safe to call more than once.
func (s State) AcquireOperation(operation string) (func(), error) {
	if err := s.Ensure(); err != nil {
		return nil, s.unwritable(err)
	}
	path := s.OperationLock()
	lease, err := operationlock.Acquire(path, operation)
	if err == nil {
		return lease.Release, nil
	}
	return nil, operationLockFailure(s, path, err)
}

func operationLockFailure(state State, path string, cause error) *diag.Diag {
	switch {
	case errors.Is(cause, operationlock.ErrInProgress):
		holder, hasHolder := operationlock.Holder(path)
		process := "unknown"
		if hasHolder {
			process = strconv.Itoa(holder)
		}
		failure := contracts.NewDiag(contracts.CodeOperationInProgress, fmt.Sprintf("Another launcher operation is already running (process %s).", process), "Wait for it to finish, then rerun the command.", nil)
		failure.Meta = map[string]any{"pid": process, "path": path}
		return failure
	case errors.Is(cause, operationlock.ErrUnsupportedPlatform):
		return contracts.NewDiag(contracts.CodeOperationLockUnsupported,
			"Installation operation locks are supported only on Linux and macOS.",
			"Run this command on a Linux or macOS host.", cause)
	case errors.Is(cause, operationlock.ErrIO):
		return state.unwritable(cause)
	default:
		return diag.Wrap(cause, "KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.", diag.WithHint("Re-run with --debug and include the correlationId in a report."))
	}
}
