package v2cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/versionroot"
)

// hostCommand carries everything a host lifecycle command needs; nothing is
// read from package state.
type hostCommand struct {
	PlatformRoot          string
	Foreground            bool
	Executable            string // launcher binary re-executed by `start` to run `supervise`
	Version               string
	Err                   io.Writer
	identityReader        func(int) (string, error)
	testSupervisorHealthy func(context.Context, host.State) bool
	testBackstopGrace     time.Duration
	Interrupt             bool
}

type hostCommandResult map[string]any

func executeHostStart(ctx context.Context, command hostCommand) (hostCommandResult, *diag.Diag) {
	return command.run(ctx, "start", command.start)
}

func executeHostStop(ctx context.Context, command hostCommand) (hostCommandResult, *diag.Diag) {
	return command.run(ctx, "stop", command.stop)
}

func executeHostRestart(ctx context.Context, command hostCommand) (hostCommandResult, *diag.Diag) {
	return command.run(ctx, "restart", command.restart)
}

func executeHostSupervise(ctx context.Context, command hostCommand) (hostCommandResult, *diag.Diag) {
	return command.run(ctx, "start", command.supervise)
}

// setup resolves the installation state and the runner of the installation.
func (c hostCommand) setup(runnerOperation string) (*host.ProcessRunner, host.State, *diag.Diag) {
	if c.PlatformRoot == "" {
		return nil, host.State{}, contracts.NewDiag(contracts.CodeInputRequired, "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil)
	}
	layout, layoutErr := versionroot.ForPlatformPath(c.PlatformRoot)
	if runnerOperation == "stop" {
		runner, runnerErr := host.NewRecordedRunner(c.PlatformRoot)
		if runnerErr != nil {
			return nil, host.State{}, asDiag(runnerErr)
		}
		return runner, runner.State, nil
	}
	if layoutErr == nil {
		if runnerOperation == "restart" {
			layoutErr = layout.ValidateStructure()
		} else {
			layoutErr = layout.Validate()
		}
	}
	if layoutErr != nil {
		return nil, host.State{}, unsupportedPlatformLayout(c.PlatformRoot, layoutErr)
	}
	runner, err := host.NewRunner(c.PlatformRoot)
	if err != nil {
		return nil, host.State{}, asDiag(err)
	}
	if _, err := (secrets.Store{PlatformRoot: c.PlatformRoot}).BootstrapCompleted(); err != nil {
		return nil, host.State{}, asDiag(err)
	}
	return runner, runner.State, nil
}

func (c hostCommand) run(ctx context.Context, runnerOperation string, action func(context.Context, *host.ProcessRunner, host.State) (hostCommandResult, *diag.Diag)) (hostCommandResult, *diag.Diag) {
	runner, state, failure := c.setup(runnerOperation)
	if failure != nil {
		return nil, failure
	}
	runner.Operation = runnerOperation
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	return action(ctx, runner, state)
}

func (c hostCommand) start(ctx context.Context, process *host.ProcessRunner, state host.State) (hostCommandResult, *diag.Diag) {
	if c.Foreground {
		// Direct host: no control channel, the host is a child of this process
		// and stops when the launcher is interrupted.
		if err := host.RunForeground(ctx, process); err != nil {
			return nil, asDiag(err)
		}
		return nil, nil
	}
	status, statusErr := process.Status(ctx)
	if statusErr != nil {
		return nil, startStatusDiagnostic(statusErr)
	}
	if status.State != host.StateStopped {
		command := contracts.ShellCommand("kb-create", "status", "--platform-root", c.PlatformRoot)
		failure := contracts.NewDiag(contracts.CodeHostAlreadyRunning, "The KB Labs host is already running.", "Use `"+command+"` to inspect it.", nil)
		failure.Meta = map[string]any{"nextCommand": command}
		return nil, failure
	}
	if record, alive := activeLauncher(state); alive {
		return nil, supervisor.Refusal(record, process.InstallRoot)
	}
	if pid, alive := supervisor.LivePID(state, process.InstallRoot); alive {
		command := contracts.ShellCommand("kb-create", "status", "--platform-root", c.PlatformRoot)
		e := contracts.NewDiag(contracts.CodeHostAlreadyRunning, "The KB Labs host is already running.", "Use `"+command+"` to inspect it.", nil)
		e.Meta = map[string]any{"supervisorPid": fmt.Sprint(pid), "nextCommand": command}
		return nil, e
	}
	startupDeadline := time.Now().Add(process.Spec.ReadyTimeout)
	info, err := c.spawnSupervisorUntil(ctx, process, state, startupDeadline)
	if err != nil {
		return nil, asDiag(err)
	}
	return hostCommandResult(map[string]any{"ok": true, "operation": "start", "host": info}), nil
}

func startStatusDiagnostic(err error) *diag.Diag {
	return asDiag(err)
}

// spawnSupervisor re-executes this binary as `supervise`, detached, and waits
// until the host is healthy or the supervisor gave up. The supervisor reports
// its startup failure as a JSON envelope on stdout, captured in supervisor.log.
func (c hostCommand) spawnSupervisor(ctx context.Context, process *host.ProcessRunner, state host.State) (host.Info, error) {
	return c.spawnSupervisorUntil(ctx, process, state, time.Now().Add(process.Spec.ReadyTimeout))
}

func (c hostCommand) spawnSupervisorUntil(ctx context.Context, process *host.ProcessRunner, state host.State, startupDeadline time.Time) (host.Info, error) {
	if err := state.Ensure(); err != nil {
		return host.Info{}, contracts.NewDiag("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+state.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	executable := c.Executable
	if executable == "" {
		var err error
		if executable, err = os.Executable(); err != nil {
			return host.Info{}, host.StartFailure(state, err, map[string]string{"nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot)})
		}
	}
	logFile, err := os.OpenFile(state.SupervisorLog(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return host.Info{}, contracts.NewDiag("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+state.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	defer logFile.Close()
	cmd := exec.Command(executable, "supervise", "--json", "--platform-root", c.PlatformRoot)
	started := time.Now()
	backstopGrace := stopBudget(process)
	if c.testBackstopGrace > 0 {
		backstopGrace = c.testBackstopGrace
	}
	backstopDeadline := startupDeadline.Add(backstopGrace)
	identityToken, err := host.NewProcessIdentityToken()
	if err != nil {
		return host.Info{}, contracts.NewDiag(contracts.CodeHostStateDirUnwritable, "The supervisor process identity could not be created.", "Check that system randomness is available, then run `"+contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot)+"`.", err)
	}
	cmd.Env = host.ProcessEnvironmentWithStartupDeadline(host.ProcessEnvironmentWithIdentity(os.Environ(), identityToken), startupDeadline)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := child.Start(cmd, child.Detached); err != nil {
		return host.Info{}, host.StartFailure(state, err, map[string]string{"supervisorLog": state.SupervisorLog(), "nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot)})
	}
	exited := make(chan struct{})
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait(); close(exited) }()
	identityStatus := host.WaitForProcessIdentityWithReader(cmd.Process.Pid, identityToken, exited, backstopDeadline, c.identityReader)
	switch identityStatus {
	case host.ProcessIdentityMatch:
	case host.ProcessIdentityMismatch:
		select {
		case <-exited:
			return host.Info{}, c.supervisorExited(state, process, <-waitErr, time.Since(started))
		default:
		}
		killErr := host.TerminateAndReapLaunchedProcess(cmd.Process, exited)
		if errors.Is(killErr, os.ErrProcessDone) {
			<-exited
			return host.Info{}, c.supervisorExited(state, process, <-waitErr, time.Since(started))
		}
		if killErr != nil {
			if _, cleanupErr := halt(ctx, process, state); cleanupErr != nil {
				return host.Info{}, cleanupErr
			}
			if cleanupErr := removeSupervisorControl(state); cleanupErr != nil {
				return host.Info{}, cleanupErr
			}
			return host.Info{}, host.StartFailure(state, fmt.Errorf("started supervisor identity did not match and the direct child could not be terminated: %w", killErr), map[string]string{"supervisorLog": state.SupervisorLog(), "nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot)})
		}
		if _, cleanupErr := halt(ctx, process, state); cleanupErr != nil {
			return host.Info{}, cleanupErr
		}
		if cleanupErr := removeSupervisorControl(state); cleanupErr != nil {
			return host.Info{}, cleanupErr
		}
		return host.Info{}, host.StartFailure(state, errors.New("started supervisor process identity does not match its launch token"), map[string]string{"supervisorLog": state.SupervisorLog(), "nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot)})
	case host.ProcessIdentityUndetermined:
		select {
		case <-exited:
			return host.Info{}, c.supervisorExited(state, process, <-waitErr, time.Since(started))
		default:
			return host.Info{}, c.supervisorHung(state, process, cmd.Process, exited, waitErr, started)
		}
	default:
		return host.Info{}, host.StartFailure(state, errors.New("started supervisor process identity result is invalid"), map[string]string{"supervisorLog": state.SupervisorLog(), "nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot)})
	}
	deadline := time.NewTimer(time.Until(backstopDeadline))
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if c.supervisorHealthyNow(ctx, state) {
			status, statusErr := process.Status(ctx)
			if statusErr == nil && status.State == host.StateRunning {
				return host.Info{Runner: process.Name(), PID: status.PID, HealthURL: process.Spec.HealthURL}, nil
			}
		}
		select {
		case <-exited:
			return host.Info{}, c.supervisorExited(state, process, <-waitErr, time.Since(started))
		case <-deadline.C:
			return host.Info{}, c.supervisorHung(state, process, cmd.Process, exited, waitErr, started)
		case <-ctx.Done():
			return host.Info{}, c.supervisorHung(state, process, cmd.Process, exited, waitErr, started)
		case <-ticker.C:
		}
	}
}

func (c hostCommand) supervisorHealthyNow(ctx context.Context, state host.State) bool {
	if c.testSupervisorHealthy != nil {
		return c.testSupervisorHealthy(ctx, state)
	}
	client, err := control.Connect(state)
	if err != nil {
		return false
	}
	status, err := client.Status(ctx)
	return err == nil && status.Host.State == host.StateRunning
}

func (c hostCommand) supervisorExited(state host.State, process *host.ProcessRunner, exit error, waited time.Duration) error {
	failure := supervisorFailure(state, exit, process.Spec.HealthURL, waited, c.PlatformRoot)
	if _, cleanupErr := halt(context.Background(), process, state); cleanupErr != nil {
		return cleanupErr
	}
	if cleanupErr := removeSupervisorControl(state); cleanupErr != nil {
		return host.StartFailure(state, fmt.Errorf("%v; supervisor control cleanup failed: %w", failure, cleanupErr), map[string]string{
			"controlRecord": state.Control(), "nextCommand": contracts.ShellCommand("kb-create", "status", "--platform-root", c.PlatformRoot),
		})
	}
	return failure
}

func (c hostCommand) supervisorHung(state host.State, process *host.ProcessRunner, child *os.Process, exited <-chan struct{}, waitErr <-chan error, started time.Time) error {
	killErr := host.TerminateAndReapLaunchedProcess(child, exited)
	if errors.Is(killErr, os.ErrProcessDone) {
		return c.supervisorExited(state, process, <-waitErr, time.Since(started))
	}
	_, cleanupErr := halt(context.Background(), process, state)
	if cleanupErr != nil {
		return cleanupErr
	}
	if cleanupErr := removeSupervisorControl(state); cleanupErr != nil {
		return host.StartFailure(state, fmt.Errorf("supervisor cleanup failed: %w", cleanupErr), map[string]string{
			"controlRecord": state.Control(), "nextCommand": contracts.ShellCommand("kb-create", "status", "--platform-root", c.PlatformRoot),
		})
	}
	cause := errors.New("supervisor did not report or exit before the startup cleanup backstop")
	if killErr != nil {
		cause = fmt.Errorf("supervisor did not report or exit before the startup cleanup backstop, and its direct child could not be terminated: %w", killErr)
	}
	return host.StartFailure(state, cause, map[string]string{
		"failureKind": "supervisorHung", "supervisorLog": state.SupervisorLog(),
		"supervisorStderrTail": host.StartupStderrTail(state.SupervisorLog()), "waited": time.Since(started).Round(time.Millisecond).String(),
		"nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", c.PlatformRoot),
	})
}

func removeSupervisorControl(state host.State) error {
	err := os.Remove(state.Control())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("could not remove supervisor control record %s: %w", state.Control(), err)
	}
	return nil
}

// supervisorFailure recovers the envelope the supervisor printed before exiting.
func supervisorFailure(state host.State, exit error, readinessURL string, waited time.Duration, platformRoot string) error {
	file, err := os.Open(state.SupervisorLog())
	if err == nil {
		defer file.Close()
		data, _ := io.ReadAll(file)
		var parsed struct {
			Error *diag.Diag `json:"error"`
		}
		for offset := 0; offset < len(data); offset++ {
			if data[offset] != '{' {
				continue
			}
			if json.Unmarshal(bytes.TrimSpace(data[offset:]), &parsed) == nil && parsed.Error != nil {
				return parsed.Error
			}
		}
	}
	return host.StartFailure(state, fmt.Errorf("supervisor exited before host readiness: %v", exit), map[string]string{
		"supervisorLog": state.SupervisorLog(), "supervisorExit": fmt.Sprint(exit),
		"readinessURL": readinessURL, "waited": waited.Round(time.Millisecond).String(),
		"failureKind": "supervisorExitedWithoutVerdict", "supervisorStderrTail": host.StartupStderrTail(state.SupervisorLog()),
		"nextCommand": contracts.ShellCommand("kb-create", "start", "--platform-root", platformRoot),
	})
}

func (c hostCommand) supervise(ctx context.Context, runner *host.ProcessRunner, state host.State) (hostCommandResult, *diag.Diag) {
	startupDeadline, handedDown, deadlineErr := host.ConsumeStartupDeadlineEnvironment()
	if deadlineErr != nil {
		return nil, asDiag(host.StartFailure(state, deadlineErr, map[string]string{"supervisorLog": state.SupervisorLog()}))
	}
	if handedDown {
		runner.SetStartupDeadline(startupDeadline)
	}
	if err := (&supervisor.Supervisor{Runner: runner, State: state, PlatformRoot: runner.InstallRoot, Version: c.Version}).Run(ctx); err != nil {
		return nil, asDiag(err)
	}
	return nil, nil
}

func (c hostCommand) stop(ctx context.Context, runner *host.ProcessRunner, state host.State) (hostCommandResult, *diag.Diag) {
	result, err := halt(ctx, runner, state)
	if err != nil {
		return nil, asDiag(err)
	}
	return hostCommandResult(map[string]any{"ok": true, "operation": "stop", "stopped": result}), nil
}

// halt stops the supervisor (which stops the host gracefully and removes the
// control channel) and then whatever it left behind, or a foreground host.
func halt(ctx context.Context, runner host.Runner, state host.State) (host.StopResult, error) {
	before, _ := runner.Status(ctx)
	platformRoot := ""
	if process, ok := runner.(*host.ProcessRunner); ok {
		platformRoot = process.InstallRoot
	}
	if record, identityStatus, stale := supervisor.StaleRecord(state); stale {
		if identityStatus == host.ProcessIdentityUndetermined && record.InstallationID != "" {
			return host.StopResult{Runner: runner.Name()}, host.UndeterminedProcessIdentityFailure(state.SupervisorPID(), "supervisor", record.PID, platformRoot, host.GatewayURLForState(state))
		}
		return host.StopResult{Runner: runner.Name()}, host.StaleProcessIdentityFailure(state.SupervisorPID(), "supervisor", record.PID, platformRoot, host.GatewayURLForState(state))
	}
	installationID, identityErr := versionroot.InstallationIDForPath(platformRoot)
	if record, alive := supervisor.ReadRecord(state); alive && identityErr == nil && record.InstallationID == installationID {
		if host.TerminateProcessIfIdentity(record.PID, record.ProcessIdentity) && !waitExit(record.PID, record.ProcessIdentity, stopBudget(runner)) {
			host.KillProcessIfIdentity(record.PID, record.ProcessIdentity)
			waitExit(record.PID, record.ProcessIdentity, 5*time.Second)
		}
	}
	result, err := runner.Stop(ctx)
	if err != nil {
		return result, err
	}
	result.WasRunning = result.WasRunning || before.State != host.StateStopped
	if result.WasRunning && !result.Forced {
		result.Graceful = true
	}
	return result, nil
}

func stopBudget(runner host.Runner) time.Duration {
	if process, ok := runner.(*host.ProcessRunner); ok {
		return process.Spec.StopGrace + 5*time.Second
	}
	return 15 * time.Second
}

func waitExit(pid int, processIdentity string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		switch host.ProcessIdentityOf(pid, processIdentity) {
		case host.ProcessIdentityMatch:
		case host.ProcessIdentityMismatch:
			return true
		case host.ProcessIdentityUndetermined:
			if !host.ProcessAlive(pid) {
				return true
			}
		default:
			if !host.ProcessAlive(pid) {
				return true
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	switch host.ProcessIdentityOf(pid, processIdentity) {
	case host.ProcessIdentityMatch:
		return false
	case host.ProcessIdentityMismatch:
		return true
	case host.ProcessIdentityUndetermined:
		return !host.ProcessAlive(pid)
	default:
		return !host.ProcessAlive(pid)
	}
}

func (c hostCommand) restart(ctx context.Context, runner *host.ProcessRunner, state host.State) (hostCommandResult, *diag.Diag) {
	if record, identityStatus, stale := supervisor.StaleRecord(state); stale {
		if identityStatus == host.ProcessIdentityUndetermined && record.InstallationID != "" {
			return nil, host.UndeterminedProcessIdentityFailure(state.SupervisorPID(), "supervisor", record.PID, c.PlatformRoot, host.GatewayURLForState(state))
		}
		return nil, host.StaleProcessIdentityFailure(state.SupervisorPID(), "supervisor", record.PID, c.PlatformRoot, host.GatewayURLForState(state))
	}
	// The supervisor owns the host control credential and must approve the stop.
	client, connectErr := control.Connect(state)
	if connectErr != nil {
		return nil, asDiag(host.HostUnreachable(runner.Spec.HealthURL, connectErr))
	}
	response, restartErr := client.Restart(ctx, c.Interrupt)
	if restartErr != nil {
		return nil, asDiag(restartErr)
	}
	return hostCommandResult(map[string]any{"ok": true, "operation": "restart", "stopped": response.Stopped, "host": response.Host}), nil
}

// lifecycleHost is the supervised host as the swap operations see it. Both
// calls build their runner from the receipt as it is at that moment, so a
// Resume after an update starts the new version and after a restore the old.
type lifecycleHost struct {
	command hostCommand
	state   host.State
}

func (h lifecycleHost) Halt(ctx context.Context) (bool, error) {
	runner, err := host.NewRunner(h.command.PlatformRoot)
	if err != nil {
		return false, err
	}
	result, err := halt(ctx, runner, runner.State)
	return result.WasRunning, err
}

func (h lifecycleHost) Resume(ctx context.Context) error {
	runner, err := host.NewRunner(h.command.PlatformRoot)
	if err != nil {
		return err
	}
	_, err = h.command.spawnSupervisor(ctx, runner, runner.State)
	return err
}

func asDiag(err error) *diag.Diag {
	if errors.Is(err, secrets.ErrUnsupportedSecretStoreFormat) {
		return contracts.NewDiag(contracts.CodeSecretStoreUnsupported,
			"The platform secret state uses a format this launcher cannot safely read.",
			"Preserve the existing platform root, then run `kb-create install --platform-root NEW_ROOT` with a new empty path.", nil)
	}
	if errors.Is(err, secrets.ErrBootstrapCredentialLocked) {
		return contracts.NewDiag(contracts.CodeBootstrapCredentialLocked,
			"The first-administrator credential cannot be replaced after bootstrap completes.",
			"Stop the host, then run `kb-create doctor --platform-root <platform-root> --recover --email <email> --generate --yes`; restart with `kb-create start --platform-root <platform-root>`.", nil)
	}
	var typed *diag.Diag
	if errors.As(err, &typed) {
		return typed
	}
	return contracts.NewDiag("KB_RUNTIME_UNEXPECTED", "The launcher failed to process the request.", "Read the launcher log in the state directory.", err)
}
