package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/proc/child"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
)

// pidRecord is the host.pid file. It is the only cross-process handle on the
// host: stop and status from another launcher invocation rely on it.
type pidRecord struct {
	PID             int       `json:"pid"`
	ProcessIdentity string    `json:"processIdentity,omitempty"`
	InstallationID  string    `json:"installationId"`
	PlatformRoot    string    `json:"platformRoot"`
	TreeRoot        string    `json:"treeRoot,omitempty"`
	StartedAt       time.Time `json:"startedAt"`
	HealthURL       string    `json:"healthUrl"`
	Command         string    `json:"command"`
	PlatformVersion string    `json:"platformVersion,omitempty"`
	ReceiptID       string    `json:"receiptId,omitempty"`
	ServiceIDs      []string  `json:"serviceIds,omitempty"`
}

type ProcessIdentity struct {
	InstallationID  string
	PlatformVersion string
	ReceiptID       string
	ServiceIDs      []string
	TreeRoot        string
}

func NewProcessIdentity(active contracts.InstallReceipt, platformRoot, treeRoot string) (ProcessIdentity, error) {
	serviceIDs := make([]string, 0, len(active.Plan.ServiceGraph.Services))
	for _, service := range active.Plan.ServiceGraph.Services {
		serviceIDs = append(serviceIDs, service.ID)
	}
	identity := ProcessIdentity{InstallationID: active.InstallationID, PlatformVersion: active.Plan.ServiceGraph.PlatformVersion,
		ReceiptID: active.ID, ServiceIDs: serviceIDs, TreeRoot: filepath.Clean(treeRoot)}
	if identity.InstallationID == "" || identity.PlatformVersion == "" || identity.ReceiptID == "" || len(identity.ServiceIDs) == 0 || identity.TreeRoot == "." || platformRoot == "" {
		return ProcessIdentity{}, hostError(contracts.CodeReceiptUnavailable, "The active receipt cannot identify a complete running host.",
			"Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", platformRoot)+"` and reinstall the platform if the receipt is incomplete.", nil, map[string]string{"platformRoot": platformRoot})
	}
	return identity, nil
}

func StaleProcessIdentityFailure(recordPath, kind string, pid int, platformRoot, gatewayURL string) *diag.Diag {
	message := fmt.Sprintf("PID %d is running, but its recorded %s process identity is missing or does not match, so it cannot be verified as this installation's recorded %s and may still be serving its Gateway. kb-create did not and will not signal it.", pid, kind, kind)
	return processIdentityFailure(recordPath, kind, pid, platformRoot, gatewayURL, message)
}

func UndeterminedProcessIdentityFailure(recordPath, kind string, pid int, platformRoot, gatewayURL string) *diag.Diag {
	message := fmt.Sprintf("PID %d is running, but kb-create could not read its recorded %s process identity, so it cannot verify whether this installation owns it. It may still be serving its Gateway. kb-create did not and will not signal it.", pid, kind)
	return processIdentityFailure(recordPath, kind, pid, platformRoot, gatewayURL, message)
}

func processIdentityFailure(recordPath, kind string, pid int, platformRoot, gatewayURL, message string) *diag.Diag {
	if gatewayURL == "" {
		gatewayURL = recordedGatewayURL(recordPath)
	}
	if gatewayURL == "" {
		if active, err := receipt.Read(platformRoot); err == nil {
			gatewayURL = active.Verification.HostHealthURL
		}
	}
	checkCommand := contracts.ShellCommand("curl", "--fail", "--show-error", "--max-time", "2", gatewayURL)
	portCheck := ""
	if origin, err := url.Parse(gatewayURL); err == nil && origin.Port() != "" {
		portCheck = contracts.ShellCommand("lsof", "-nP", "-iTCP:"+origin.Port(), "-sTCP:LISTEN")
	}
	removeCommand := contracts.ShellCommand("rm", recordPath)
	statusCommand := contracts.ShellCommand("kb-create", "status", "--platform-root", platformRoot)
	hint := fmt.Sprintf("Check the recorded Gateway health URL with `%s`. Inspect the process listening on that Gateway port with `%s` and compare its PID and command with PID %d. If it is your platform, stop it through its service owner; kb-create will not signal an unverified process. Only after confirming the process is unrelated or stopping it yourself, remove this record with `%s`, then run `%s`; a still-held Gateway port will be reported as a port conflict.", checkCommand, portCheck, pid, removeCommand, statusCommand)
	failure := diag.New(contracts.CodeHostProcessIdentityStale, message, diag.WithMeta(map[string]any{
		"pid": strconv.Itoa(pid), "record": recordPath, "platformRoot": platformRoot, "gatewayUrl": gatewayURL,
	}))
	failure.Hint = hint
	return failure
}

func recordedGatewayURL(recordPath string) string {
	if filepath.Base(recordPath) != "host.pid" {
		return ""
	}
	data, err := os.ReadFile(recordPath)
	if err != nil {
		return ""
	}
	var record pidRecord
	if json.Unmarshal(data, &record) != nil {
		return ""
	}
	return record.HealthURL
}

func GatewayURLForState(state State) string { return recordedGatewayURL(state.HostPID()) }

// WriteRecordFile atomically publishes a complete lifecycle record for all
// readers, including records reached through the install container's links.
func WriteRecordFile(path string, data []byte) error {
	return versionroot.AtomicWriteFile(path, data, 0o600)
}

// ActiveHostRecord identifies a live host process in the installation container.
type ActiveHostRecord struct {
	PID             int
	InstallationID  string
	PlatformRoot    string
	ProcessIdentity string
}

// ActiveHost reads the live host record without deciding whether it belongs to
// a caller's requested platform root.
func ActiveHost(state State) (ActiveHostRecord, bool) {
	data, err := os.ReadFile(state.HostPID())
	if err != nil {
		return ActiveHostRecord{}, false
	}
	var record pidRecord
	if json.Unmarshal(data, &record) != nil || record.PID <= 0 {
		return ActiveHostRecord{}, false
	}
	if !processAlive(record.PID) {
		_ = os.Remove(state.HostPID())
		return ActiveHostRecord{}, false
	}
	if record.InstallationID == "" {
		return ActiveHostRecord{}, false
	}
	identityStatus := ProcessIdentityOf(record.PID, record.ProcessIdentity)
	switch identityStatus {
	case ProcessIdentityMatch:
	case ProcessIdentityMismatch, ProcessIdentityUndetermined:
		return ActiveHostRecord{}, false
	default:
		return ActiveHostRecord{}, false
	}
	return ActiveHostRecord{PID: record.PID, InstallationID: record.InstallationID, PlatformRoot: record.PlatformRoot, ProcessIdentity: record.ProcessIdentity}, true
}

