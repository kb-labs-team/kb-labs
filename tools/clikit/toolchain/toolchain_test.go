package toolchain

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/internal/testdeadline"
	"github.com/kb-labs/clikit/proc/child"
)

var errFixtureExitedBeforeReadiness = errors.New("fixture exited before readiness")

func assertInstallerOperationPathsAllowed(t *testing.T, failure *diag.Diag) {
	t.Helper()
	if failure.Meta == nil {
		failure.Meta = map[string]any{}
	}
	failure.Meta["diagnosticPath"] = filepath.Join(t.TempDir(), "diagnostic.json")
	failure.Meta["logPath"] = filepath.Join(t.TempDir(), "operation.log")
	if _, err := diag.ToEnvelope(failure); err != nil {
		t.Fatalf("installer operation paths violated %s diagnostic contract: %v", failure.Code, err)
	}
}

// case: S-260.4
func TestNodePolicyRejectsOlderAndNewerMajorsWithCatalogDiagnostic(t *testing.T) {
	if err := ValidateNode(fmt.Sprintf("v%d.18.0", SupportedNodeMajor)); err != nil {
		t.Fatal(err)
	}
	for _, major := range []int{SupportedNodeMajor - 4, SupportedNodeMajor + 2} {
		version := fmt.Sprintf("v%d.0.0", major)
		err := ValidateNode(version)
		if err == nil {
			t.Fatalf("%s must be rejected", version)
		}
		var failure *diag.Diag
		if !errors.As(err, &failure) {
			t.Fatalf("%s returned %T, want catalogued diagnostic", version, err)
		}
		envelope, err := diag.ToEnvelope(failure)
		if err != nil {
			t.Fatal(err)
		}
		entry, ok := diag.LookupCatalog("KB_NODE_VERSION_UNSUPPORTED")
		if !ok {
			t.Fatal("Node version diagnostic is absent from the catalog")
		}
		if envelope.Code != entry.Code || envelope.Details["requiredMajor"] != fmt.Sprint(SupportedNodeMajor) || envelope.Details["actualVersion"] != fmt.Sprintf("%d.0.0", major) || len(envelope.Details) != 2 {
			t.Fatalf("unexpected diagnostic envelope or undeclared details: %#v", envelope)
		}
		values := map[string]string{"requiredMajor": fmt.Sprint(SupportedNodeMajor), "actualVersion": fmt.Sprintf("%d.0.0", major)}
		expected, err := diag.FromCatalog(entry.Code, values)
		if err != nil {
			t.Fatal(err)
		}
		expectedEnvelope, err := diag.ToEnvelope(expected)
		if err != nil {
			t.Fatal(err)
		}
		if envelope.Message != expectedEnvelope.Message || envelope.Hint != expectedEnvelope.Hint {
			t.Fatalf("message or hint differs from the contract-checked catalog entry: %#v", envelope)
		}
	}
}

// case: S-261.6
func TestExternalToolStallReturnsCataloguedDiagnostic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	dir := t.TempDir()
	tool := filepath.Join(dir, "never-exits")
	ready := filepath.Join(dir, "ready")
	// The sleep before the readiness signal injects the delayed fixture start
	// of a loaded host; it must not be reported as the stall itself.
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nsleep 2\nprintf 'stalled-tool-output\\n' >&2\n: > \"$READY_FILE\"\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("READY_FILE", ready)
	running, err := startInvocation(context.Background(), Invocation{Tool: "fixture", Executable: tool, Args: []string{"--wait"}, Operation: OperationVersionProbe})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRunningInvocation(t, running)
	if err := waitForReadiness(running, ready, testdeadline.Budget(t)); err != nil {
		t.Fatal(err)
	}
	// The stall budget is injected here, anchored after readiness instead of
	// racing process start.
	stallTimeout := testdeadline.Scale(t, 5*time.Second)
	started := time.Now()
	_, err = running.finish(started, stallTimeout)
	if err == nil {
		t.Fatal("stalled process returned success")
	}
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_TOOLCHAIN_EXTERNAL_TIMEOUT" {
		t.Fatalf("stall failure = %#v", err)
	}
	assertInstallerOperationPathsAllowed(t, failure)
	if elapsed := time.Since(started); elapsed > stallTimeout+testdeadline.ExternalToolTimeoutSlack(t) {
		t.Fatalf("stall bound took %s", elapsed)
	}
	for key, want := range map[string]string{"tool": "fixture", "argsSummary": "--wait", "stderrTail": "stalled-tool-output", "nextCommand": "'" + tool + "' '--wait'"} {
		if got := fmt.Sprint(failure.Meta[key]); !strings.Contains(got, want) {
			t.Errorf("timeout detail %s = %q, want %q", key, got, want)
		}
	}
}

