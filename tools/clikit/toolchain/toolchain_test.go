package toolchain

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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