// ProcessRunner spawns the host command directly in its own process group,
// records a pid file and log under the installation state directory, polls the health URL, and
// stops it with a graceful terminate followed by a kill after the grace period.
type ProcessRunner struct {
	Spec           Spec
	State          State
	InstallRoot    string
	InstallationID string
	PlatformRoot   string
	TreeRoot       string
	Identity       ProcessIdentity
	Operation      string
	// HTTP and PollInterval exist for tests; zero values use sane defaults.
	HTTP           *http.Client
	PollInterval   time.Duration
	identityReader func(int) (string, error)
	// SecretEnv supplies the host's stored values and any environment entries
	// that must be suppressed on every Start.
	SecretEnv         func() (secrets.Environment, error)
	ControlCredential string
	ControlAddress    string

	mu              sync.Mutex
	pid             int
	exited          chan struct{}
	waitErr         error
	residueStart    int64
	structuredStart int64
	secrets         []string
	processIdentity string
	startupDeadline time.Time
}

const startupStderrLimit = 8 * 1024
const startupStderrLines = 40

type tailBuffer struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (b *tailBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, data...)
	if len(b.data) > b.limit {
		b.data = append([]byte(nil), b.data[len(b.data)-b.limit:]...)
	}
	return len(data), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(b.data)), "\n")
	if len(lines) > startupStderrLines {
		lines = lines[len(lines)-startupStderrLines:]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
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
	if r.Identity.InstallationID == "" || r.Identity.PlatformVersion == "" || r.Identity.ReceiptID == "" || len(r.Identity.ServiceIDs) == 0 || r.Identity.TreeRoot == "" || filepath.Clean(r.Identity.TreeRoot) != filepath.Clean(r.TreeRoot) {
		return Info{}, hostError(contracts.CodeReceiptUnavailable, "The running host identity is incomplete.",
			"Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", r.PlatformRoot)+"` and repair or reinstall the platform receipt.", nil, map[string]string{"platformRoot": r.PlatformRoot})
	}
	if err := r.State.Ensure(); err != nil {
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	if record, ok := r.readPID(); ok {
		identityStatus := ProcessIdentityOf(record.PID, record.ProcessIdentity)
		if processAlive(record.PID) && record.InstallationID == "" {
			return Info{}, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
		}
		switch identityStatus {
		case ProcessIdentityMatch:
			if record.InstallationID != r.InstallationID {
				return Info{}, RootConflict(record.PlatformRoot, record.PID)
			}
			return Info{}, hostError(contracts.CodeHostAlreadyRunning, "The KB Labs host is already running.", "Use `"+contracts.ShellCommand("kb-create", "status", "--platform-root", r.PlatformRoot)+"` to inspect it.", nil, map[string]string{"pid": strconv.Itoa(record.PID), "nextCommand": contracts.ShellCommand("kb-create", "status", "--platform-root", r.PlatformRoot)})
		case ProcessIdentityMismatch:
			if processAlive(record.PID) {
				return Info{}, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
			}
		case ProcessIdentityUndetermined:
			if processAlive(record.PID) {
				return Info{}, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
			}
		default:
		}
		_ = os.Remove(r.State.HostPID())
	}
	address := r.Spec.HealthAddress()
	if conn, err := net.DialTimeout("tcp", address, 300*time.Millisecond); err == nil {
		_ = conn.Close()
		_, port, _ := net.SplitHostPort(address)
		owner := listenerOwner(port)
		return Info{}, portConflictError(port, address, "", owner, r.Operation, r.PlatformRoot, nil)
	}
	if err := boundResidueLog(r.State.HostLog(), HostResidueLogBytes); err != nil {
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	logFile, err := os.OpenFile(r.State.HostLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	cmd := exec.Command(r.Spec.Command, r.Spec.Args...)
	cmd.Dir = r.Spec.WorkingDir
	startupStarted := time.Now()
	startupDeadline := startupStarted.Add(r.Spec.ReadyTimeout)
	r.mu.Lock()
	if !r.startupDeadline.IsZero() {
		startupDeadline = r.startupDeadline
		r.startupDeadline = time.Time{}
	}
	r.mu.Unlock()
	processIdentity, err := NewProcessIdentityToken()
	if err != nil {
		_ = logFile.Close()
		return Info{}, r.startFailed(err, nil)
	}
	env, err := r.environment()
	if err != nil {
		_ = logFile.Close()
		return Info{}, r.startFailed(err, nil)
	}
	cmd.Env = ProcessEnvironmentWithIdentity(env, processIdentity)
	if r.ControlCredential != "" {
		cmd.Env = append(cmd.Env, contracts.HostControlCredentialEnv+"="+r.ControlCredential)
	}
	cmd.Env = append(cmd.Env, contracts.HostLogFileEnv+"="+r.State.HostStructuredLog())
	r.structuredStart = 0
	if info, statErr := os.Stat(r.State.HostStructuredLog()); statErr == nil {
		r.structuredStart = info.Size()
	}
	if info, statErr := logFile.Stat(); statErr == nil {
		r.residueStart = info.Size()
	}
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := child.Start(cmd, child.ProcessGroup); err != nil {
		_ = logFile.Close()
		return Info{}, r.startFailed(err, nil)
	}
	exited := make(chan struct{})
	r.mu.Lock()
	r.pid, r.exited, r.waitErr = cmd.Process.Pid, exited, nil
	r.processIdentity = processIdentity
	r.mu.Unlock()
	go func() {
		err := cmd.Wait()
		_ = logFile.Close()
		r.mu.Lock()
		r.waitErr = err
		r.mu.Unlock()
		close(exited)
	}()
	record := pidRecord{PID: cmd.Process.Pid, ProcessIdentity: processIdentity, InstallationID: r.InstallationID, PlatformRoot: r.PlatformRoot, TreeRoot: r.Identity.TreeRoot, StartedAt: time.Now().UTC(), HealthURL: r.Spec.HealthURL, Command: r.Spec.Command,
		PlatformVersion: r.Identity.PlatformVersion, ReceiptID: r.Identity.ReceiptID, ServiceIDs: append([]string(nil), r.Identity.ServiceIDs...)}
	identityStatus := WaitForProcessIdentityWithReader(cmd.Process.Pid, processIdentity, exited, startupDeadline, r.identityReader)
	switch identityStatus {
	case ProcessIdentityMatch:
	case ProcessIdentityMismatch:
		select {
		case <-exited:
			r.mu.Lock()
			cause := r.waitErr
			r.mu.Unlock()
			if cause == nil {
				cause = errors.New("process exited before its identity could be verified")
			}
			return Info{}, r.startFailed(fmt.Errorf("host exited before startup identity was verified: %s", processExit(cause)), processExitDetails(cause))
		default:
		}
		killErr := TerminateAndReapLaunchedProcess(cmd.Process, exited)
		if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			return Info{}, r.startFailed(fmt.Errorf("started host process identity did not match the token assigned by this launcher, and the child could not be stopped: %w", killErr), nil)
		}
		if errors.Is(killErr, os.ErrProcessDone) {
			r.mu.Lock()
			cause := r.waitErr
			r.mu.Unlock()
			if cause == nil {
				cause = errors.New("process exited before its identity could be verified")
			}
			return Info{}, r.startFailed(fmt.Errorf("host exited before startup identity was verified: %s", processExit(cause)), processExitDetails(cause))
		}
		return Info{}, r.startFailed(errors.New("started host process identity does not match the token assigned by this launcher"), nil)
	case ProcessIdentityUndetermined:
		select {
		case <-exited:
			r.mu.Lock()
			cause := r.waitErr
			r.mu.Unlock()
			if cause == nil {
				cause = errors.New("process exited before its identity could be verified")
			}
			return Info{}, r.startFailed(fmt.Errorf("host exited before startup identity was verified: %s", processExit(cause)), processExitDetails(cause))
		default:
			if !processAlive(cmd.Process.Pid) {
				<-exited
				r.mu.Lock()
				cause := r.waitErr
				r.mu.Unlock()
				if cause == nil {
					cause = errors.New("process exited before its identity could be verified")
				}
				return Info{}, r.startFailed(fmt.Errorf("host exited before startup identity was verified: %s", processExit(cause)), processExitDetails(cause))
			}
			killErr := TerminateAndReapLaunchedProcess(cmd.Process, exited)
			if errors.Is(killErr, os.ErrProcessDone) {
				r.mu.Lock()
				cause := r.waitErr
				r.mu.Unlock()
				if cause == nil {
					cause = errors.New("process exited before its identity could be verified")
				}
				return Info{}, r.startFailed(fmt.Errorf("host exited before startup identity was verified: %s", processExit(cause)), processExitDetails(cause))
			}
			if killErr == nil {
				_ = os.Remove(r.State.HostPID())
				r.mu.Lock()
				r.pid, r.exited, r.processIdentity = 0, nil, ""
				r.mu.Unlock()
				waited := time.Since(startupStarted).Round(time.Millisecond)
				return Info{}, r.startFailed(fmt.Errorf("host process identity remained undetermined after %s; the started process was terminated", waited), map[string]string{"waited": waited.String()})
			}
			_ = os.Remove(r.State.HostPID())
			r.mu.Lock()
			r.pid, r.exited, r.processIdentity = 0, nil, ""
			r.mu.Unlock()
			waited := time.Since(startupStarted).Round(time.Millisecond)
			return Info{}, r.startFailed(fmt.Errorf("host process identity remained undetermined after %s and the started process could not be stopped: %w", waited, killErr), map[string]string{"waited": waited.String()})
		}
	default:
		return Info{}, r.startFailed(errors.New("started host process identity result is invalid"), nil)
	}
	if r.InstallationID == "" {
		r.kill(cmd.Process.Pid)
		return Info{}, hostError(contracts.CodeReceiptUnavailable, "The installation identity is missing while recording the host.", "Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", r.InstallRoot)+"` and repair the install-root ownership record.", nil, map[string]string{"installRoot": r.InstallRoot})
	}
	if err := writeJSONFile(r.State.HostPID(), record); err != nil {
		r.kill(cmd.Process.Pid)
		return Info{}, hostError("KB_HOST_STATE_DIR_UNWRITABLE", "Cannot write to the state directory "+r.State.Dir+".", "Fix the directory permissions or free disk space.", err, map[string]string{"path": r.State.Dir})
	}
	if err := r.waitReadyUntil(ctx, record.PID, exited, startupDeadline); err != nil {
		return Info{}, err
	}
	layout, layoutErr := versionroot.New(r.InstallRoot)
	if layoutErr == nil && layout.Validate() == nil {
		if err := layout.RecordHealthy(); err != nil {
			r.kill(record.PID)
			return Info{}, err
		}
		if err := layout.Retain(record.TreeRoot); err != nil {
			r.kill(record.PID)
			return Info{}, err
		}
	}
	return Info{Runner: r.Name(), PID: record.PID, HealthURL: r.Spec.HealthURL, ControlAddress: r.ControlAddress}, nil
}