// case: S-261.6
func TestExternalToolExitBeforeReadinessEndsWait(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	tool := filepath.Join(t.TempDir(), "exits-before-ready")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nexit 23\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	running, err := startInvocation(context.Background(), Invocation{Tool: "fixture", Executable: tool})
	if err != nil {
		t.Fatal(err)
	}
	cleanupRunningInvocation(t, running)
	if err := waitForReadiness(running, filepath.Join(t.TempDir(), "never-ready"), testdeadline.Budget(t)); !errors.Is(err, errFixtureExitedBeforeReadiness) {
		t.Fatalf("readiness result = %v, want child-exited signal", err)
	}
	if running.command.ProcessState == nil || running.command.ProcessState.ExitCode() != 23 {
		t.Fatalf("fixture exit state = %#v, want exit code 23", running.command.ProcessState)
	}
}

func cleanupRunningInvocation(t *testing.T, running *runningInvocation) {
	t.Helper()
	t.Cleanup(func() {
		running.cancel(context.Canceled)
		grace := testdeadline.Budget(t)
		select {
		case <-running.waitDone:
		case <-time.After(grace):
			killErr := child.KillTree(running.command.Process.Pid)
			select {
			case <-running.waitDone:
				if killErr != nil {
					t.Errorf("kill fixture process tree during cleanup: %v", killErr)
				}
			case <-time.After(grace):
				t.Errorf("fixture process tree was not reaped during cleanup (kill error: %v)", killErr)
			}
		}
	})
}

func waitForReadiness(running *runningInvocation, ready string, watchdog time.Duration) error {
	readyPoll := time.NewTicker(time.Millisecond)
	defer readyPoll.Stop()
	readyWatchdog := time.NewTimer(watchdog)
	defer readyWatchdog.Stop()
	for {
		if _, err := os.Stat(ready); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect fixture readiness signal: %w", err)
		}
		select {
		case <-running.waitDone:
			return fmt.Errorf("%w: %v", errFixtureExitedBeforeReadiness, running.waitErr)
		case <-readyWatchdog.C:
			return fmt.Errorf("fixture did not signal readiness within %s", watchdog)
		case <-readyPoll.C:
		}
	}
}

// case: S-179.27
func TestCallerDeadlineWinsOverOperationBound(t *testing.T) {
	tool := filepath.Join(t.TempDir(), "never-exits")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	operationBound := 2 * time.Second
	callerBudget := testdeadline.Scale(t, operationBound/20)
	ctx, cancel := context.WithTimeout(context.Background(), callerBudget)
	defer cancel()
	started := time.Now()
	_, err := run(ctx, Invocation{Tool: "fixture", Executable: tool, Operation: OperationWorkspaceTask}, operationBound)
	var timedOut *TimeoutError
	if !errors.As(err, &timedOut) || timedOut.Bound != BoundCaller || timedOut.Budget.Round(time.Millisecond) != callerBudget.Round(time.Millisecond) {
		t.Fatalf("caller deadline error = %#v", err)
	}
	if elapsed := time.Since(started); elapsed > testdeadline.Scale(t, operationBound/2) {
		t.Fatalf("caller deadline took %s", elapsed)
	}
}

