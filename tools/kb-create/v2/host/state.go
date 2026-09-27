package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
)

// KBHomeEnv overrides the machine-level KB Labs home (default ~/.kb). It is the
// same variable the TS side uses for the project registry, so one setting
// isolates every per-user file in tests and sandboxes.
const KBHomeEnv = "KB_HOME"

// State names the files the launcher owns in its per-user state home
// (<KB_HOME>/launcher). There is one launcher per user: the platform is a
// per-user install (ADR-0044), so pid files, the control channel and the
// operation lock are not keyed by platform root. There is no package-level
// state: every component receives a State value.
type State struct{ Dir string }

// KBHome resolves the machine-level KB Labs home: $KB_HOME when set, else ~/.kb.
func KBHome() (string, error) {
	if override := strings.TrimSpace(os.Getenv(KBHomeEnv)); override != "" {
		return override, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve the user home directory: %w", err)
	}
	return filepath.Join(home, ".kb"), nil
}

// StateHome resolves the per-user launcher state directory.
func StateHome() (State, error) {
	root, err := KBHome()
	if err != nil {
		return State{}, contracts.NewLauncherError(contracts.CodeHostStateDirUnwritable, "Cannot resolve the launcher state directory.", "Set KB_HOME to a writable directory.", err)
	}
	return State{Dir: filepath.Join(root, "launcher")}, nil
}

func (s State) HostPID() string        { return filepath.Join(s.Dir, "host.pid") }
func (s State) HostLog() string        { return filepath.Join(s.Dir, "host.log") }
func (s State) SupervisorPID() string  { return filepath.Join(s.Dir, "supervisor.pid") }
func (s State) SupervisorLog() string  { return filepath.Join(s.Dir, "supervisor.log") }
func (s State) Control() string        { return filepath.Join(s.Dir, "control.json") }
func (s State) UpdateRequests() string { return filepath.Join(s.Dir, "update-requests.json") }
func (s State) OperationLock() string  { return filepath.Join(s.Dir, "operation.lock") }

// Ensure creates the state directory with owner-only permissions.
func (s State) Ensure() error { return os.MkdirAll(s.Dir, 0o700) }

func (s State) unwritable(cause error) *contracts.LauncherError {
	return contracts.NewLauncherError(contracts.CodeHostStateDirUnwritable, "Cannot write to the state directory "+s.Dir+".", "Fix the directory permissions or free disk space.", cause)
}

// AcquireOperation takes the per-user lifecycle lock so two launchers never
// swap the same installation at once. The lock records the holder's pid; a lock
// whose holder is gone is stale and is replaced. The returned function releases
// it and is safe to call more than once.
func (s State) AcquireOperation(operation string) (func(), error) {
	if err := s.Ensure(); err != nil {
		return nil, s.unwritable(err)
	}
	path := s.OperationLock()
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, writeErr := fmt.Fprintf(file, "%d %s\n", os.Getpid(), operation)
			if err := errors.Join(writeErr, file.Close()); err != nil {
				_ = os.Remove(path)
				return nil, s.unwritable(err)
			}
			released := false
			return func() {
				if !released {
					released = true
					_ = os.Remove(path)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, s.unwritable(err)
		}
		if holder, alive := s.lockHolder(); alive {
			failure := contracts.NewLauncherError(contracts.CodeOperationInProgress, fmt.Sprintf("Another launcher operation is already running (process %d).", holder), "Wait for it to finish; if no launcher is running, remove the stale lock file "+path+".", nil)
			failure.Details = map[string]string{"pid": strconv.Itoa(holder), "path": path}
			return nil, failure
		}
		_ = os.Remove(path)
	}
	return nil, contracts.NewLauncherError(contracts.CodeOperationInProgress, "Another launcher operation is already running.", "Wait for it to finish; if no launcher is running, remove the stale lock file "+path+".", nil)
}

func (s State) lockHolder() (int, bool) {
	data, err := os.ReadFile(s.OperationLock())
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, false
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil || !processAlive(pid) {
		return 0, false
	}
	return pid, true
}