// RunTool runs the platform's recovery tool to completion, in the host's
// working directory and environment, with the caller's terminal attached. It
// returns the tool's exit status; an error means the tool could not be run.
func (r *ProcessRunner) RunTool(ctx context.Context, tool Tool, extra []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	env, err := r.environment()
	if err != nil {
		return 0, err
	}
	cmd := exec.CommandContext(ctx, tool.Command, append(append([]string(nil), tool.Args...), extra...)...)
	cmd.Dir, cmd.Env = r.Spec.WorkingDir, ProcessEnvironmentWithoutIdentity(env)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), nil
		}
		return 0, err
	}
	return 0, nil
}

// environment layers the host's environment: the launcher's own, then the
// platform's secrets, then the spec's explicit values (the release wins).
func (r *ProcessRunner) environment() ([]string, error) {
	values := map[string]string{}
	if r.PlatformRoot != "" {
		home, err := KBHome(r.PlatformRoot)
		if err != nil {
			return nil, err
		}
		values[KBHomeEnv] = home
	}
	suppressed := map[string]struct{}{}
	if r.SecretEnv != nil {
		environment, err := r.SecretEnv()
		if err != nil {
			return nil, fmt.Errorf("read the platform secrets: %w", err)
		}
		for key, value := range environment.Values {
			values[key] = value
		}
		for _, key := range environment.Suppressed {
			suppressed[key] = struct{}{}
			delete(values, key)
		}
	}
	for key, value := range r.Spec.Env {
		if _, omit := suppressed[key]; omit {
			continue
		}
		values[key] = value
	}
	if r.Identity.InstallationID != "" {
		values["KB_INSTALLATION_ID"] = r.Identity.InstallationID
	}
	env := make([]string, 0, len(os.Environ())+len(values))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if _, omit := suppressed[key]; omit {
			continue
		}
		env = append(env, entry)
	}
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	// A locally launched host must resolve adapters against its installation,
	// even when the caller's current directory belongs to another workspace.
	if r.PlatformRoot != "" {
		env = append(env, "KB_PLATFORM_ROOT="+r.PlatformRoot)
	}
	r.mu.Lock()
	r.secrets = r.secrets[:0]
	for _, value := range values {
		if value != "" {
			r.secrets = append(r.secrets, value)
		}
	}
	r.mu.Unlock()
	return env, nil
}

