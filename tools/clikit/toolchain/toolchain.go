// Package toolchain defines the shared runtime contract for KB Labs launchers.
// It is intentionally independent of a particular CLI so human, agent and CI
// frontends report the same fail-fast diagnostics.
package toolchain

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
)

//go:generate node generate-node-policy.mjs

type Status struct{ NodeVersion, PnpmVersion string }

type ValidationError struct {
	Tool, Detected, Requirement, Remediation string
}

func (e *ValidationError) Error() string {
	if e.Detected == "" {
		return fmt.Sprintf("%s was not found; KB Labs requires %s. %s", e.Tool, e.Requirement, e.Remediation)
	}
	return fmt.Sprintf("%s %s is unsupported; KB Labs requires %s. %s", e.Tool, e.Detected, e.Requirement, e.Remediation)
}

func NodeRemediation() string {
	diagnostic, err := nodeVersionDiagnostic("unknown")
	if err != nil {
		panic(err)
	}
	envelope, err := diag.ToEnvelope(diagnostic)
	if err != nil {
		panic(err)
	}
	return envelope.Hint
}
func PnpmRemediation() string { return fmt.Sprintf("Install pnpm@%s and retry", SupportedPnpm) }

// NodeMissingDiagnostic reports that Node.js could not be executed at all.
func NodeMissingDiagnostic() *diag.Diag {
	diagnostic, err := diag.FromCatalog("KB_INSTALL_NODE_MISSING", map[string]string{"requirement": "Node.js"})
	if err != nil {
		panic(err)
	}
	return diagnostic
}

// NodeCheckDiagnostic preserves a structured preflight failure or reports that
// no Node.js executable could be run.
func NodeCheckDiagnostic(err error) *diag.Diag {
	var failure *diag.Diag
	if errors.As(err, &failure) {
		return failure
	}
	return NodeMissingDiagnostic()
}

func Version(binary string) (string, error) {
	if strings.TrimSpace(binary) == "" {
		return "", nil
	}
	out, err := Run(context.Background(), Invocation{Tool: binary, Executable: binary, Args: []string{"--version"}, Operation: OperationVersionProbe})
	if err != nil {
		return "", fmt.Errorf("read version from %s: %w", binary, err)
	}
	return strings.TrimSpace(out.Stdout), nil
}

// Operation selects the centrally-owned stall limit for an external operation.
type Operation uint8

const (
	OperationVersionProbe Operation = iota
	OperationPackageManager
	OperationWorkspaceTask
)

func (o Operation) timeout() time.Duration {
	switch o {
	case OperationVersionProbe:
		return 10 * time.Second
	case OperationPackageManager:
		return 15 * time.Minute
	case OperationWorkspaceTask:
		return 30 * time.Minute
	default:
		return 30 * time.Minute
	}
}

type Invocation struct {
	Tool, Executable string
	Args, Env        []string
	Dir              string
	Operation        Operation
	Stdout, Stderr   io.Writer
	Stdin            io.Reader
}

type Result struct {
	Stdout, Stderr string
	ExitCode       int
	Elapsed        time.Duration
}

type CommandError struct {
	ExitCode   int
	StderrTail string
	StdoutTail string
	Err        error
}

func (e *CommandError) Error() string {
	tail := diag.RedactText(strings.Trim(strings.Join([]string{e.StdoutTail, e.StderrTail}, "\n"), "\n"))
	if len(tail) > stderrTailLimit {
		tail = tail[len(tail)-stderrTailLimit:]
	}
	if strings.TrimSpace(tail) == "" {
		return e.Err.Error()
	}
	return e.Err.Error() + "\n" + tail
}
func (e *CommandError) Unwrap() error { return e.Err }

type TimeoutBound string

const (
	BoundOperation TimeoutBound = "operation"
	BoundCaller    TimeoutBound = "caller"
)

type TimeoutError struct {
	Bound   TimeoutBound
	Budget  time.Duration
	Elapsed time.Duration
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("external command exceeded its %s execution budget of %s", e.Bound, e.Budget.Round(time.Millisecond))
}

var outerHome = func() string {
	current, err := user.Current()
	if err == nil {
		return current.HomeDir
	}
	home, _ := os.UserHomeDir()
	return home
}()
var outerCorepackHome = func() string {
	if root := os.Getenv("COREPACK_HOME"); root != "" {
		return root
	}
	if runtime.GOOS == "windows" && os.Getenv("LOCALAPPDATA") != "" {
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "node", "corepack")
	}
	return filepath.Join(outerHome, ".cache", "node", "corepack")
}()

