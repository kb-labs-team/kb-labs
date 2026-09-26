package host

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

// pidRecord is the host.pid file. It is the only cross-process handle on the
// host: stop and status from another launcher invocation rely on it.
type pidRecord struct {
	PID       int       `json:"pid"`
	StartedAt time.Time `json:"startedAt"`
	HealthURL string    `json:"healthUrl"`
	Command   string    `json:"command"`
}

// ProcessRunner spawns the host command directly in its own process group,
// records a pid file and log under the state home, polls the health URL, and
// stops it with a graceful terminate followed by a kill after the grace period.
type ProcessRunner struct {
	Spec  Spec
	State State
	// HTTP and PollInterval exist for tests; zero values use sane defaults.
	HTTP         *http.Client
	PollInterval time.Duration

	mu      sync.Mutex
	pid     int
	exited  chan struct{}
	waitErr error
}

func (r *ProcessRunner) Name() string { return "process" }

func (r *ProcessRunner) interval() time.Duration {
	if r.PollInterval > 0 {
		return r.PollInterval
	}
	return 100 * time.Millisecond
}

func (r *ProcessRunner) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: time.Second}
}

// Start launches the host and returns once its health URL answers 2xx.
func (r *ProcessRunner) Start(ctx context.Context) (Info, error) {
	if err := r.State.Ensure(); err != nil {
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	if record, ok := r.readPID(); ok {
		if processAlive(record.PID) {
			return Info{}, hostError("KB_HOST_ALREADY_RUNNING", "The KB Labs host is already running.", "Use \"kb-create status\" or \"kb-create restart\".", nil, pidDetail(record.PID))
		}
		_ = os.Remove(r.State.HostPID())
	}
	address := r.Spec.HealthAddress()
	if conn, err := net.DialTimeout("tcp", address, 300*time.Millisecond); err == nil {
		_ = conn.Close()
		_, port, _ := net.SplitHostPort(address)
		return Info{}, hostError("KB_HOST_PORT_IN_USE", "Port "+port+" is used by another application.", "Stop the application that uses the port, or change the host port in the installation config, then run \"kb-create start\" again.", nil, map[string]string{"port": port, "address": address})
	}
	logFile, err := os.OpenFile(r.State.HostLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	cmd := exec.Command(r.Spec.Command, r.Spec.Args...)
	cmd.Dir = r.Spec.WorkingDir
	cmd.Env = os.Environ()
	for key, value := range r.Spec.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Stdout, cmd.Stderr = logFile, logFile
	configureHostProcess(cmd)
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return Info{}, r.startFailed(err)
	}
	exited := make(chan struct{})
	r.mu.Lock()
	r.pid, r.exited, r.waitErr = cmd.Process.Pid, exited, nil
	r.mu.Unlock()
	go func() {
		err := cmd.Wait()
		_ = logFile.Close()
		r.mu.Lock()
		r.waitErr = err
		r.mu.Unlock()
		close(exited)
	}()
	record := pidRecord{PID: cmd.Process.Pid, StartedAt: time.Now().UTC(), HealthURL: r.Spec.HealthURL, Command: r.Spec.Command}
	if err := writeJSONFile(r.State.HostPID(), record); err != nil {
		r.kill(cmd.Process.Pid)
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	if err := r.waitReady(ctx, record.PID, exited); err != nil {
		return Info{}, err
	}
	return Info{Runner: r.Name(), PID: record.PID, HealthURL: r.Spec.HealthURL}, nil
}

func (r *ProcessRunner) startFailed(cause error) *contracts.LauncherError {
	return hostError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", cause, map[string]string{"log": r.State.HostLog()})
}

func (r *ProcessRunner) waitReady(ctx context.Context, pid int, exited <-chan struct{}) error {
	deadline := time.NewTimer(r.Spec.ReadyTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(r.interval())
	defer ticker.Stop()
	for {
		if r.healthy(ctx) {
			return nil
		}
		select {
		case <-exited:
			_ = os.Remove(r.State.HostPID())
			r.mu.Lock()
			cause := r.waitErr
			r.mu.Unlock()
			if cause == nil {
				cause = fmt.Errorf("process exited with status 0")
			}
			return r.startFailed(fmt.Errorf("host exited before it became healthy: %w", cause))
		case <-deadline.C:
			r.kill(pid)
			return r.startFailed(fmt.Errorf("host did not become healthy within %s", r.Spec.ReadyTimeout))
		case <-ctx.Done():
			// A host that became healthy just as the caller cancelled is up;
			// the caller decides whether to stop it.
			if r.healthy(context.Background()) {
				return nil
			}
			r.kill(pid)
			return r.startFailed(ctx.Err())
		case <-ticker.C:
		}
	}
}

// kill force-terminates a host that failed to become ready and clears its pid file.
func (r *ProcessRunner) kill(pid int) {
	killProcessGroup(pid)
	r.waitGone(pid, 5*time.Second)
	_ = os.Remove(r.State.HostPID())
}

func (r *ProcessRunner) healthy(ctx context.Context) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Spec.HealthURL, nil)
	if err != nil {
		return false
	}
	response, err := r.client().Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode >= 200 && response.StatusCode < 300
}

// Stop terminates the recorded host: graceful first, kill after the grace
// period. Stopping a host that is not running succeeds with WasRunning=false.
func (r *ProcessRunner) Stop(ctx context.Context) (StopResult, error) {
	result := StopResult{Runner: r.Name()}
	record, ok := r.readPID()
	if !ok || !processAlive(record.PID) {
		_ = os.Remove(r.State.HostPID())
		return result, nil
	}
	result.WasRunning, result.PID = true, record.PID
	terminateProcessGroup(record.PID)
	if r.waitGoneCtx(ctx, record.PID, r.Spec.StopGrace) {
		result.Graceful = true
		_ = os.Remove(r.State.HostPID())
		return result, nil
	}
	killProcessGroup(record.PID)
	result.Forced = true
	if !r.waitGoneCtx(ctx, record.PID, 5*time.Second) {
		return result, hostError("KB_HOST_STOP_FAILED", fmt.Sprintf("The host process %d did not stop.", record.PID), "Run \"kb-create stop\" again, or end the process manually and remove the stale pid file.", nil, pidDetail(record.PID))
	}
	_ = os.Remove(r.State.HostPID())
	return result, nil
}

func (r *ProcessRunner) waitGone(pid int, timeout time.Duration) bool {
	return r.waitGoneCtx(context.Background(), pid, timeout)
}

// waitGoneCtx waits for pid to disappear. When this runner spawned the process
// its own Wait goroutine reaps it, so the exit channel is authoritative;
// otherwise the pid is polled (the owner of the child reaps it).
func (r *ProcessRunner) waitGoneCtx(ctx context.Context, pid int, timeout time.Duration) bool {
	r.mu.Lock()
	var exited chan struct{}
	if r.pid == pid {
		exited = r.exited
	}
	r.mu.Unlock()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if exited != nil {
			select {
			case <-exited:
				return true
			default:
			}
		} else if !processAlive(pid) {
			return true
		}
		select {
		case <-deadline.C:
			return false
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}

// Status reports the recorded process and its health. A pid file that points
// at a dead process is stale: it is removed and reported as stopped.
func (r *ProcessRunner) Status(ctx context.Context) (Status, error) {
	status := Status{Runner: r.Name(), State: StateStopped, HealthURL: r.Spec.HealthURL}
	record, ok := r.readPID()
	if !ok {
		return status, nil
	}
	if !processAlive(record.PID) {
		_ = os.Remove(r.State.HostPID())
		status.StalePID = true
		return status, nil
	}
	started := record.StartedAt
	status.PID, status.StartedAt = record.PID, &started
	status.Healthy = r.healthy(ctx)
	status.State = StateUnhealthy
	if status.Healthy {
		status.State = StateRunning
	}
	return status, nil
}

// Wait blocks until the process this runner started exits. It is meant for
// foreground supervision and returns immediately when nothing was started here.
func (r *ProcessRunner) Wait(ctx context.Context) error {
	r.mu.Lock()
	exited := r.exited
	r.mu.Unlock()
	if exited == nil {
		return nil
	}
	select {
	case <-exited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *ProcessRunner) readPID() (pidRecord, bool) {
	data, err := os.ReadFile(r.State.HostPID())
	if err != nil {
		return pidRecord{}, false
	}
	var record pidRecord
	if err := json.Unmarshal(data, &record); err != nil || record.PID <= 0 {
		// A corrupt pid file cannot identify a process; treat it as stale.
		_ = os.Remove(r.State.HostPID())
		return pidRecord{}, false
	}
	return record, true
}

// RunForeground starts the host, blocks until ctx is cancelled or the host
// exits, then stops it. It is the direct-host mode of `kb-create start`.
func RunForeground(ctx context.Context, runner *ProcessRunner) error {
	if _, err := runner.Start(ctx); err != nil {
		return err
	}
	_ = runner.Wait(ctx)
	if ctx.Err() == nil {
		// The host exited by itself; nothing left to stop.
		return nil
	}
	_, err := runner.Stop(context.Background())
	return err
}

func writeJSONFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