// StartFailure is the single diagnostic builder for failed launcher host starts.
func StartFailure(state State, cause error, evidence map[string]string) *diag.Diag {
	details := map[string]string{"log": state.HostLog(), "structuredLog": state.HostStructuredLog(), "launcherLog": state.LauncherLog()}
	evidenceFields := make([]string, 0, len(evidence))
	for key := range evidence {
		evidenceFields = append(evidenceFields, key)
	}
	if undeclared := diag.UndeclaredDetailFields("KB_HOST_START_FAILED", evidenceFields); len(undeclared) > 0 {
		return diag.NewContractViolation("KB_HOST_START_FAILED", strings.Join(undeclared, ", "))
	}
	for key, value := range evidence {
		details[key] = redactHostOutput(value, nil)
	}
	if cause != nil {
		cause = errors.New(redactHostOutput(cause.Error(), nil))
	}
	if startup := startupEnvelope(details["stderrTail"]); startup != nil {
		details["hostStartupCode"] = startup.Error.Code
		meta := make(map[string]any, len(startup.Error.Details)+len(details))
		for key, value := range startup.Error.Details {
			meta[key] = value
		}
		for key, value := range details {
			meta[key] = value
		}
		typed := diag.New(startup.Error.Code, startup.Error.Message,
			diag.WithHint(startup.Error.Hint), diag.WithCause(startup.Error.Cause))
		typed.Meta = meta
		if startup.Error.Cause != "" {
			typed.Reason = startup.Error.Cause
		}
		if err := appendLauncherFailure(state, typed); err != nil {
			typed.Meta["launcherLogError"] = err.Error()
		}
		if _, err := diag.ToEnvelope(typed); err != nil {
			var violation *diag.Diag
			if errors.As(err, &violation) {
				return violation
			}
		}
		return typed
	}
	reason := "host startup failed"
	if cause != nil {
		reason = cause.Error()
	}
	nextCommand := details["nextCommand"]
	if nextCommand == "" {
		nextCommand = "kb-create start"
	}
	hint := fmt.Sprintf("Read the launcher log at %q, the host log at %q and the host structured log at %q, correct the reported startup failure, then run `%s`.", state.LauncherLog(), state.HostLog(), state.HostStructuredLog(), nextCommand)
	failure := hostError("KB_HOST_START_FAILED", "The host process failed while starting.", hint, cause, details)
	failure.Reason = reason
	failure.Cause = reason
	if err := appendLauncherFailure(state, failure); err != nil {
		failure.Meta["launcherLogError"] = err.Error()
	}
	return failure
}

func (r *ProcessRunner) startFailed(cause error, evidence map[string]string) *diag.Diag {
	if evidence == nil {
		evidence = map[string]string{}
	}
	if tail := r.stderrTail(); tail != "" {
		evidence["stderrTail"] = redactHostOutput(tail, r.secrets)
	}
	if tail := r.structuredLogTail(); tail != "" {
		evidence["structuredLogTail"] = tail
	}
	if r.Operation == "apply" {
		evidence["nextCommand"] = "kb-create apply"
	} else {
		root := r.PlatformRoot
		if root == "" {
			root = "<platform-root>"
		}
		evidence["nextCommand"] = contracts.ShellCommand("kb-create", "start", "--platform-root", root)
	}
	return StartFailure(r.State, cause, evidence)
}

func (r *ProcessRunner) waitReadyUntil(ctx context.Context, pid int, exited <-chan struct{}, startupDeadline time.Time) error {
	started := time.Now()
	deadline := time.NewTimer(time.Until(startupDeadline))
	defer deadline.Stop()
	ticker := time.NewTicker(r.interval())
	defer ticker.Stop()
	lastProbe := readinessProbe{URL: r.Spec.HealthURL}
	for {
		lastProbe = r.probe(ctx)
		if lastProbe.Healthy {
			if err := r.verifyListenerOwner(pid); err != nil {
				r.kill(pid)
				return err
			}
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
			return r.startFailed(fmt.Errorf("host exited before becoming ready: %s", processExit(cause)), processExitDetails(cause))
		case <-deadline.C:
			r.kill(pid)
			return r.startFailed(fmt.Errorf("readiness check %s failed after %s", probeDescription(lastProbe), time.Since(started).Round(time.Millisecond)), readinessDetails(lastProbe, time.Since(started)))
		case <-ctx.Done():
			// A host that became healthy just as the caller cancelled is up;
			// the caller decides whether to stop it.
			if r.healthy(context.Background()) {
				if err := r.verifyListenerOwner(pid); err != nil {
					r.kill(pid)
					return err
				}
				return nil
			}
			r.kill(pid)
			return r.startFailed(ctx.Err(), readinessDetails(lastProbe, time.Since(started)))
		case <-ticker.C:
			lastProbe = r.probe(ctx)
			if lastProbe.Healthy {
				if err := r.verifyListenerOwner(pid); err != nil {
					r.kill(pid)
					return err
				}
				return nil
			}
		}
	}
}