var pnpmResolution sync.Once
var resolvedPnpmNode, resolvedPnpmScript string
var resolvedPnpmError error

// PnpmExecutable resolves only the exact workspace-pinned pnpm from the
// outer user's Corepack cache. It never invokes Corepack or downloads packages.
func PnpmExecutable() (node, pnpmScript string, err error) {
	pnpmResolution.Do(func() {
		resolvedPnpmNode, resolvedPnpmScript, resolvedPnpmError = resolvePnpmAt(outerCorepackHome)
	})
	return resolvedPnpmNode, resolvedPnpmScript, resolvedPnpmError
}

// PnpmExecutableAt resolves the pinned pnpm from a caller-owned Corepack home.
func PnpmExecutableAt(cacheRoot string) (node, pnpmScript string, err error) {
	return resolvePnpmAt(cacheRoot)
}

func resolvePnpmAt(cacheRoot string) (node, script string, err error) {
	script = filepath.Join(cacheRoot, "v1", "pnpm", SupportedPnpm, "bin", "pnpm.cjs")
	if _, err = os.Stat(script); err != nil {
		diagnostic, diagErr := diag.FromCatalog("KB_TOOLCHAIN_PNPM_UNAVAILABLE", map[string]string{"version": SupportedPnpm, "nextCommand": "corepack install"})
		if diagErr != nil {
			return "", "", diagErr
		}
		return "", "", diagnostic
	}
	node, err = exec.LookPath("node")
	if err != nil {
		return "", "", fmt.Errorf("locate Node.js to run cached pnpm: %w", err)
	}
	return node, script, nil
}

// Run executes an external tool with the operation's shared timeout and emits
// catalogued diagnostics on stalls, including the bounded stderr tail.
func Run(ctx context.Context, invocation Invocation) (Result, error) {
	return run(ctx, invocation, invocation.Operation.timeout())
}

func run(ctx context.Context, invocation Invocation, operationTimeout time.Duration) (Result, error) {
	started := time.Now()
	running, err := startInvocation(ctx, invocation)
	if err != nil {
		return Result{}, &CommandError{Err: err}
	}
	return running.finish(started, operationTimeout)
}

// runningInvocation is a started external tool with its output captured but no
// execution budget applied yet.
type runningInvocation struct {
	ctx        context.Context
	waitCtx    context.Context
	cancel     context.CancelCauseFunc
	command    *exec.Cmd
	invocation Invocation
	stdout     bytes.Buffer
	stderr     tailBuffer
	waitDone   chan struct{}
	waitErr    error
}

// startInvocation starts the external tool and captures its output without
// bounding its execution, so process start can be separated from the stall
// budget under which it is observed.
func startInvocation(ctx context.Context, invocation Invocation) (*runningInvocation, error) {
	command := exec.Command(invocation.Executable, invocation.Args...)
	command.Dir = invocation.Dir
	command.Stdin = invocation.Stdin
	if invocation.Env != nil {
		command.Env = invocation.Env
	}
	running := &runningInvocation{ctx: ctx, command: command, invocation: invocation, waitDone: make(chan struct{})}
	command.Stdout, command.Stderr = &running.stdout, &running.stderr
	if invocation.Stdout != nil {
		command.Stdout = io.MultiWriter(&running.stdout, invocation.Stdout)
	}
	if invocation.Stderr != nil {
		command.Stderr = io.MultiWriter(&running.stderr, invocation.Stderr)
	}
	process, err := child.StartManaged(command, child.ProcessGroup, proc.ChildProcessObserver())
	if err != nil {
		return nil, err
	}
	running.waitCtx, running.cancel = context.WithCancelCause(ctx)
	go func() {
		running.waitErr = process.Wait(running.waitCtx)
		close(running.waitDone)
	}()
	return running, nil
}

