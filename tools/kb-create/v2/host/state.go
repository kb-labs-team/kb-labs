package host

import (
	"os"
	"path/filepath"
)

// StateHomeEnv overrides the launcher state directory (tests, sandboxes).
const StateHomeEnv = "KB_CREATE_STATE_HOME"

// State names the files the launcher owns in its state home. There is no
// package-level state: every component receives a State value.
type State struct{ Dir string }

// StateFor resolves the state home: $KB_CREATE_STATE_HOME when set, else
// <platformRoot>/.kb/v2/state.
func StateFor(platformRoot string) State {
	if override := os.Getenv(StateHomeEnv); override != "" {
		return State{Dir: override}
	}
	return State{Dir: filepath.Join(platformRoot, ".kb", "v2", "state")}
}

func (s State) HostPID() string        { return filepath.Join(s.Dir, "host.pid") }
func (s State) HostLog() string        { return filepath.Join(s.Dir, "host.log") }
func (s State) SupervisorPID() string  { return filepath.Join(s.Dir, "supervisor.pid") }
func (s State) SupervisorLog() string  { return filepath.Join(s.Dir, "supervisor.log") }
func (s State) Control() string        { return filepath.Join(s.Dir, "control.json") }
func (s State) UpdateRequests() string { return filepath.Join(s.Dir, "update-requests.json") }

// Ensure creates the state directory with owner-only permissions.
func (s State) Ensure() error { return os.MkdirAll(s.Dir, 0o700) }