type readinessProbe struct {
	URL       string
	Status    int
	Error     string
	Healthy   bool
	StudioURL string
}

func validControlAddress(address string) bool {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "http" || parsed.Port() == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	return ip != nil && ip.IsLoopback()
}

func (r *ProcessRunner) QueryActiveWork(ctx context.Context) ([]ActiveWorkItem, error) {
	if r.ControlAddress == "" || r.ControlCredential == "" {
		return nil, HostUnreachable(r.ControlAddress, errors.New("host control endpoint is unavailable"))
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, r.ControlAddress+"/v1/active-work", nil)
	if err != nil {
		return nil, HostUnreachable(r.ControlAddress, err)
	}
	request.Header.Set("Authorization", "Bearer "+r.ControlCredential)
	response, err := r.client().Do(request)
	if err != nil {
		return nil, HostUnreachable(r.ControlAddress, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, HostUnreachable(r.ControlAddress, fmt.Errorf("active-work endpoint returned HTTP %d", response.StatusCode))
	}
	var items []ActiveWorkItem
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&items); err != nil || items == nil {
		if err == nil {
			err = errors.New("active-work endpoint returned a non-array response")
		}
		return nil, HostUnreachable(r.ControlAddress, err)
	}
	for _, item := range items {
		if item.ID == "" || item.OwningService == "" || !validActiveWorkKind(item.Kind) {
			return nil, HostUnreachable(r.ControlAddress, errors.New("active-work endpoint returned an incomplete item"))
		}
	}
	return items, nil
}

func HostUnreachable(address string, cause error) error {
	diagnostic, err := diag.FromCatalog("KB_HOST_UNREACHABLE", map[string]string{"address": address}, diag.WithCauseAndReason(cause.Error()))
	if err != nil {
		return err
	}
	return diagnostic
}

func (r *ProcessRunner) probe(ctx context.Context) readinessProbe {
	return r.probeURL(ctx, r.Spec.HealthURL)
}

