// Package supervisor is the long-running launcher process behind
// `kb-create supervise`: it keeps the host up under a Runner and serves the
// local control channel. Autostart (later work) will run this process.
package supervisor

import (
	"context"
	"os"
	"strconv"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
)

// Supervisor owns one host Runner and one control server.
type Supervisor struct {
	Runner  host.Runner
	State   host.State
	Version string
}

// Run starts the host, publishes the control channel and blocks until ctx is
// cancelled; it then stops the host gracefully and removes its state files.
// A second supervisor for the same state home fails with KB_HOST_ALREADY_RUNNING.
func (s *Supervisor) Run(ctx context.Context) error {
	if err := s.State.Ensure(); err != nil {
		return contracts.NewLauncherError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+s.State.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	if pid, ok := s.livePID(); ok {
		e := contracts.NewLauncherError("KB_HOST_ALREADY_RUNNING", "The KB Labs host is already running.", "Use \"kb-create status\" or \"kb-create restart\".", nil)
		e.Details = map[string]string{"pid": strconv.Itoa(pid)}
		return e
	}
	if err := os.WriteFile(s.State.SupervisorPID(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
		return contracts.NewLauncherError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+s.State.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	defer os.Remove(s.State.SupervisorPID())
	if _, err := s.Runner.Start(ctx); err != nil {
		return err
	}
	server := &control.Server{Runner: s.Runner, State: s.State, Version: s.Version}
	if err := server.Start(); err != nil {
		_, _ = s.Runner.Stop(context.Background())
		return contracts.NewLauncherError("KB_HOST_CONTROL_UNAVAILABLE", "The launcher control channel is unavailable.", "Start the launcher or the desktop shell.", err)
	}
	<-ctx.Done()
	// Close the channel first so no restart races the shutdown stop.
	_ = server.Close()
	_, err := s.Runner.Stop(context.Background())
	return err
}

// livePID returns the pid of a running supervisor for this state home.
func (s *Supervisor) livePID() (int, bool) { return LivePID(s.State) }

// LivePID reads supervisor.pid and reports the pid when that process is alive.
// A pid file that points at a dead process is stale and is removed.
func LivePID(state host.State) (int, bool) {
	data, err := os.ReadFile(state.SupervisorPID())
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || !host.ProcessAlive(pid) {
		_ = os.Remove(state.SupervisorPID())
		return 0, false
	}
	return pid, true
}