// finish arms the operation budget anchored at started, waits for the tool,
// and renders the shared result and catalogued failure diagnostics.
func (r *runningInvocation) finish(started time.Time, operationTimeout time.Duration) (Result, error) {
	callerDeadline, hasCallerDeadline := r.ctx.Deadline()
	operationDeadline := started.Add(operationTimeout)
	callerBound := hasCallerDeadline && callerDeadline.Before(operationDeadline)
	timer := time.AfterFunc(time.Until(operationDeadline), func() {
		r.cancel(context.DeadlineExceeded)
	})
	defer timer.Stop()
	defer r.cancel(context.Canceled)
	<-r.waitDone
	err := r.waitErr
	result := Result{Stdout: r.stdout.String(), Stderr: r.stderr.String(), Elapsed: time.Since(started)}
	if err == nil {
		return result, nil
	}
	if errors.Is(context.Cause(r.waitCtx), context.DeadlineExceeded) {
		if callerBound {
			return result, &TimeoutError{Bound: BoundCaller, Budget: callerDeadline.Sub(started), Elapsed: result.Elapsed}
		}
		values := map[string]string{
			"tool":        diag.RedactText(r.invocation.Tool),
			"argsSummary": summarizeArgs(r.invocation.Args),
			"elapsed":     result.Elapsed.Round(time.Millisecond).String(),
			"stderrTail":  diag.RedactText(strings.TrimRight(result.Stderr, "\r\n")),
			"nextCommand": nextCommand(r.invocation),
		}
		diagnostic, diagErr := diag.FromCatalog("KB_TOOLCHAIN_EXTERNAL_TIMEOUT", values, diag.WithMeta(map[string]any{
			"tool": values["tool"], "argsSummary": values["argsSummary"], "elapsed": values["elapsed"], "stderrTail": values["stderrTail"], "nextCommand": values["nextCommand"],
		}))
		if diagErr != nil {
			return result, diagErr
		}
		return result, diagnostic
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		result.ExitCode = exit.ExitCode()
	}
	return result, &CommandError{ExitCode: result.ExitCode, StdoutTail: diag.RedactText(strings.TrimRight(tailString(result.Stdout, stderrTailLimit), "\r\n")), StderrTail: diag.RedactText(strings.TrimRight(result.Stderr, "\r\n")), Err: err}
}

func tailString(value string, limit int) string {
	if len(value) > limit {
		value = value[len(value)-limit:]
	}
	return strings.ToValidUTF8(value, "�")
}

const stderrTailLimit = 4096

type tailBuffer struct{ data []byte }

func (b *tailBuffer) Write(data []byte) (int, error) {
	b.data = append(b.data, data...)
	if len(b.data) > stderrTailLimit {
		b.data = append([]byte(nil), b.data[len(b.data)-stderrTailLimit:]...)
	}
	return len(data), nil
}
func (b *tailBuffer) String() string {
	return strings.ToValidUTF8(string(b.data), "�")
}
func summarizeArgs(args []string) string { return diag.RedactText(strings.Join(args, " ")) }
func nextCommand(invocation Invocation) string {
	parts := append([]string{invocation.Executable}, invocation.Args...)
	quoted := make([]string, len(parts))
	for index, part := range parts {
		quoted[index] = "'" + strings.ReplaceAll(part, "'", "'\\''") + "'"
	}
	command := strings.Join(quoted, " ")
	if invocation.Dir != "" {
		command = "cd '" + strings.ReplaceAll(invocation.Dir, "'", "'\\''") + "' && " + command
	}
	return diag.RedactText(command)
}

func ValidateNode(version string) error {
	major, err := major(version)
	if err != nil || major != SupportedNodeMajor {
		actualVersion := strings.TrimPrefix(strings.TrimSpace(version), "v")
		diagnostic, diagnosticErr := nodeVersionDiagnostic(actualVersion)
		if diagnosticErr != nil {
			return diagnosticErr
		}
		return diagnostic
	}
	return nil
}

func nodeVersionDiagnostic(actualVersion string) (*diag.Diag, error) {
	return diag.FromCatalog("KB_NODE_VERSION_UNSUPPORTED", map[string]string{
		"requiredMajor": strconv.Itoa(SupportedNodeMajor),
		"actualVersion": actualVersion,
	})
}

func ValidatePnpm(version string) error {
	major, err := major(version)
	if err != nil || major != SupportedPnpmMajor {
		return &ValidationError{Tool: "pnpm", Detected: version, Requirement: fmt.Sprintf("pnpm %d.x", SupportedPnpmMajor), Remediation: PnpmRemediation()}
	}
	return nil
}

func Validate(status Status, requirePnpm bool) error {
	if err := ValidateNode(status.NodeVersion); err != nil {
		return err
	}
	if requirePnpm {
		return ValidatePnpm(status.PnpmVersion)
	}
	return nil
}

func major(version string) (int, error) {
	part := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if i := strings.IndexByte(part, '.'); i >= 0 {
		part = part[:i]
	}
	value, err := strconv.Atoi(part)
	if err != nil {
		return 0, fmt.Errorf("invalid semantic version")
	}
	return value, nil
}