// case: S-261.6
func TestExternalToolFailureKeepsExitCodeAndStderrTail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	tool := filepath.Join(t.TempDir(), "failing-tool")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nprintf 'external-tool-stderr-tail\\n' >&2\nexit 47\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := Run(context.Background(), Invocation{Tool: "fixture", Executable: tool, Operation: OperationVersionProbe})
	var failure *CommandError
	if !errors.As(err, &failure) {
		t.Fatalf("external failure = %v, want CommandError", err)
	}
	if failure.ExitCode != 47 || failure.StderrTail != "external-tool-stderr-tail" {
		t.Fatalf("command failure = %#v", failure)
	}
}

// case: S-285.18
func TestSafeCaptureRedactsWholeSplitStreamsBeforeExposure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	tool := filepath.Join(t.TempDir(), "failing-tool")
	const knownSecret = "known secret with spaces"
	const patternSecret = "split-pattern-secret"
	script := "#!/bin/sh\nprintf '%s' '{\"access_' >&1\nprintf '%s' 'token\":\"" + patternSecret + "\"}' >&1\nprintf '%s' 'prefix known secret ' >&2\nprintf '%s\\n' 'with spaces suffix' >&2\nexit 47\n"
	if err := os.WriteFile(tool, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	result, err := Run(context.Background(), Invocation{
		Tool: "fixture", Executable: tool, Operation: OperationPackageManager, SafeCaptureOutput: true,
		Redactions: []string{knownSecret},
		Stdout:     &stdout, Stderr: &stderr,
	})
	var failure *CommandError
	if !errors.As(err, &failure) || failure.ExitCode != 47 {
		t.Fatalf("failure = %#v, want exit code 47", err)
	}
	for label, value := range map[string]string{
		"result stdout": result.Stdout, "result stderr": result.Stderr,
		"command error": err.Error(), "stderr tail": failure.StderrTail,
		"provided stdout writer": stdout.String(), "provided stderr writer": stderr.String(),
	} {
		if strings.Contains(value, patternSecret) || strings.Contains(value, knownSecret) {
			t.Fatalf("%s exposed captured package-manager secret: %q", label, value)
		}
	}
	if !strings.Contains(result.Stdout, "access_token") || !strings.Contains(result.Stdout, "[REDACTED]") ||
		!strings.Contains(result.Stderr, "prefix ") || !strings.Contains(result.Stderr, "suffix") || !strings.Contains(result.Stderr, "[REDACTED]") {
		t.Fatalf("safe output lost useful context: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	if stdout.String() != result.Stdout || stderr.String() != result.Stderr {
		t.Fatalf("caller writers did not receive the sanitized results: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

// case: S-285.18
func TestSafeCaptureDropsWholeStreamWhenLimitIsExceeded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	tool := filepath.Join(t.TempDir(), "oversized-tool")
	const rawSecret = "overflow-pattern-secret"
	const knownSecret = "known overflow secret with spaces"
	stdoutPayload := strings.Repeat("X", 120) + "TOKEN=" + rawSecret + strings.Repeat("Z", 100)
	stderrPayload := strings.Repeat("Y", 120) + knownSecret + strings.Repeat("W", 100)
	script := "#!/bin/sh\nprintf '%s' '" + stdoutPayload + "' >&1\nprintf '%s' '" + stderrPayload + "' >&2\nexit 23\n"
	if err := os.WriteFile(tool, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	result, err := Run(context.Background(), Invocation{
		Tool: "fixture", Executable: tool, Operation: OperationPackageManager,
		SafeCaptureOutput: true, MaxCapturedOutputBytes: 128, Redactions: []string{knownSecret},
		Stdout: &stdout, Stderr: &stderr,
	})
	var failure *CommandError
	if !errors.As(err, &failure) || failure.ExitCode != 23 {
		t.Fatalf("failure = %#v, want exit code 23", err)
	}
	for label, value := range map[string]string{
		"result stdout": result.Stdout, "result stderr": result.Stderr,
		"command error": err.Error(), "stdout tail": failure.StdoutTail, "stderr tail": failure.StderrTail,
		"provided stdout writer": stdout.String(), "provided stderr writer": stderr.String(),
	} {
		if strings.Contains(value, strings.Repeat("X", 10)) || strings.Contains(value, strings.Repeat("Y", 10)) ||
			strings.Contains(value, rawSecret) || strings.Contains(value, knownSecret) || strings.Contains(value, "TOKEN=") {
			t.Fatalf("%s retained a raw stream prefix after overflow: %q", label, value)
		}
	}
	if !strings.Contains(result.Stdout, "omitted") || !strings.Contains(result.Stderr, "omitted") ||
		stdout.String() != result.Stdout || stderr.String() != result.Stderr {
		t.Fatalf("overflow did not produce safe notices: result=%#v stdout=%q stderr=%q", result, stdout.String(), stderr.String())
	}
}

// case: S-285.18
func TestSafeCaptureTimeoutBoundsStderrAndKeepsStdoutOverflowNotice(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture requires POSIX")
	}
	tool := filepath.Join(t.TempDir(), "timeout-tool")
	const captureLimit = 16 * 1024
	stdoutPayload := strings.Repeat("O", captureLimit+1)
	stderrPayload := strings.Repeat("E", 12*1024)
	script := "#!/bin/sh\nprintf '%s' '" + stdoutPayload + "' >&1\nprintf '%s' '" + stderrPayload + "' >&2\nsleep 5\n"
	if err := os.WriteFile(tool, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := run(context.Background(), Invocation{
		Tool: "fixture", Executable: tool, Args: []string{"--fixture"}, Operation: OperationPackageManager,
		SafeCaptureOutput: true, MaxCapturedOutputBytes: captureLimit,
	}, testdeadline.Scale(t, 500*time.Millisecond))
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_TOOLCHAIN_EXTERNAL_TIMEOUT" {
		t.Fatalf("timeout error = %#v", err)
	}
	tail, _ := failure.Meta["stderrTail"].(string)
	if len(tail) > stderrTailLimit || !strings.Contains(tail, "stdout omitted") || !strings.Contains(tail, strings.Repeat("E", 10)) ||
		result.StdoutOmitted != true || result.StderrOmitted {
		t.Fatalf("timeout lost bounded stderr or stdout omission: len=%d result=%#v tail=%q", len(tail), result, tail)
	}
}

func TestStderrCaptureKeepsUTF8WithinByteLimit(t *testing.T) {
	var capture tailBuffer
	_, _ = capture.Write([]byte(strings.Repeat("界", stderrTailLimit/3+8)))
	got := capture.String()
	if !utf8.ValidString(got) || len(got) > stderrTailLimit {
		t.Fatalf("captured tail is invalid UTF-8 or exceeds byte bound: valid=%v len=%d", utf8.ValidString(got), len(got))
	}
}

// case: S-261.6
func TestPnpmResolutionUsesCapturedOuterCorepackCacheAndFailsWithoutDownload(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	_, _, err := resolvePnpmAt(cache)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_TOOLCHAIN_PNPM_UNAVAILABLE" {
		t.Fatalf("missing cached pnpm = %v", err)
	}
	if failure.Hint == "" || !strings.Contains(failure.Hint, "corepack install") {
		t.Fatalf("missing exact cache remediation: %q", failure.Hint)
	}
	script := filepath.Join(cache, "v1", "pnpm", SupportedPnpm, "bin", "pnpm.cjs")
	if err := os.MkdirAll(filepath.Dir(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	_, got, err := resolvePnpmAt(cache)
	if err != nil || got != script {
		t.Fatalf("cached pnpm = %q, %v; want %q", got, err, script)
	}
}

func TestPnpmExecutableUsesScratchCorepackHomeOfflineWithXDGCacheMismatch(t *testing.T) {
	if os.Getenv("KB_TEST_PNPM_EXECUTABLE_CHILD") == "1" {
		_, script, err := PnpmExecutable()
		if err != nil {
			t.Fatalf("resolve pnpm from explicit Corepack home: %v", err)
		}
		if want := os.Getenv("KB_TEST_PNPM_EXECUTABLE_SCRIPT"); script != want {
			t.Fatalf("resolved pnpm = %q, want explicit Corepack cache file %q", script, want)
		}
		if got, err := exec.Command(mustNode(t), script).CombinedOutput(); err != nil || string(got) != "offline-pnpm-cache-hit" {
			t.Fatalf("run cached pnpm offline = %q, %v", got, err)
		}
		return
	}

	corepackHome := t.TempDir()
	xdgCacheHome := t.TempDir()
	script := filepath.Join(corepackHome, "v1", "pnpm", SupportedPnpm, "bin", "pnpm.cjs")
	if err := os.MkdirAll(filepath.Dir(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(`process.stdout.write(process.env.COREPACK_ENABLE_NETWORK === '0' ? 'offline-pnpm-cache-hit' : 'network-enabled')`), 0o600); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(os.Args[0], "-test.run=^TestPnpmExecutableUsesScratchCorepackHomeOfflineWithXDGCacheMismatch$")
	env := make([]string, 0, len(os.Environ())+5)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key != "COREPACK_HOME" && key != "XDG_CACHE_HOME" && key != "COREPACK_ENABLE_NETWORK" && key != "KB_TEST_PNPM_EXECUTABLE_CHILD" && key != "KB_TEST_PNPM_EXECUTABLE_SCRIPT" {
			env = append(env, entry)
		}
	}
	command.Env = append(env,
		"KB_TEST_PNPM_EXECUTABLE_CHILD=1",
		"KB_TEST_PNPM_EXECUTABLE_SCRIPT="+script,
		"COREPACK_HOME="+corepackHome,
		"XDG_CACHE_HOME="+xdgCacheHome,
		"COREPACK_ENABLE_NETWORK=0",
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("PnpmExecutable child failed with COREPACK_HOME overriding XDG_CACHE_HOME: %v\n%s", err, output)
	}
}

func mustNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("locate Node.js for cached pnpm fixture: %v", err)
	}
	return node
}

func TestPnpmResolutionDiagnosticSupportsInstallerOperationPaths(t *testing.T) {
	_, _, err := resolvePnpmAt(t.TempDir())
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_TOOLCHAIN_PNPM_UNAVAILABLE" {
		t.Fatalf("missing cached pnpm = %v", err)
	}
	assertInstallerOperationPathsAllowed(t, failure)
}

// case: S-260.4
func TestNodeRemediationRendersTheCatalogHint(t *testing.T) {
	entry, ok := diag.LookupCatalog("KB_NODE_VERSION_UNSUPPORTED")
	if !ok {
		t.Fatal("Node version diagnostic is absent from the catalog")
	}
	expected, err := diag.FromCatalog(entry.Code, map[string]string{
		"requiredMajor": fmt.Sprint(SupportedNodeMajor), "actualVersion": "unknown",
	})
	if err != nil {
		t.Fatal(err)
	}
	expectedEnvelope, err := diag.ToEnvelope(expected)
	if err != nil {
		t.Fatal(err)
	}
	want := expectedEnvelope.Hint
	if got := NodeRemediation(); got != want {
		t.Fatalf("NodeRemediation() = %q; want catalog hint %q", got, want)
	}
}

// case: S-285.18
func TestCommandFailureDiagnosticIncludesSafeStderr(t *testing.T) {
	failure := &CommandError{Err: errors.New("exit status 1"), StderrTail: strings.Repeat("x", stderrTailLimit+32) + "\nAPI_TOKEN=supersecret\nregistry unavailable"}
	diagnostic := diag.Wrap(failure, "KB_RUNTIME_UNEXPECTED", "command failed", diag.WithCauseAndReason(failure.Error()))
	if !strings.Contains(diagnostic.Reason, "registry unavailable") || strings.Contains(diagnostic.Reason, "supersecret") || len(diagnostic.Reason) > stderrTailLimit+100 {
		t.Fatalf("diagnostic reason is missing safe bounded stderr: %q", diagnostic.Reason)
	}
}
