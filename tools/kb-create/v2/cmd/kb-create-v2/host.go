package v2cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/supervisor"
)

// hostOperations are the host lifecycle commands. `status` is shared with the
// pre-existing receipt verification and is routed by runStatus.
func isHostOperation(operation string) bool {
	switch operation {
	case "start", "stop", "restart", "supervise":
		return true
	}
	return false
}

// hostCommand carries everything a host lifecycle command needs; nothing is
// read from package state.
type hostCommand struct {
	PlatformRoot string
	KBDev        string
	Foreground   bool
	JSON         bool
	Executable   string // launcher binary re-executed by `start` to run `supervise`
	Version      string
	Out          io.Writer
	Err          io.Writer
}

func (c hostCommand) run(operation string) int {
	if c.PlatformRoot == "" {
		return c.fail(2, contracts.NewLauncherError(contracts.CodeInputRequired, "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil))
	}
	runner, err := host.Select(c.PlatformRoot, c.KBDev)
	if err != nil {
		return c.fail(2, asLauncherError(err))
	}
	state := host.StateFor(c.PlatformRoot)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch operation {
	case "start":
		return c.start(ctx, runner, state)
	case "stop":
		return c.stop(ctx, runner, state)
	case "restart":
		return c.restart(ctx, runner, state)
	case "supervise":
		return c.supervise(ctx, runner, state)
	}
	return c.fail(2, contracts.NewLauncherError(contracts.CodeOperationInvalid, "operation is not supported", "use start, stop, status, restart or supervise", nil))
}

// hostStatus implements `status` for installations that declare a host spec.
// It reports whether it handled the request so kb-dev installations keep the
// original receipt verification output.
func (c hostCommand) hostStatus(ctx context.Context, runner host.Runner, state host.State) int {
	status, err := runner.Status(ctx)
	if err != nil {
		return c.fail(1, asLauncherError(err))
	}
	payload := map[string]any{"ok": true, "operation": "status", "host": status}
	if pid, ok := supervisor.LivePID(state); ok {
		info := map[string]any{"pid": pid}
		if client, connectErr := control.Connect(state); connectErr == nil {
			info["address"] = client.File.Address
			info["version"] = client.File.Version
		}
		payload["supervisor"] = info
	}
	if status.State == host.StateUnhealthy {
		return c.failWith(1, contracts.NewLauncherError("KB_HOST_UNHEALTHY", "The host responds but is unhealthy.", "Run \"kb-create restart\" or \"kb-create doctor\".", nil), payload)
	}
	return c.succeed(payload, fmt.Sprintf("host %s (pid %d, %s)", status.State, status.PID, status.Runner))
}

func (c hostCommand) start(ctx context.Context, runner host.Runner, state host.State) int {
	process, isProcess := runner.(*host.ProcessRunner)
	if !isProcess {
		// kb-dev owns its own daemons; there is nothing to supervise.
		info, err := runner.Start(ctx)
		if err != nil {
			return c.fail(1, asLauncherError(err))
		}
		return c.succeed(map[string]any{"ok": true, "operation": "start", "host": info}, "host started ("+info.Runner+")")
	}
	if c.Foreground {
		// Direct host: no control channel, the host is a child of this process
		// and stops when the launcher is interrupted.
		if err := host.RunForeground(ctx, process); err != nil {
			return c.fail(1, asLauncherError(err))
		}
		return 0
	}
	status, _ := runner.Status(ctx)
	if status.State != host.StateStopped {
		return c.fail(1, contracts.NewLauncherError("KB_HOST_ALREADY_RUNNING", "The KB Labs host is already running.", "Use \"kb-create status\" or \"kb-create restart\".", nil))
	}
	if pid, alive := supervisor.LivePID(state); alive {
		e := contracts.NewLauncherError("KB_HOST_ALREADY_RUNNING", "The KB Labs host is already running.", "Use \"kb-create status\" or \"kb-create restart\".", nil)
		e.Details = map[string]string{"supervisorPid": fmt.Sprint(pid)}
		return c.fail(1, e)
	}
	info, err := c.spawnSupervisor(ctx, process, state)
	if err != nil {
		return c.fail(1, asLauncherError(err))
	}
	return c.succeed(map[string]any{"ok": true, "operation": "start", "host": info}, fmt.Sprintf("host started (pid %d)", info.PID))
}

// spawnSupervisor re-executes this binary as `supervise`, detached, and waits
// until the host is healthy or the supervisor gave up. The supervisor reports
// its startup failure as a JSON envelope on stdout, captured in supervisor.log.
func (c hostCommand) spawnSupervisor(ctx context.Context, process *host.ProcessRunner, state host.State) (host.Info, error) {
	if err := state.Ensure(); err != nil {
		return host.Info{}, contracts.NewLauncherError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+state.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	executable := c.Executable
	if executable == "" {
		var err error
		if executable, err = os.Executable(); err != nil {
			return host.Info{}, contracts.NewLauncherError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", err)
		}
	}
	logFile, err := os.OpenFile(state.SupervisorLog(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return host.Info{}, contracts.NewLauncherError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+state.Dir+".", "Fix the directory permissions or free disk space.", err)
	}
	defer logFile.Close()
	args := []string{"supervise", "--json", "--platform-root", c.PlatformRoot}
	if c.KBDev != "" {
		args = append(args, "--kb-dev", c.KBDev)
	}
	cmd := exec.Command(executable, args...)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	host.ConfigureDetached(cmd)
	if err := cmd.Start(); err != nil {
		return host.Info{}, contracts.NewLauncherError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	deadline := time.After(process.Spec.ReadyTimeout + 10*time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if client, connectErr := control.Connect(state); connectErr == nil {
			if status, statusErr := client.Status(ctx); statusErr == nil && status.Host.State == host.StateRunning {
				return host.Info{Runner: process.Name(), PID: status.Host.PID, HealthURL: status.Host.HealthURL}, nil
			}
		}
		select {
		case <-exited:
			return host.Info{}, supervisorFailure(state)
		case <-deadline:
			host.KillProcess(cmd.Process.Pid)
			return host.Info{}, contracts.NewLauncherError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", errors.New("supervisor did not report a healthy host in time"))
		case <-ctx.Done():
			host.KillProcess(cmd.Process.Pid)
			return host.Info{}, contracts.NewLauncherError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", ctx.Err())
		case <-ticker.C:
		}
	}
}

// supervisorFailure recovers the envelope the supervisor printed before exiting.
func supervisorFailure(state host.State) error {
	file, err := os.Open(state.SupervisorLog())
	if err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		var last string
		for scanner.Scan() {
			if line := strings.TrimSpace(scanner.Text()); line != "" {
				last = line
			}
		}
		var parsed struct {
			Error *contracts.LauncherError `json:"error"`
		}
		if json.Unmarshal([]byte(last), &parsed) == nil && parsed.Error != nil {
			return parsed.Error
		}
	}
	e := contracts.NewLauncherError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", errors.New("supervisor exited before the host became healthy"))
	e.Details = map[string]string{"log": state.SupervisorLog()}
	return e
}

func (c hostCommand) supervise(ctx context.Context, runner host.Runner, state host.State) int {
	if err := (&supervisor.Supervisor{Runner: runner, State: state, Version: c.Version}).Run(ctx); err != nil {
		return c.fail(1, asLauncherError(err))
	}
	return 0
}

func (c hostCommand) stop(ctx context.Context, runner host.Runner, state host.State) int {
	before, _ := runner.Status(ctx)
	if pid, alive := supervisor.LivePID(state); alive {
		host.TerminateProcess(pid)
		if !waitExit(pid, stopBudget(runner)) {
			host.KillProcess(pid)
			waitExit(pid, 5*time.Second)
		}
	}
	// Whatever the supervisor left behind (or a foreground host) goes now.
	result, err := runner.Stop(ctx)
	if err != nil {
		return c.fail(1, asLauncherError(err))
	}
	result.WasRunning = result.WasRunning || before.State != host.StateStopped
	if result.WasRunning && !result.Forced {
		result.Graceful = true
	}
	message := "host stopped"
	if !result.WasRunning {
		message = "host was not running"
	}
	return c.succeed(map[string]any{"ok": true, "operation": "stop", "stopped": result}, message)
}

func stopBudget(runner host.Runner) time.Duration {
	if process, ok := runner.(*host.ProcessRunner); ok {
		return process.Spec.StopGrace + 5*time.Second
	}
	return 15 * time.Second
}

func waitExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !host.ProcessAlive(pid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !host.ProcessAlive(pid)
}

func (c hostCommand) restart(ctx context.Context, runner host.Runner, state host.State) int {
	// A live supervisor owns the host: restart through its channel so its view
	// of the child stays consistent.
	if client, err := control.Connect(state); err == nil {
		response, restartErr := client.Restart(ctx)
		if restartErr != nil {
			return c.fail(1, asLauncherError(restartErr))
		}
		return c.succeed(map[string]any{"ok": true, "operation": "restart", "stopped": response.Stopped, "host": response.Host}, "host restarted")
	}
	stopped, err := runner.Stop(ctx)
	if err != nil {
		return c.fail(1, asLauncherError(err))
	}
	if process, ok := runner.(*host.ProcessRunner); ok {
		info, startErr := c.spawnSupervisor(ctx, process, state)
		if startErr != nil {
			return c.fail(1, asLauncherError(startErr))
		}
		return c.succeed(map[string]any{"ok": true, "operation": "restart", "stopped": stopped, "host": info}, "host restarted")
	}
	info, err := runner.Start(ctx)
	if err != nil {
		return c.fail(1, asLauncherError(err))
	}
	return c.succeed(map[string]any{"ok": true, "operation": "restart", "stopped": stopped, "host": info}, "host restarted")
}

func asLauncherError(err error) *contracts.LauncherError {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		return typed
	}
	return contracts.NewLauncherError("KB_RUNTIME_UNEXPECTED", "The launcher failed to process the request.", "Read the launcher log in the state directory.", err)
}

func (c hostCommand) succeed(payload map[string]any, human string) int {
	if c.JSON {
		_ = json.NewEncoder(c.Out).Encode(payload)
	} else {
		fmt.Fprintln(c.Out, human)
	}
	return 0
}

func (c hostCommand) fail(code int, failure *contracts.LauncherError) int {
	return c.failWith(code, failure, nil)
}

func (c hostCommand) failWith(code int, failure *contracts.LauncherError, extra map[string]any) int {
	if c.JSON {
		payload := map[string]any{"ok": false, "error": failure}
		for key, value := range extra {
			if key != "ok" {
				payload[key] = value
			}
		}
		_ = json.NewEncoder(c.Out).Encode(payload)
		return code
	}
	fmt.Fprintf(c.Err, "%s: %s\n", failure.Code, failure.Message)
	if failure.Cause != "" {
		fmt.Fprintf(c.Err, "cause: %s\n", failure.Cause)
	}
	fmt.Fprintf(c.Err, "hint: %s\n", failure.Hint)
	return code
}
