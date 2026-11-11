// Package supervisor is the long-running launcher process behind
// `kb-create supervise`: it keeps the host up under a Runner and serves the
// local control channel. Autostart (later work) will run this process.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/versionroot"
)

// Supervisor owns one host Runner and one control server.
type Supervisor struct {
	Runner       host.Runner
	State        host.State
	PlatformRoot string
	Version      string
}

// Run starts the host, publishes the control channel and blocks until ctx is
// cancelled; it then stops the host gracefully and removes its state files.
// A second supervisor for the same installation state fails with KB_HOST_ALREADY_RUNNING.
func (s *Supervisor) Run(ctx context.Context) error {
	if err := s.State.Ensure(); err != nil {
		return contracts.NewDiag("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+s.State.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	if record, exists := readRecordFile(s.State); exists && host.ProcessAlive(record.PID) {
		identityStatus := host.ProcessIdentityOf(record.PID, record.ProcessIdentity)
		switch identityStatus {
		case host.ProcessIdentityMatch:
			if record.InstallationID == "" {
				return host.StaleProcessIdentityFailure(s.State.SupervisorPID(), "supervisor", record.PID, s.PlatformRoot, host.GatewayURLForState(s.State))
			}
			return Refusal(record, s.PlatformRoot)
		case host.ProcessIdentityMismatch:
			return host.StaleProcessIdentityFailure(s.State.SupervisorPID(), "supervisor", record.PID, s.PlatformRoot, host.GatewayURLForState(s.State))
		case host.ProcessIdentityUndetermined:
			return host.UndeterminedProcessIdentityFailure(s.State.SupervisorPID(), "supervisor", record.PID, s.PlatformRoot, host.GatewayURLForState(s.State))
		default:
			return host.StaleProcessIdentityFailure(s.State.SupervisorPID(), "supervisor", record.PID, s.PlatformRoot, host.GatewayURLForState(s.State))
		}
	}
	if record, ok := ReadRecord(s.State); ok {
		e := Refusal(record, s.PlatformRoot)
		return e
	}
	root, err := filepath.Abs(s.PlatformRoot)
	if err != nil {
		return contracts.NewDiag("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot resolve the platform root for the launcher.", "Pass an accessible --platform-root.", err)
	}
	processIdentity, err := host.ProcessIdentityForPID(os.Getpid())
	if err != nil {
		return contracts.NewDiag(contracts.CodeHostStateDirUnwritable, "The supervisor process identity could not be recorded.", "Start the supervisor through `"+contracts.ShellCommand("kb-create", "start", "--platform-root", root)+"` so the launcher supplies its per-start identity token.", err)
	}
	installationID, err := versionroot.InstallationIDForPath(root)
	if err != nil {
		return contracts.NewDiag(contracts.CodeReceiptUnavailable, "The installation ownership identity could not be read.", "Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)+"` and repair its layout before starting the host.", err)
	}
	record := Record{PID: os.Getpid(), ProcessIdentity: processIdentity, InstallationID: installationID, PlatformRoot: filepath.Clean(root)}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := host.WriteRecordFile(s.State.SupervisorPID(), append(data, '\n')); err != nil {
		return contracts.NewDiag("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+s.State.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	defer os.Remove(s.State.SupervisorPID())
	if err := s.prepareHostStart(s.Runner); err != nil {
		return err
	}
	if _, err := s.Runner.Start(ctx); err != nil {
		return err
	}
	server := &control.Server{Runner: s.Runner, State: s.State, Version: s.Version, Restart: s.restart}
	if err := server.Start(); err != nil {
		_, _ = s.Runner.Stop(context.Background())
		return contracts.NewDiag("KB_HOST_CONTROL_UNAVAILABLE", "The launcher control channel is unavailable.", "Start the launcher or the desktop shell.", err)
	}
	<-ctx.Done()
	// Close the channel first so no restart races the shutdown stop.
	_ = server.Close()
	_, err = s.Runner.Stop(context.Background())
	return err
}

func (s *Supervisor) prepareHostStart(runner host.Runner) error {
	process, ok := runner.(*host.ProcessRunner)
	if !ok {
		return nil
	}
	credential, err := host.NewProcessIdentityToken()
	if err != nil {
		return err
	}
	process.ControlCredential = credential
	process.ControlAddress = ""
	return nil
}

func (s *Supervisor) restart(ctx context.Context, interrupt bool) (control.RestartResponse, error) {
	previous, ok := s.Runner.(*host.ProcessRunner)
	if !ok {
		return control.RestartResponse{}, fmt.Errorf("supervisor restart requires the platform process runner")
	}
	if !interrupt {
		items, queryErr := previous.QueryActiveWork(ctx)
		if queryErr != nil {
			return control.RestartResponse{}, queryErr
		}
		if len(items) > 0 {
			interruptCommand := contracts.ShellCommand("kb-create", "restart", "--platform-root", s.PlatformRoot, "--interrupt")
			failure, err := host.RestartWorkInFlight(items, interruptCommand)
			if err != nil {
				return control.RestartResponse{}, err
			}
			return control.RestartResponse{}, failure
		}
	}
	outcome, err := host.RestartWithRecovery(ctx, s.PlatformRoot, previous,
		func(ctx context.Context, runner *host.ProcessRunner) (host.Info, error) {
			if prepareErr := s.prepareHostStart(runner); prepareErr != nil {
				return host.Info{}, prepareErr
			}
			return runner.Start(ctx)
		})
	if outcome.Runner != nil {
		s.Runner = outcome.Runner
	}
	if err != nil {
		return control.RestartResponse{}, err
	}
	return control.RestartResponse{OK: true, Protocol: control.ProtocolVersion, Stopped: outcome.Stopped, Host: outcome.Info}, nil
}

// livePID returns the pid of a running supervisor for this installation state.
// Record identifies the platform root and process held by supervisor.pid.
type Record struct {
	PID             int    `json:"pid"`
	ProcessIdentity string `json:"processIdentity,omitempty"`
	InstallationID  string `json:"installationId"`
	PlatformRoot    string `json:"platformRoot"`
}

// ReadRecord reads supervisor.pid. A dead process is stale and its file is removed.
func ReadRecord(state host.State) (Record, bool) {
	record, ok := readRecordFile(state)
	if !ok {
		return Record{}, false
	}
	if !host.ProcessAlive(record.PID) {
		_ = os.Remove(state.SupervisorPID())
		return Record{}, false
	}
	switch host.ProcessIdentityOf(record.PID, record.ProcessIdentity) {
	case host.ProcessIdentityMatch:
		if record.InstallationID != "" {
			return record, true
		}
	case host.ProcessIdentityMismatch:
	case host.ProcessIdentityUndetermined:
	default:
		return Record{}, false
	}
	return Record{}, false
}

func StaleRecord(state host.State) (Record, host.ProcessIdentityStatus, bool) {
	record, ok := readRecordFile(state)
	if !ok || !host.ProcessAlive(record.PID) {
		return record, host.ProcessIdentityUndetermined, false
	}
	if record.InstallationID == "" {
		return record, host.ProcessIdentityUndetermined, true
	}
	identityStatus := host.ProcessIdentityOf(record.PID, record.ProcessIdentity)
	switch identityStatus {
	case host.ProcessIdentityMatch:
		return Record{}, identityStatus, false
	case host.ProcessIdentityMismatch, host.ProcessIdentityUndetermined:
		return record, identityStatus, true
	default:
		return record, host.ProcessIdentityUndetermined, true
	}
}

func readRecordFile(state host.State) (Record, bool) {
	data, err := os.ReadFile(state.SupervisorPID())
	if err != nil {
		return Record{}, false
	}
	var record Record
	if err := json.Unmarshal(data, &record); err != nil || record.PID <= 0 {
		_ = os.Remove(state.SupervisorPID())
		return Record{}, false
	}
	return record, true
}

// LivePID reports only a supervisor serving the requested platform root.
func LivePID(state host.State, platformRoot string) (int, bool) {
	record, ok := ReadRecord(state)
	if !ok {
		return 0, false
	}
	installationID, err := versionroot.InstallationIDForPath(platformRoot)
	if err != nil {
		return 0, false
	}
	if record.InstallationID != installationID {
		return 0, false
	}
	return record.PID, true
}

func Refusal(record Record, requestedRoot string) *diag.Diag {
	installationID, err := versionroot.InstallationIDForPath(requestedRoot)
	if err == nil && record.InstallationID == installationID {
		command := contracts.ShellCommand("kb-create", "status", "--platform-root", requestedRoot)
		failure := contracts.NewDiag(contracts.CodeHostAlreadyRunning, "The KB Labs host is already running.",
			"Use `"+command+"` to inspect it.", nil)
		failure.Meta = map[string]any{"pid": strconv.Itoa(record.PID), "platformRoot": record.PlatformRoot, "nextCommand": command}
		return failure
	}
	return host.RootConflict(record.PlatformRoot, record.PID)
}