func (r *ProcessRunner) probeURL(ctx context.Context, healthURL string) readinessProbe {
	result := readinessProbe{URL: healthURL}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	response, err := r.client().Do(request)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer response.Body.Close()
	result.Status = response.StatusCode
	result.Healthy = response.StatusCode >= 200 && response.StatusCode < 300
	if result.Healthy && strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		var health struct {
			Data struct {
				Studio *struct {
					URL string `json:"url"`
				} `json:"studio"`
			} `json:"data"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&health); err != nil {
			result.Healthy = false
			result.Error = err.Error()
		} else if health.Data.Studio != nil {
			result.StudioURL = health.Data.Studio.URL
		}
	}
	if result.Healthy && r.ControlCredential != "" {
		address := response.Header.Get(contracts.HostActiveWorkAddressHeader)
		if !validControlAddress(address) {
			result.Healthy = false
			result.Error = "host readiness did not report a valid loopback control address"
		} else {
			r.ControlAddress = address
		}
	}
	return result
}

func readinessDetails(probe readinessProbe, waited time.Duration) map[string]string {
	details := map[string]string{"readinessURL": probe.URL, "waited": waited.Round(time.Millisecond).String()}
	if probe.Status != 0 {
		details["readinessStatus"] = strconv.Itoa(probe.Status)
	}
	if probe.Error != "" {
		details["readinessError"] = probe.Error
	}
	return details
}

func probeDescription(probe readinessProbe) string {
	if probe.Status != 0 {
		if probe.Error != "" {
			return fmt.Sprintf("%s returned HTTP %d but readiness failed: %s", probe.URL, probe.Status, probe.Error)
		}
		return fmt.Sprintf("%s returned HTTP %d", probe.URL, probe.Status)
	}
	if probe.Error != "" {
		return fmt.Sprintf("%s could not be reached: %s", probe.URL, probe.Error)
	}
	return probe.URL
}

func processExit(err error) string {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if code := exit.ExitCode(); code >= 0 {
			return fmt.Sprintf("exit code %d", code)
		}
		return exit.Error()
	}
	return err.Error()
}

func processExitDetails(err error) map[string]string {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if code := exit.ExitCode(); code >= 0 {
			return map[string]string{"exitCode": strconv.Itoa(code)}
		}
		return map[string]string{"signal": exit.Error()}
	}
	return map[string]string{"exitStatus": err.Error()}
}

type hostStartupEnvelope struct {
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Cause   string         `json:"cause"`
		Hint    string         `json:"hint"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

func startupEnvelope(stderr string) *hostStartupEnvelope {
	for _, line := range strings.Split(stderr, "\n") {
		var envelope hostStartupEnvelope
		if json.Unmarshal(bytes.TrimSpace([]byte(line)), &envelope) == nil && envelope.Error.Code != "" {
			if _, known := diag.LookupCatalog(envelope.Error.Code); known {
				return &envelope
			}
		}
	}
	return nil
}

func (r *ProcessRunner) stderrTail() string {
	return redactHostOutput(residueTail(r.State.HostLog(), r.residueStart).String(), r.secrets)
}

func (r *ProcessRunner) structuredLogTail() string {
	return redactHostOutput(structuredTail(r.State.HostStructuredLog(), r.structuredStart).String(), r.secrets)
}

// StartupStderrTail reads a bounded, redacted tail from a startup log file.
func StartupStderrTail(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	tail := &tailBuffer{limit: startupStderrLimit}
	_, _ = tail.Write(data)
	return redactHostOutput(tail.String(), nil)
}

func redactHostOutput(value string, secrets []string) string {
	value = diagnostics.Redact(value, secrets)
	return diag.RedactText(value)
}

func appendLauncherFailure(state State, failure *diag.Diag) error {
	file, err := os.OpenFile(state.LauncherLog(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	entry := map[string]any{"time": time.Now().UTC(), "event": "host.start.failed", "code": failure.Code,
		"cause": failure.Cause, "details": failure.Meta}
	encodeErr := json.NewEncoder(file).Encode(entry)
	closeErr := file.Close()
	return errors.Join(encodeErr, closeErr)
}

type portOwner struct{ PID, Command string }

func portInUseError(port, address, purpose string, owner portOwner, operation, platformRoot string, cause error) *diag.Diag {
	if operation == "" {
		operation = "start"
	}
	message := "Port " + port + " is already in use."
	if purpose != "" {
		message = "Port " + port + " required by " + purpose + " is already in use."
	}
	command := []string{"kb-create", operation}
	if platformRoot != "" {
		command = append(command, "--platform-root", platformRoot)
	}
	hint := "Stop the process using port " + port + ", then rerun `" + contracts.ShellCommand(command...) + "`."
	if owner.PID != "" && owner.Command != "" {
		hint = "Stop process " + owner.PID + " (" + owner.Command + ") using port " + port + ", then rerun `" + contracts.ShellCommand(command...) + "`."
	}
	meta := map[string]string{"port": port, "pid": owner.PID, "command": owner.Command, "operation": operation}
	if address != "" {
		meta["address"] = address
	}
	if purpose != "" {
		meta["purpose"] = purpose
	}
	return hostError(contracts.CodePortInUse, message, hint, cause, meta)
}

func portConflictError(port, address, purpose string, owner portOwner, operation, platformRoot string, cause error) *diag.Diag {
	if pid, err := strconv.Atoi(owner.PID); err == nil {
		if root, staleRecord, registryErr := registeredGatewayRoot(port, pid, platformRoot); registryErr != nil {
			var failure *diag.Diag
			if errors.As(registryErr, &failure) {
				return failure
			}
			return hostError(contracts.CodeOperationFailed, "the Gateway address index could not be checked", "inspect the launcher state before checking this host", registryErr, nil)
		} else if staleRecord != "" {
			return StaleProcessIdentityFailure(staleRecord, "host", pid, root, recordedGatewayURL(staleRecord))
		} else if root != "" {
			if layout, layoutErr := versionroot.ForPlatformPath(root); layoutErr == nil {
				return RootConflict(layout.InstallRoot(), pid)
			}
		}
	}
	return portInUseError(port, address, purpose, owner, operation, platformRoot, cause)
}

// GatewayResourceConflict reports a verified live installation holding a
// Gateway port claimed by another root. Unregistered listeners remain the
// caller's ordinary address/port conflict, while registered identities use
// the same ownership verification as other host port conflicts.
func GatewayResourceConflict(gatewayURL, operation, platformRoot string) *diag.Diag {
	parsed, err := url.Parse(gatewayURL)
	if err != nil || parsed.Port() == "" {
		return nil
	}
	port := parsed.Port()
	owner := listenerOwner(port)
	if owner.PID == "" {
		return nil
	}
	failure := portConflictError(port, parsed.Host, "gateway", owner, operation, platformRoot,
		fmt.Errorf("the selected Gateway port %s is already occupied", port))
	if failure.Code == contracts.CodeHostAlreadyRunning || failure.Code == contracts.CodeHostProcessIdentityStale ||
		failure.Code == contracts.CodeGatewayIndexUnavailable || failure.Code == contracts.CodeOperationFailed {
		return failure
	}
	return nil
}

func registeredGatewayRoot(port string, pid int, platformRoot string) (string, string, error) {
	roots, err := (gateway.Registry{OperationRoot: platformRoot}).Read()
	if err != nil {
		return "", "", err
	}
	for _, candidate := range roots {
		origin, err := url.Parse(candidate.URL)
		if err != nil || origin.Port() != port {
			continue
		}
		if _, err := receipt.Read(candidate.PlatformRoot); err != nil {
			continue
		}
		rootState, err := StateForRoot(candidate.PlatformRoot)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(rootState.HostPID())
		if err != nil {
			continue
		}
		var record pidRecord
		if json.Unmarshal(data, &record) != nil || record.PID != pid {
			continue
		}
		candidateID, identityErr := versionroot.InstallationIDForPath(candidate.PlatformRoot)
		identityStatus := ProcessIdentityOf(record.PID, record.ProcessIdentity)
		if processAlive(record.PID) && (record.InstallationID == "" || identityStatus == ProcessIdentityMismatch || identityStatus == ProcessIdentityUndetermined) {
			return record.PlatformRoot, rootState.HostPID(), nil
		}
		if identityErr == nil && record.InstallationID == candidateID && identityStatus == ProcessIdentityMatch {
			return record.PlatformRoot, "", nil
		}
	}
	return "", "", nil
}

// RegisteredPortConflict prevents status from reporting a stopped host while
// the installation's previously registered Gateway is still listening.
func RegisteredPortConflict(platformRoot, operation string) *diag.Diag {
	requested, err := filepath.Abs(platformRoot)
	if err != nil {
		return nil
	}
	if resolved, resolveErr := filepath.EvalSymlinks(requested); resolveErr == nil {
		requested = resolved
	}
	roots, err := (gateway.Registry{OperationRoot: platformRoot}).Read()
	if err != nil {
		var failure *diag.Diag
		if errors.As(err, &failure) {
			return failure
		}
		return hostError(contracts.CodeOperationFailed, "the Gateway address index could not be checked", "inspect the launcher state before checking this host", err, nil)
	}
	for _, candidate := range roots {
		candidateRoot, absErr := filepath.Abs(candidate.PlatformRoot)
		if absErr != nil {
			continue
		}
		if resolved, resolveErr := filepath.EvalSymlinks(candidateRoot); resolveErr == nil {
			candidateRoot = resolved
		}
		if filepath.Clean(candidateRoot) != filepath.Clean(requested) {
			continue
		}
		origin, parseErr := url.Parse(candidate.URL)
		if parseErr != nil || origin.Port() == "" {
			continue
		}
		owner := listenerOwner(origin.Port())
		if owner.PID != "" || owner.Command != "" {
			return portConflictError(origin.Port(), origin.Host, "gateway", owner, operation, platformRoot,
				fmt.Errorf("the registered Gateway port %s is still occupied", origin.Port()))
		}
	}
	return nil
}

// RootConflict reports that the installation's live host serves another
// platform root. A host recorded without a root predates root ownership, so the
// hint names its pid instead of a stop command that could not match it.
func RootConflict(platformRoot string, pid int) *diag.Diag {
	pidText := strconv.Itoa(pid)
	meta := map[string]string{"platformRoot": platformRoot, "pid": pidText}
	if platformRoot == "" {
		meta["nextCommand"] = contracts.ShellCommand("kb-create", "status")
		return hostError(contracts.CodeHostAlreadyRunning, "A KB Labs host started by an earlier launcher is already running (pid "+pidText+").", "Stop process "+pidText+", then rerun the command.", nil, meta)
	}
	command := contracts.ShellCommand("kb-create", "stop", "--platform-root", platformRoot)
	meta["nextCommand"] = command
	return hostError(contracts.CodeHostAlreadyRunning, "The KB Labs host for platform root "+platformRoot+" is already running (pid "+pidText+").", "Stop that platform first with `"+command+"`.", nil, meta)
}

func listenerOwner(port string) portOwner {
	output, err := exec.Command("lsof", "-nP", "-iTCP:"+port, "-sTCP:LISTEN", "-Fp", "-Fc").Output()
	var owner portOwner
	if err == nil {
		for _, line := range strings.Split(string(output), "\n") {
			if len(line) < 2 {
				continue
			}
			switch line[0] {
			case 'p':
				owner.PID = line[1:]
			case 'c':
				owner.Command = line[1:]
			}
		}
	}
	if owner.PID != "" && owner.Command != "" {
		return owner
	}
	return linuxListenerOwner(port)
}

func linuxListenerOwner(port string) portOwner {
	if runtime.GOOS != "linux" {
		return portOwner{}
	}
	portNumber, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return portOwner{}
	}
	wantedPort := fmt.Sprintf("%04X", portNumber)
	inodes := make(map[string]struct{})
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		data, err := os.ReadFile(table)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) < 10 || fields[3] != "0A" {
				continue
			}
			localAddress := fields[1]
			separator := strings.LastIndexByte(localAddress, ':')
			if separator < 0 || strings.ToUpper(localAddress[separator+1:]) != wantedPort {
				continue
			}
			inodes[fields[9]] = struct{}{}
		}
	}
	if len(inodes) == 0 {
		return portOwner{}
	}
	processes, err := os.ReadDir("/proc")
	if err != nil {
		return portOwner{}
	}
	for _, process := range processes {
		if !process.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(process.Name()); err != nil {
			continue
		}
		fdEntries, err := os.ReadDir(filepath.Join("/proc", process.Name(), "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fdEntries {
			target, err := os.Readlink(filepath.Join("/proc", process.Name(), "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(target, "socket:[") || !strings.HasSuffix(target, "]") {
				continue
			}
			if _, listening := inodes[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")]; !listening {
				continue
			}
			commandBytes, _ := os.ReadFile(filepath.Join("/proc", process.Name(), "cmdline"))
			command := strings.TrimSpace(strings.ReplaceAll(strings.TrimRight(string(commandBytes), "\x00"), "\x00", " "))
			if command == "" {
				commandBytes, _ = os.ReadFile(filepath.Join("/proc", process.Name(), "comm"))
				command = strings.TrimSpace(string(commandBytes))
			}
			return portOwner{PID: process.Name(), Command: command}
		}
	}
	return portOwner{}
}

// CheckPorts reports conflicts in the resolved service graph before package
// downloads or installation change the platform root.
func CheckPorts(plan contracts.ResolvedInstallPlan, operation string) error {
	ports := map[string]string{}
	if plan.Host != nil {
		if parsed, err := url.Parse(plan.Host.HealthURL); err == nil {
			if _, port, err := net.SplitHostPort(parsed.Host); err == nil {
				ports[port] = plan.Host.HealthURL
			}
		}
	}
	for _, service := range plan.ServiceGraph.Services {
		if service.Port > 0 {
			ports[strconv.Itoa(service.Port)] = service.ID
		}
	}
	var active ActiveHostRecord
	if rootState, rootErr := StateForRoot(plan.Request.PlatformRoot); rootErr == nil {
		active, _ = ActiveHost(rootState)
	}
	for port, purpose := range ports {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
		if err == nil {
			_ = listener.Close()
			continue
		}
		owner := listenerOwner(port)
		installationID, identityErr := versionroot.InstallationIDForPath(plan.Request.PlatformRoot)
		if active.PID > 0 && identityErr == nil && active.InstallationID == installationID &&
			owner.PID == strconv.Itoa(active.PID) {
			continue
		}
		failure := portConflictError(port, "", purpose, owner, operation, plan.Request.PlatformRoot, err)
		if operation == "plan" || operation == "apply" {
			if plan.Host != nil {
				if gatewayURL, suggestionErr := nextGatewayURL(plan.Host.HealthURL); suggestionErr == nil {
					failure.Hint += " Use `" + contracts.ShellCommand("kb-create", operation, "--platform-root", plan.Request.PlatformRoot, "--gateway-url", gatewayURL) + "`."
				}
			}
		}
		return failure
	}
	return nil
}

func nextGatewayURL(healthURL string) (string, error) {
	parsed, err := url.Parse(healthURL)
	if err != nil {
		return "", err
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port+100 > 65535 {
		return "", fmt.Errorf("Gateway port has no valid 100-port offset")
	}
	parsed.Host = strings.TrimSuffix(parsed.Host, ":"+parsed.Port()) + ":" + strconv.Itoa(port+100)
	parsed.Path, parsed.RawPath, parsed.RawQuery, parsed.Fragment = "", "", "", ""
	return parsed.String(), nil
}

func (r *ProcessRunner) verifyListenerOwner(pid int) error {
	_, port, err := net.SplitHostPort(r.Spec.HealthAddress())
	if err != nil {
		return r.startFailed(err, map[string]string{"readinessURL": r.Spec.HealthURL})
	}
	owner := listenerOwner(port)
	if owner.PID != strconv.Itoa(pid) {
		cause := fmt.Errorf("readiness endpoint %s is served by pid %s (%s), expected host pid %d", r.Spec.HealthURL, owner.PID, owner.Command, pid)
		return r.startFailed(cause, map[string]string{"readinessURL": r.Spec.HealthURL, "expectedPid": strconv.Itoa(pid), "pid": owner.PID, "command": owner.Command})
	}
	return nil
}

// kill force-terminates a host that failed to become ready and clears its pid file.
func (r *ProcessRunner) kill(pid int) {
	r.mu.Lock()
	processIdentity := r.processIdentity
	r.mu.Unlock()
	switch ProcessIdentityOf(pid, processIdentity) {
	case ProcessIdentityMatch:
		KillProcessGroupIfIdentity(pid, processIdentity)
		if !r.waitGone(pid, processIdentity, 5*time.Second) {
			return
		}
	case ProcessIdentityMismatch:
		r.removePIDRecord(pid, processIdentity)
		return
	case ProcessIdentityUndetermined:
		return
	default:
		return
	}
	r.removePIDRecord(pid, processIdentity)
}

func (r *ProcessRunner) removePIDRecord(pid int, processIdentity string) {
	if record, ok := r.readPID(); ok && record.PID == pid && record.ProcessIdentity == processIdentity {
		_ = os.Remove(r.State.HostPID())
	}
}

func (r *ProcessRunner) healthy(ctx context.Context) bool {
	return r.probe(ctx).Healthy
}

// Stop terminates the recorded host: graceful first, kill after the grace
// period. Stopping a host that is not running succeeds with WasRunning=false.
func (r *ProcessRunner) Stop(ctx context.Context) (StopResult, error) {
	result := StopResult{Runner: r.Name()}
	record, ok := r.readPID()
	identityStatus := ProcessIdentityUndetermined
	if ok {
		identityStatus = ProcessIdentityOf(record.PID, record.ProcessIdentity)
	}
	if ok && processAlive(record.PID) && record.InstallationID == "" {
		return result, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	}
	switch identityStatus {
	case ProcessIdentityMatch:
		if record.InstallationID != r.InstallationID {
			return result, nil
		}
	case ProcessIdentityMismatch:
		if processAlive(record.PID) {
			return result, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
		}
		_ = os.Remove(r.State.HostPID())
		return result, nil
	case ProcessIdentityUndetermined:
		if ok && processAlive(record.PID) {
			return result, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
		}
		if ok {
			_ = os.Remove(r.State.HostPID())
		}
		return result, nil
	default:
		return result, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	}
	if !ok {
		_ = os.Remove(r.State.HostPID())
		return result, nil
	}
	result.WasRunning, result.PID = true, record.PID
	TerminateProcessGroupIfIdentity(record.PID, record.ProcessIdentity)
	if r.waitGoneCtx(ctx, record.PID, record.ProcessIdentity, r.Spec.StopGrace) {
		result.Graceful = true
		_ = os.Remove(r.State.HostPID())
		return result, nil
	}
	switch ProcessIdentityOf(record.PID, record.ProcessIdentity) {
	case ProcessIdentityMatch:
	case ProcessIdentityMismatch:
		_ = os.Remove(r.State.HostPID())
		return result, nil
	case ProcessIdentityUndetermined:
		return result, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	default:
		return result, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	}
	KillProcessGroupIfIdentity(record.PID, record.ProcessIdentity)
	result.Forced = true
	if !r.waitGoneCtx(ctx, record.PID, record.ProcessIdentity, 5*time.Second) {
		return result, hostError("KB_HOST_STOP_FAILED", fmt.Sprintf("The host process %d did not stop.", record.PID), "Run `"+contracts.ShellCommand("kb-create", "stop", "--platform-root", r.PlatformRoot)+"` again, then check its status.", nil, pidDetail(record.PID))
	}
	_ = os.Remove(r.State.HostPID())
	return result, nil
}

func (r *ProcessRunner) waitGone(pid int, processIdentity string, timeout time.Duration) bool {
	return r.waitGoneCtx(context.Background(), pid, processIdentity, timeout)
}

// waitGoneCtx waits for pid to disappear. When this runner spawned the process
// its own Wait goroutine reaps it, so the exit channel is authoritative;
// otherwise the pid is polled (the owner of the child reaps it).
func (r *ProcessRunner) waitGoneCtx(ctx context.Context, pid int, processIdentity string, timeout time.Duration) bool {
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
		} else {
			switch ProcessIdentityOf(pid, processIdentity) {
			case ProcessIdentityMatch:
			case ProcessIdentityMismatch:
				return true
			case ProcessIdentityUndetermined:
				if !processAlive(pid) {
					return true
				}
			default:
				if !processAlive(pid) {
					return true
				}
			}
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
	if record.InstallationID == "" {
		return status, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	}
	identityStatus := ProcessIdentityOf(record.PID, record.ProcessIdentity)
	switch identityStatus {
	case ProcessIdentityMatch:
	case ProcessIdentityMismatch:
		return status, StaleProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	case ProcessIdentityUndetermined:
		return status, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	default:
		return status, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	}
	if r.InstallationID == "" || record.InstallationID != r.InstallationID {
		return status, nil
	}
	status.PlatformVersion = record.PlatformVersion
	status.TreeRoot = record.TreeRoot
	status.ReceiptID = record.ReceiptID
	status.ServiceIDs = append([]string(nil), record.ServiceIDs...)
	switch ProcessIdentityOf(record.PID, record.ProcessIdentity) {
	case ProcessIdentityMatch:
	case ProcessIdentityMismatch:
		_ = os.Remove(r.State.HostPID())
		status.StalePID = true
		return status, nil
	case ProcessIdentityUndetermined:
		return status, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	default:
		return status, UndeterminedProcessIdentityFailure(r.State.HostPID(), "host", record.PID, r.PlatformRoot, record.HealthURL)
	}
	started := record.StartedAt
	status.PID, status.StartedAt = record.PID, &started
	if record.HealthURL != "" {
		status.HealthURL = record.HealthURL
		probe := r.probeURL(ctx, record.HealthURL)
		status.Healthy, status.StudioURL = probe.Healthy, probe.StudioURL
	} else {
		status.Healthy = r.healthy(ctx)
	}
	status.State = StateUnhealthy
	if status.Healthy {
		status.State = StateRunning
	}
	return status, nil
}

// Exited is closed when the process this runner started exits; nil when
// nothing was started here.
func (r *ProcessRunner) Exited() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exited
}

// ExitCause describes how the started process ended. It is meaningful only
// after Exited is closed.
func (r *ProcessRunner) ExitCause() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.waitErr == nil {
		return "exit code 0"
	}
	return processExit(r.waitErr)
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
	return WriteRecordFile(path, append(data, '\n'))
}
