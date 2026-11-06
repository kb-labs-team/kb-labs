//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/kb-runner/internal/proc"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
)

var testIsolatedHome string
var testRunnerHome string

func TestMain(m *testing.M) {
	// Every package test and every runner subprocess inherits an isolated home
	// and explicit fake vendor executables. Provider discovery can never fall
	// through to the lead's installed binaries or credentials.
	testRunnerHome = os.Getenv("HOME")
	if testRunnerHome == "" {
		fmt.Fprintln(os.Stderr, "HOME is required to resolve the runner Go module cache")
		os.Exit(2)
	}
	home, err := os.MkdirTemp("", "kb-runner-tests-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	testIsolatedHome = filepath.Clean(home)
	tmp := filepath.Join(home, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		_ = os.RemoveAll(home)
		os.Exit(2)
	}
	// Preserve Go's existing shared caches before changing HOME; otherwise a
	// test that builds the CLI would create a second module cache under the
	// temporary home and attempt downloads.
	cacheOutput, err := exec.Command("go", "env", "GOPATH", "GOMODCACHE", "GOCACHE").Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		_ = os.RemoveAll(home)
		os.Exit(2)
	}
	caches := strings.Split(strings.TrimSpace(string(cacheOutput)), "\n")
	if len(caches) != 3 {
		fmt.Fprintln(os.Stderr, "go env returned an unexpected cache configuration")
		_ = os.RemoveAll(home)
		os.Exit(2)
	}
	setTestEnv("GOPATH", caches[0])
	setTestEnv("GOMODCACHE", caches[1])
	setTestEnv("GOCACHE", caches[2])
	setTestEnv("HOME", home)
	setTestEnv("TMPDIR", tmp)
	setTestEnv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	setTestEnv("XDG_STATE_HOME", filepath.Join(home, ".state"))
	seenBinaries := map[string]bool{}
	for _, vendor := range vendors() {
		spec := vendorRegistry[vendor]
		if !spec.agent || seenBinaries[spec.binaryEnv] {
			continue
		}
		seenBinaries[spec.binaryEnv] = true
		fake := filepath.Join(home, "bin", vendor)
		if err := os.MkdirAll(filepath.Dir(fake), 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 97\n"), 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		setTestEnv(spec.binaryEnv, fake)
	}
	setTestEnv("PATH", filepath.Join(home, "bin")+string(os.PathListSeparator)+os.Getenv("PATH"))
	code := m.Run()
	if err := os.RemoveAll(home); err != nil {
		fmt.Fprintln(os.Stderr, err)
		if code == 0 {
			code = 2
		}
	}
	os.Exit(code)
}

func setTestRunnerHome(t *testing.T) {
	t.Helper()
	if testRunnerHome == "" {
		t.Fatal("real runner HOME was not captured by TestMain")
	}
	t.Setenv("HOME", testRunnerHome)
}

func setTestEnv(key, value string) {
	if err := os.Setenv(key, value); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

func cancellableProcTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

// case: S-237.54
func TestRootHelpSpellingsReturnUsageSuccessfully(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}, {"help"}} {
		var stdout, stderr bytes.Buffer
		status := executeInvocation("kb-runner", args, &stdout, &stderr)
		if status.Code() != 0 {
			t.Fatalf("executeCommand(%q) exit = %d; stdout=%s stderr=%s", args, status.Code(), stdout.String(), stderr.String())
		}
		if !strings.Contains(stdout.String(), "Usage: kb-runner") {
			t.Fatalf("executeCommand(%q) did not print root usage: %s", args, stdout.String())
		}
	}
}

// case: S-237.72
func TestPSJSONIncludesHostDecisionAndRunMeasurements(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	run, err := proc.Start(cancellableProcTestContext(t), proc.Config{StateDir: state, Tag: "json-measurement", CostKey: "json-measurement", CostClass: proc.CostLight,
		Stall: time.Hour, StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{"/bin/sleep", "30"},
	})
	if err != nil {
		t.Fatalf("start JSON measurement fixture: %v", err)
	}
	t.Cleanup(func() {
		if err := run.Kill(); err != nil {
			t.Logf("stop JSON measurement fixture: %v", err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for JSON measurement fixture: %v", err)
		}
	})
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"ps", "--state", state, "--json"}, &stdout, &stderr)
	if status.Code() != 0 {
		t.Fatalf("ps --json exit=%d stdout=%s stderr=%s", status.Code(), stdout.String(), stderr.String())
	}
	var listing struct {
		Runs             []map[string]json.RawMessage `json:"runs"`
		Host             json.RawMessage              `json:"host"`
		GovernorDecision string                       `json:"governor_decision"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &listing); err != nil {
		t.Fatalf("decode ps JSON: %v: %s", err, stdout.String())
	}
	if len(listing.Runs) != 1 || len(listing.Host) == 0 || listing.GovernorDecision == "" {
		t.Fatalf("ps JSON omitted runs, host, or governor decision: %s", stdout.String())
	}
	for _, field := range []string{"average_cpu", "peak_rss_bytes", "cost_class", "paused"} {
		if _, exists := listing.Runs[0][field]; !exists {
			t.Fatalf("ps JSON run omitted %q: %s", field, stdout.String())
		}
	}
	var startedAt string
	if err := json.Unmarshal(listing.Runs[0]["started_at"], &startedAt); err != nil {
		t.Fatalf("ps JSON started_at is not a timestamp string: %s", stdout.String())
	}
	if _, err := time.Parse(time.RFC3339Nano, startedAt); err != nil {
		t.Fatalf("ps JSON started_at is not an RFC3339Nano timestamp: %s", stdout.String())
	}
	var identity string
	if err := json.Unmarshal(listing.Runs[0]["identity"], &identity); err != nil || identity == "" {
		t.Fatalf("ps JSON omitted process identity: %s", stdout.String())
	}
}

// case: S-237.73
func TestPSJSONReportsCompletedRunContract(t *testing.T) {
	state := t.TempDir()
	runner := buildRunnerBinary(t)
	stdoutPath := filepath.Join(state, "stdout.log")
	command := exec.Command(runner, "run", "--tag", "costprobe", "--state", state, "--stall", "1m",
		"--stdout", stdoutPath, "--stderr", filepath.Join(state, "stderr.log"), "--", "/bin/echo", "ok")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run successful command: %v\n%s", err, output)
	}
	if got := string(output); got != "ok\nrun costprobe completed\n" {
		t.Fatalf("terminal output = %q, want child output and completion line", got)
	}
	if data, err := os.ReadFile(stdoutPath); err != nil || string(data) != "ok\n" {
		t.Fatalf("stdout file = %q, err=%v", data, err)
	}
	ps := exec.Command(runner, "ps", "--json", "--state", state)
	jsonOutput, err := ps.CombinedOutput()
	if err != nil {
		t.Fatalf("ps --json failed: %v\n%s", err, jsonOutput)
	}
	var listing struct {
		Runs []json.RawMessage `json:"runs"`
	}
	if err := json.Unmarshal(jsonOutput, &listing); err != nil {
		t.Fatalf("decode ps --json output: %v\n%s", err, jsonOutput)
	}
	if len(listing.Runs) != 1 {
		t.Fatalf("ps --json returned %d runs, want 1: %s", len(listing.Runs), jsonOutput)
	}
	var run proc.RunInfo
	if err := json.Unmarshal(listing.Runs[0], &run); err != nil {
		t.Fatalf("decode completed run: %v", err)
	}
	if run.Status != proc.StatusCompleted || run.ExitCode == nil || *run.ExitCode != 0 {
		t.Fatalf("ps --json outcome = status %q, exit code %v; want completed with code 0", run.Status, run.ExitCode)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(listing.Runs[0], &fields); err != nil {
		t.Fatalf("decode completed run fields: %v", err)
	}
	var startedAt string
	if err := json.Unmarshal(fields["started_at"], &startedAt); err != nil {
		t.Fatalf("ps --json started_at is not a timestamp string: %s", listing.Runs[0])
	}
	if _, err := time.Parse(time.RFC3339Nano, startedAt); err != nil || !strings.HasSuffix(startedAt, "Z") {
		t.Fatalf("ps --json started_at = %q, want RFC3339Nano UTC; err=%v", startedAt, err)
	}
	if run.Identity == "" {
		t.Fatal("ps --json omitted process identity")
	}
	events, err := os.Open(filepath.Join(state, "events.jsonl"))
	if err != nil {
		t.Fatalf("open event stream: %v", err)
	}
	defer events.Close()
	exitEvents := 0
	readErr := proc.ReadEvents(events, func(event proc.Event) error {
		if event.Type != proc.EventExit {
			return nil
		}
		exitEvents++
		if event.Status != run.Status || event.ExitCode == nil || *event.ExitCode != *run.ExitCode {
			return fmt.Errorf("exit event outcome = status %q, exit code %v; ps outcome = status %q, exit code %v", event.Status, event.ExitCode, run.Status, run.ExitCode)
		}
		return nil
	})
	if readErr != nil {
		t.Fatalf("read lifecycle events: %v", readErr)
	}
	if exitEvents != 1 {
		t.Fatalf("exit event count = %d, want 1", exitEvents)
	}
}

// case: S-237.54
func TestBuiltRunnerHelpAndUnknownCommandHintAreRunnable(t *testing.T) {
	runner := buildRunnerBinary(t)
	for _, args := range [][]string{{"--help"}, {"help"}, {"gate", "--help"}, {"own", "--help"}, {"proc", "--help"}} {
		command := exec.Command(runner, args...)
		var stdout, stderr bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = &stderr
		err := command.Run()
		if err != nil || !strings.Contains(stdout.String(), "Usage: kb-runner") || stderr.Len() != 0 {
			t.Fatalf("built kb-runner %v: %v; stdout=%s stderr=%s", args, err, stdout.String(), stderr.String())
		}
	}
	unknown := exec.Command(runner, "missing")
	output, err := unknown.CombinedOutput()
	if err == nil {
		t.Fatalf("unknown command succeeded: %s", output)
	}
	if !strings.Contains(string(output), "kb-runner --help") {
		t.Fatalf("unknown command omitted its usable help hint: %s", output)
	}
	help := exec.Command(runner, "--help")
	helpOutput, helpErr := help.CombinedOutput()
	if helpErr != nil || !strings.Contains(string(helpOutput), "Usage: kb-runner") {
		t.Fatalf("unknown command hint did not lead to runner usage: %v; output=%s", helpErr, helpOutput)
	}
}

// case: S-237.54
func TestNextHintQuotesInvokedExecutablePath(t *testing.T) {
	runner := buildRunnerBinary(t)
	executable := filepath.Join(t.TempDir(), "runner with spaces")
	if err := os.Symlink(runner, executable); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "run")
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("incomplete run unexpectedly succeeded: %s", output)
	}
	hint := shellQuote(executable) + " run --help"
	if !strings.Contains(string(output), "next: "+hint) {
		t.Fatalf("next hint did not quote the invoked path: %s", output)
	}
	command = exec.Command(executable, "run", "--help")
	output, err = command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "Usage of run:") {
		t.Fatalf("quoted hint target was not usable: %v; output=%s", err, output)
	}
}

// case: S-237.54
func TestEveryNextHintPathNamesRegisteredCommand(t *testing.T) {
	const invokedRunner = "runner-from-invocation"
	fakeCodex := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(fakeCodex, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", fakeCodex)
	registered := make(map[string]bool, len(runnerCommands))
	for _, entry := range runnerCommands {
		if registered[entry.name] {
			t.Fatalf("runner command %q is registered twice", entry.name)
		}
		registered[entry.name] = true
	}
	type invocation struct {
		name     string
		args     []string
		runID    string
		runState string
	}
	invalidState := filepath.Join(t.TempDir(), "state-is-a-file")
	if err := os.WriteFile(invalidState, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	outputDir := t.TempDir()
	invocations := make([]invocation, 0, len(runnerCommands)+40)
	for _, entry := range runnerCommands {
		if entry.name == "status" || entry.name == "limits" {
			invocations = append(invocations, invocation{name: entry.name + " help", args: []string{entry.name, "--help"}})
			continue
		}
		invocations = append(invocations, invocation{name: entry.name, args: []string{entry.name}})
	}
	invocations = append(invocations,
		invocation{name: "run missing command", args: []string{"run"}},
		invocation{name: "run missing required flags", args: []string{"run", "--", "/bin/true"}},
		invocation{name: "run invalid min-free", args: []string{"run", "--min-free", "not-bytes"}},
		invocation{name: "run invalid memory", args: []string{"run", "--mem", "not-size"}},
		invocation{name: "run invalid disk", args: []string{"run", "--disk", "not-size"}},
		invocation{name: "run invalid CPU range", args: []string{"run", "--cpus", "not-a-range"}},
		invocation{name: "run state cannot be created", args: []string{"run", "--tag", "hint-run", "--state", invalidState, "--stall", "1s", "--stdout", filepath.Join(outputDir, "stdout"), "--stderr", filepath.Join(outputDir, "stderr"), "--", "/bin/true"}},
		invocation{name: "quota missing options", args: []string{"quota", "set", "--state", t.TempDir()}},
		invocation{name: "quota unknown action", args: []string{"quota", "unknown", "--state", t.TempDir()}},
		invocation{name: "quota set invalid resource", args: []string{"quota", "set", "--state", invalidState, "--memory", "not-size"}},
		invocation{name: "quota set cannot open state", args: []string{"quota", "set", "--state", invalidState, "--memory", "100B"}},
		invocation{name: "quota show invalid state", args: []string{"quota", "show", "--state", invalidState}},
		invocation{name: "events invalid filter", args: []string{"events", "--state", t.TempDir(), "--filter", "unknown"}},
		invocation{name: "events cannot read state", args: []string{"events", "--state", invalidState}},
		invocation{name: "wait missing tag", args: []string{"wait", "--state", t.TempDir()}},
		invocation{name: "wait cannot read state", args: []string{"wait", "--tag", "missing", "--state", invalidState}},
		invocation{name: "gate usage", args: []string{"gate"}},
		invocation{name: "gate status cannot read state", args: []string{"gate", "status", "maintenance", "--state", invalidState}},
		invocation{name: "proc invalid PID", args: []string{"proc", "identity", "not-a-pid"}},
		invocation{name: "proc nonpositive PID", args: []string{"proc", "identity", "0"}},
		invocation{name: "proc dead PID", args: []string{"proc", "identity", "2147483647"}},
		invocation{name: "proc nonnumeric invocation", args: []string{"proc"}},
		invocation{name: "quota missing state", args: []string{"quota", "set"}},
		invocation{name: "ps missing state", args: []string{"ps"}},
		invocation{name: "ps list cannot read state", args: []string{"ps", "--state", invalidState}},
		invocation{name: "ps leftovers cannot read state", args: []string{"ps", "--leftovers", "--state", invalidState}},
		invocation{name: "events missing state", args: []string{"events"}},
		invocation{name: "gate status missing state", args: []string{"gate", "status", "maintenance"}},
		invocation{name: "own usage", args: []string{"own"}},
		invocation{name: "own path without run", args: []string{"own", "path"}},
		invocation{name: "own path invalid syntax", args: []string{"own", "path", "--create"}, runID: "hint-run", runState: t.TempDir()},
		invocation{name: "own Compose syntax", args: []string{"own", "docker-compose", "hint-project"}, runID: "hint-run", runState: t.TempDir()},
		invocation{name: "own path registration failure", args: []string{"own", "path", "--create", "file", filepath.Join(outputDir, "owned-path")}, runID: "hint-run", runState: invalidState},
		invocation{name: "own Compose registration failure", args: []string{"own", "docker-compose", "hint-project", "-f", filepath.Join(outputDir, "compose.yml"), "--", "docker", "compose"}, runID: "hint-run", runState: invalidState},
		invocation{name: "own container registration failure", args: []string{"own", "container", "hint-container"}, runID: "hint-run", runState: invalidState},
		invocation{name: "own network registration failure", args: []string{"own", "network", "hint-network"}, runID: "hint-run", runState: invalidState},
		invocation{name: "own volume registration failure", args: []string{"own", "volume", "hint-volume"}, runID: "hint-run", runState: invalidState},
		invocation{name: "own unsupported resource kind", args: []string{"own", "unsupported", "hint-resource"}, runID: "hint-run", runState: invalidState},
		invocation{name: "gc missing state", args: []string{"gc"}},
		invocation{name: "gc cannot read state", args: []string{"gc", "--state", invalidState}},
	)
	for _, test := range invocations {
		t.Run(test.name, func(t *testing.T) {
			if strings.HasSuffix(test.name, " help") {
				var stdout, stderr bytes.Buffer
				status := executeInvocation(invokedRunner, test.args, &stdout, &stderr)
				if status.Code() != 0 || !strings.Contains(stdout.String(), "Usage:") || stderr.Len() != 0 {
					t.Fatalf("help output: exit=%d stdout=%s stderr=%s", status.Code(), stdout.String(), stderr.String())
				}
				return
			}
			if test.runID != "" {
				t.Setenv("KBLABS_CLIPROC_RUN", test.runID)
				t.Setenv("KBLABS_CLIPROC_STATE", test.runState)
			} else {
				t.Setenv("KBLABS_CLIPROC_RUN", "")
				t.Setenv("KBLABS_CLIPROC_STATE", "")
			}
			var stdout, stderr bytes.Buffer
			_ = executeInvocation(invokedRunner, test.args, &stdout, &stderr)
			output := stderr.String() + stdout.String()
			if !strings.Contains(output, "next: ") {
				t.Fatalf("emitted no next hint: stdout=%s stderr=%s", stdout.String(), stderr.String())
			}
			assertNextHintCommand(t, invokedRunner, registered, output)
		})
	}
}

// case: S-237.138
func TestKeeperDispatchRunsBeforeTestMain(t *testing.T) {
	state := t.TempDir()
	falseCommand, err := exec.LookPath("false")
	if err != nil {
		t.Fatalf("locate false command fixture: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Scale(t, 2*time.Second))
	defer cancel()
	run, err := proc.Start(ctx, proc.Config{StateDir: state, Tag: "testmain-keeper-dispatch", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
		Command: []string{falseCommand},
	})
	if err != nil {
		t.Fatalf("Start from a test binary with an unaware TestMain: %v", err)
	}
	if err := run.Wait(); err == nil {
		t.Fatal("supervised false command unexpectedly succeeded")
	}
}

// case: S-237.138
func TestKeeperDispatchDoesNotUseCommandLineArgument(t *testing.T) {
	runner := buildRunnerBinary(t)
	command := exec.Command(runner, "__keeper")
	output, err := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 {
		t.Fatalf("ordinary __keeper argument exit = %v, want command-resolution failure; output=%s", err, output)
	}
	if strings.Contains(string(output), "keeper must be started by proc.Start") {
		t.Fatalf("ordinary __keeper argument entered keeper mode: %s", output)
	}
}

// case: S-237.54
func TestRunNonzeroCommandEmitsRegisteredHint(t *testing.T) {
	runner := buildRunnerBinary(t)
	state := t.TempDir()
	failingCommand, err := exec.LookPath("false")
	if err != nil {
		t.Fatalf("locate false command fixture: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	command := exec.CommandContext(ctx, runner, "run", "--tag", "hint-run-exit", "--state", state,
		"--stall", "1h", "--stdout", filepath.Join(state, "exit-stdout"),
		"--stderr", filepath.Join(state, "exit-stderr"), "--", failingCommand)
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("built runner did not finish the failed supervised command before the test budget: %v; output=%s", ctx.Err(), output)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("built runner exit = %v, want supervised command status 1; output=%s", err, output)
	}
	if !strings.Contains(string(output), "supervised command exited with status 1") {
		t.Fatalf("built runner omitted the supervised-command failure: %s", output)
	}
	registered := make(map[string]bool, len(runnerCommands))
	for _, entry := range runnerCommands {
		registered[entry.name] = true
	}
	assertNextHintCommand(t, runner, registered, string(output))
}

// case: S-237.54
func TestRuntimeNextHintBranchesNameRegisteredCommands(t *testing.T) {
	const invokedRunner = "runner-from-invocation"
	registered := make(map[string]bool, len(runnerCommands))
	for _, entry := range runnerCommands {
		registered[entry.name] = true
	}
	state := t.TempDir()
	root := runnerRoot{Root: command.InvocationRoot(invokedRunner), invocation: invokedRunner}
	var output bytes.Buffer
	_, lostErr := renderWaitOutcome(proc.RunInfo{Tag: "lost", Status: proc.StatusLost, Error: "keeper disappeared"}, state, &output, invokedRunner)
	hints := []string{
		procInventoryFailure(invokedRunner, invokedRunner, errors.New("host process table denied")).Error(),
		procIdentityFailure(invokedRunner, invokedRunner, 1, errors.New("permission denied")).Error(),
		supervisedCommandFailure(root, state, 1).Error(),
		keeperWaitFailure(root, state, errors.New("keeper wait failed")).Error(),
		lostErr.Error(),
		ownFailure(invokedRunner, invokedRunner, []string{"path", "--create", "file", "/tmp/path with space"}, state,
			proc.Resource{Kind: proc.ResourcePath, ID: "/tmp/path with space"},
			&proc.PathXattrUnsupportedError{Filesystem: "recorded fixture", Path: "/tmp/path with space"}).Error(),
	}
	for _, hint := range hints {
		assertNextHintCommand(t, invokedRunner, registered, hint)
	}
}

func assertNextHintCommand(t *testing.T, invokedRunner string, registered map[string]bool, output string) {
	t.Helper()
	parts := strings.Split(output, "next: ")
	if len(parts) < 2 {
		t.Fatalf("emitted no next hint: %s", output)
	}
	for _, part := range parts[1:] {
		command := strings.TrimSpace(strings.SplitN(part, "\n", 2)[0])
		fields := strings.Fields(command)
		if len(fields) == 0 {
			t.Fatalf("emitted an empty next hint: %q", output)
		}
		commandName := strings.Trim(fields[0], "`'\"")
		if strings.HasPrefix(command, shellQuote(os.Args[0])) {
			commandName = os.Args[0]
		}
		if commandName != invokedRunner {
			if _, err := exec.LookPath(commandName); err != nil {
				t.Fatalf("hint starts with unavailable command %q: %v", commandName, err)
			}
		} else {
			if len(fields) < 2 {
				t.Fatalf("hint names an unregistered runner command: %q", fields)
			}
			rootCommand := strings.Trim(fields[1], "`'\"")
			if rootCommand != "--help" && rootCommand != "-h" && rootCommand != "help" && !registered[rootCommand] {
				t.Fatalf("hint names an unregistered runner command: %q", fields)
			}
			if fields[len(fields)-1] == "--help" || rootCommand == "--help" || rootCommand == "-h" || rootCommand == "help" {
				helpArgs := make([]string, 0, len(fields)-1)
				for _, field := range fields[1:] {
					helpArgs = append(helpArgs, strings.Trim(field, "`'\""))
				}
				if rootCommand == "--help" || rootCommand == "-h" || rootCommand == "help" {
					helpArgs = []string{rootCommand}
				}
				var helpOut, helpErr bytes.Buffer
				status := executeInvocation(invokedRunner, helpArgs, &helpOut, &helpErr)
				if status.Code() != 0 {
					t.Fatalf("hint help invocation %q was not usable: exit=%d stdout=%q stderr=%q", helpArgs, status.Code(), helpOut.String(), helpErr.String())
				}
			}
		}

		assertSingleRunnableHintCommand(t, commandName, command)
	}
}

func assertSingleRunnableHintCommand(t *testing.T, commandName, command string) {
	t.Helper()
	binDir := t.TempDir()
	stubPath := filepath.Join(binDir, commandName)
	if strings.ContainsRune(commandName, filepath.Separator) {
		stubPath = filepath.Join(binDir, "hint-command")
		quotedExecutable := shellQuote(commandName)
		if !strings.HasPrefix(command, quotedExecutable) {
			t.Fatalf("next hint does not begin with its quoted executable %q: %s", commandName, command)
		}
		command = shellQuote(stubPath) + strings.TrimPrefix(command, quotedExecutable)
	}
	const stub = "#!/bin/sh\nprintf x >> \"$NEXT_HINT_CALLS\"\n"
	if err := os.WriteFile(stubPath, []byte(stub), 0o700); err != nil {
		t.Fatal(err)
	}
	callsPath := filepath.Join(binDir, "calls")
	budget := testdeadline.Budget(t)
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	output, err := runHintCommand(ctx, command, []string{"PATH=" + binDir, "NEXT_HINT_CALLS=" + callsPath}, budget)
	if err != nil {
		t.Fatalf("next hint is not a runnable command %q: %v (%s)", command, err, output)
	}
	calls, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatalf("next hint did not execute its command %q: %v", command, err)
	}
	if string(calls) != "x" {
		t.Fatalf("next hint must contain exactly one command, got %d command invocations for %q", len(calls), command)
	}
}

// case: S-237.69
func TestHintCommandCancellationKillsProcessGroup(t *testing.T) {
	budget := testdeadline.Budget(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := t.TempDir()
	pidPath := filepath.Join(state, "descendant.pid")
	var childPID int
	t.Cleanup(func() {
		if childPID > 0 {
			_ = syscall.Kill(childPID, syscall.SIGKILL)
		}
	})
	childCommand := "/bin/sleep 300"
	if runtime.GOOS == "linux" {
		childCommand = "setsid /bin/sleep 300"
	}
	command := shellQuote("/bin/sh") + " -c " + shellQuote(`(`+childCommand+`) & echo $! > "$HINT_DESCENDANT_PID"; wait`)
	result := make(chan error, 1)
	go func() {
		_, err := runHintCommand(ctx, command, []string{"PATH=" + os.Getenv("PATH"), "HINT_DESCENDANT_PID=" + pidPath}, budget)
		result <- err
	}()
	pidDeadline := time.NewTimer(budget)
	defer pidDeadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for childPID == 0 {
		data, err := os.ReadFile(pidPath)
		if err == nil {
			childPID, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		} else if !os.IsNotExist(err) {
			t.Fatalf("read hint descendant pid: %v", err)
		}
		if childPID != 0 {
			break
		}
		select {
		case <-poll.C:
		case <-pidDeadline.C:
			t.Fatalf("hint descendant did not start before %s", budget)
		}
	}
	childIdentity, childAlive, identityErr := proc.ProcessIdentity(childPID)
	if identityErr != nil || !childAlive || childIdentity == "" {
		t.Fatalf("inspect hint descendant before cancellation: pid=%d identity=%q alive=%t err=%v", childPID, childIdentity, childAlive, identityErr)
	}
	cancel()
	var cancellationErr error
	select {
	case err := <-result:
		cancellationErr = err
		if err == nil || !strings.Contains(err.Error(), "HINT_COMMAND_CANCELED") {
			t.Fatalf("hint cancellation error = %v, want HINT_COMMAND_CANCELED", err)
		}
	case <-time.After(budget):
		t.Fatalf("hint command did not stop its process group within %s", budget)
	}
	currentIdentity, childAlive, identityErr := proc.ProcessIdentity(childPID)
	if identityErr != nil {
		t.Fatalf("inspect hint descendant after supervised cancellation: pid=%d expected=%q err=%v", childPID, childIdentity, identityErr)
	}
	if childAlive && currentIdentity == childIdentity {
		t.Fatalf("hint descendant %d survived supervised cancellation: identity=%q teardown=%v", childPID, childIdentity, cancellationErr)
	}
}

func TestHintCommandDeadlineReturnsNamedTimeout(t *testing.T) {
	t.Setenv("KB_TEST_DEADLINE_SCALE", "0.05")
	budget := testdeadline.Budget(t)
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	output, err := runHintCommand(ctx, "exec /bin/sleep 300", []string{"PATH=/bin"}, budget)
	if err == nil || !strings.Contains(err.Error(), "HINT_COMMAND_TIMEOUT") {
		t.Fatalf("hint deadline error = %v, want HINT_COMMAND_TIMEOUT (output %q)", err, output)
	}
	if !strings.Contains(err.Error(), "budget=") || !strings.Contains(err.Error(), "elapsed=") || !strings.Contains(err.Error(), "host_load=") {
		t.Fatalf("hint timeout diagnostic lacks budget, elapsed time, or host load: %v", err)
	}
}

func runHintCommand(ctx context.Context, command string, env []string, budget time.Duration) ([]byte, error) {
	started := time.Now()
	state, err := os.MkdirTemp("", "kb-runner-hint-run-")
	if err != nil {
		return nil, fmt.Errorf("create hint run state: %w", err)
	}
	defer os.RemoveAll(state)
	stdoutPath := filepath.Join(state, "stdout")
	stderrPath := filepath.Join(state, "stderr")
	run, err := proc.Start(ctx, proc.Config{
		StateDir: state, Tag: "hint-command", Stall: budget,
		StdoutPath: stdoutPath, StderrPath: stderrPath,
		Command: []string{"/bin/sh", "-c", command}, Env: env, CleanEnv: true,
	})
	if err != nil {
		return nil, fmt.Errorf("start supervised hint command: %w", err)
	}
	wait := make(chan error, 1)
	go func() { wait <- run.Wait() }()
	readOutput := func() ([]byte, error) {
		stdout, stdoutErr := os.ReadFile(stdoutPath)
		stderr, stderrErr := os.ReadFile(stderrPath)
		return append(stdout, stderr...), errors.Join(stdoutErr, stderrErr)
	}
	readTeardown := func() error {
		file, err := os.Open(filepath.Join(state, "events.jsonl"))
		if err != nil {
			return fmt.Errorf("open hint teardown events: %w", err)
		}
		defer file.Close()
		found := false
		var teardownError string
		var teardownRemaining []proc.Process
		err = proc.ReadEvents(file, func(event proc.Event) error {
			if event.RunID != run.RunID || event.Type != proc.EventTeardown {
				return nil
			}
			found = true
			teardownError = event.Error
			teardownRemaining = event.Remaining
			return nil
		})
		if err != nil {
			return fmt.Errorf("read hint teardown event: %w", err)
		}
		if !found {
			return fmt.Errorf("hint run %s has no teardown event", run.RunID)
		}
		if teardownError != "" || len(teardownRemaining) != 0 {
			return fmt.Errorf("hint run teardown did not prove an empty process tree: error=%q remaining=%+v", teardownError, teardownRemaining)
		}
		return nil
	}
	select {
	case waitErr := <-wait:
		output, readErr := readOutput()
		return output, errors.Join(waitErr, readErr, readTeardown())
	case <-ctx.Done():
		killErr := run.Kill()
		waitErr := <-wait
		output, readErr := readOutput()
		kind := "HINT_COMMAND_CANCELED"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			kind = "HINT_COMMAND_TIMEOUT"
		}
		return output, fmt.Errorf("%s command=%q %s: %w", kind, command, testdeadline.FailureDetails(budget, time.Since(started)), errors.Join(ctx.Err(), waitErr, nonProcessDone(killErr), readErr, readTeardown()))
	}
}

func nonProcessDone(err error) error {
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// case: S-237.54
func TestOwnershipRuntimeHintsNameAvailableCommands(t *testing.T) {
	state := t.TempDir()
	resources := []proc.Resource{
		{Kind: proc.ResourcePath, ID: filepath.Join(state, "owned path")},
		{Kind: proc.ResourceCompose, ID: "hint-project", Files: []string{filepath.Join(state, "compose.yml")}, ComposePrefix: []string{"docker", "compose"}},
		{Kind: proc.ResourceContainer, ID: "hint-container"},
		{Kind: proc.ResourceNetwork, ID: "hint-network"},
		{Kind: proc.ResourceVolume, ID: "hint-volume"},
		{Kind: proc.ResourceKind("invalid"), ID: "hint-resource"},
	}
	for _, resource := range resources {
		t.Run(string(resource.Kind), func(t *testing.T) {
			hint := ownershipNextCommand("kb-runner", state, resource)
			fields := strings.Fields(hint)
			commandName := strings.Trim(fields[0], "`'\"")
			if commandName == "kb-runner" {
				registered := false
				for _, entry := range runnerCommands {
					if entry.name == strings.Trim(fields[1], "`'\"") {
						registered = true
						break
					}
				}
				if !registered {
					t.Fatalf("ownership next command %q is not registered", hint)
				}
				return
			}
			if _, err := exec.LookPath(commandName); err != nil {
				t.Fatalf("ownership next command %q is unavailable: %v", commandName, err)
			}
		})
	}
}

// case: S-203.6
func TestUnknownCommandHintNamesRunnerHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"missing"}, &stdout, &stderr)
	if status.Code() != 2 {
		t.Fatalf("unknown command exit = %d, want 2; stdout=%s stderr=%s", status.Code(), stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "kb-runner --help") || !strings.Contains(stderr.String(), "KB_RUNTIME_UNKNOWN_COMMAND") {
		t.Fatalf("unknown command diagnostic does not use the catalogued code and runner help: %s", stderr.String())
	}
}

// case: S-203.6
func TestUnknownCommandHintUsesInvokedRunnerName(t *testing.T) {
	runner := buildRunnerBinary(t)
	invoked := filepath.Join(t.TempDir(), "runner-from-invocation")
	if err := os.Rename(runner, invoked); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(invoked, "missing")
	command.Env = []string{"HOME=" + t.TempDir()}
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("renamed runner accepted an unknown command: %s", output)
	}
	if !strings.Contains(string(output), "runner-from-invocation --help") {
		t.Fatalf("runner hint did not use its invoked name: %s", output)
	}
}

func TestRenderDiagnosticUsesCataloguedScratchPathHint(t *testing.T) {
	entry, ok := diag.LookupCatalog("KB_RUNTIME_RUN_SCRATCH_PATH_TOO_LONG")
	if !ok {
		t.Fatal("scratch path budget diagnostic is missing from the catalog")
	}
	diagnostic := diag.New(entry.Code, entry.Message,
		diag.WithReason("resolved scratch path exceeds the socket limit"),
		diag.WithMeta(map[string]any{"root": "/private/tmp", "socketNameBytes": 40, "pathBytes": 112, "maxBytes": 104}),
	)
	got := renderDiagnostic(diagnostic)
	for _, want := range []string{"KB_RUNTIME_RUN_SCRATCH_PATH_TOO_LONG", "/private/tmp", "104 bytes", "realpath /tmp"} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered diagnostic %q does not contain %q", got, want)
		}
	}
}

func TestWaitRendererCoversEveryRunStatus(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state with spaces")
	zero := 0
	statuses := []struct {
		status   proc.RunStatus
		terminal bool
	}{
		{proc.StatusRunning, false},
		{proc.StatusQueued, false},
		{proc.StatusBlocked, false},
		{proc.StatusStalled, false},
		{proc.StatusStarting, false},
		{proc.StatusCompleted, true},
		{proc.StatusFailed, true},
		{proc.StatusDead, true},
		{proc.StatusLost, true},
		{proc.StatusDirty, true},
	}
	seen := make(map[proc.RunStatus]bool, len(statuses))
	var nonterminalOutcome string
	for _, entry := range statuses {
		status := entry.status
		if seen[status] {
			t.Fatalf("status %q was enumerated more than once", status)
		}
		seen[status] = true
		if got := status.Terminal(); got != entry.terminal {
			t.Errorf("%s.Terminal() = %t, want %t", status, got, entry.terminal)
		}
		run := proc.RunInfo{Status: status, Tag: "runner", DurationMS: 12, Error: "scratch path /tmp/run/scratch cleanup failed"}
		if status == proc.StatusCompleted || status == proc.StatusDead {
			run.ExitCode = &zero
		} else if status == proc.StatusFailed {
			failure := 7
			run.ExitCode = &failure
		}
		var output bytes.Buffer
		code, err := renderWaitOutcome(run, state, &output, "kb-runner")
		handled := true
		switch status {
		case proc.StatusRunning, proc.StatusQueued, proc.StatusBlocked, proc.StatusStalled, proc.StatusStarting:
			catalogEntry, ok := diag.LookupCatalog("KB_RUNTIME_WAIT_NOT_FINISHED")
			if !ok || code == 0 || err == nil {
				t.Errorf("nonterminal %s rendered code %d error %v catalog entry exists=%t", status, code, err, ok)
			} else {
				var diagnostic *diag.Diag
				if !errors.As(err, &diagnostic) || diagnostic.Code != catalogEntry.Code {
					t.Errorf("nonterminal %s outcome is not typed as %s: %v", status, catalogEntry.Code, err)
				}
				if nonterminalOutcome == "" {
					nonterminalOutcome = err.Error()
				} else if err.Error() != nonterminalOutcome {
					t.Errorf("nonterminal %s produced a different outcome: %q, want %q", status, err, nonterminalOutcome)
				}
				for _, want := range []string{
					catalogEntry.Code, catalogEntry.Message, catalogEntry.Hint,
					shellQuote("kb-runner") + " ps --state " + shellQuote(state),
				} {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("nonterminal %s outcome %q omitted %q", status, err, want)
					}
				}
			}
		case proc.StatusCompleted, proc.StatusDead:
			if code != 0 || err != nil || !strings.Contains(output.String(), "run runner exited after 12ms") {
				t.Errorf("dead outcome = code %d error %v output %q", code, err, output.String())
			}
		case proc.StatusFailed:
			if code != 7 || err != nil || !strings.Contains(output.String(), "run runner exited after 12ms") {
				t.Errorf("failed outcome = code %d error %v output %q", code, err, output.String())
			}
		case proc.StatusLost:
			if code == 0 || err == nil {
				t.Errorf("lost outcome = code %d error %v", code, err)
			}
		case proc.StatusDirty:
			entry, ok := diag.LookupCatalog("KB_RUNTIME_RUN_DIRTY")
			if !ok || code == 0 || err == nil {
				t.Fatalf("dirty outcome = code %d error %v, catalog entry exists=%t", code, err, ok)
			}
			for _, want := range []string{
				entry.Code, entry.Message, run.Error, entry.Hint,
				shellQuote("kb-runner") + " ps --state " + shellQuote(state),
				shellQuote("kb-runner") + " ps --leftovers --state " + shellQuote(state),
				shellQuote("kb-runner") + " gc --state " + shellQuote(state),
			} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("dirty outcome %q omitted %q", err, want)
				}
			}
		default:
			handled = false
		}
		if !handled {
			t.Errorf("test has no assertion for run status %q", status)
		}
	}
}

// case: S-237.48
func TestWaitReturnsDirtyDiagnosticAfterLostResourceCleanup(t *testing.T) {
	testWaitReturnsDirtyDiagnosticAfterLostCleanup(t, true, 0)
}

// case: S-237.48
func TestWaitReturnsDirtyDiagnosticAfterLostScratchCleanup(t *testing.T) {
	testWaitReturnsDirtyDiagnosticAfterLostCleanup(t, false, 0)
}

// case: S-237.48
func TestWaitReturnsDirtyDiagnosticAfterDelayedPIDWrite(t *testing.T) {
	testWaitReturnsDirtyDiagnosticAfterLostCleanup(t, false, 250*time.Millisecond)
}

func testWaitReturnsDirtyDiagnosticAfterLostCleanup(t *testing.T, resource bool, pidWriteDelay time.Duration) {
	t.Helper()
	state := t.TempDir()
	runner := buildRunnerBinary(t)
	tag := "lost-scratch"
	path := filepath.Join(state, "runs", "owned-path")
	childPIDFile := filepath.Join(state, "child.pid")
	pidTarget := "$1"
	prologue := ""
	if resource {
		tag = "lost-resource"
		pidTarget = "$3"
		prologue = `"$1" own path --create file "$2"; `
	}
	pidWindow := ""
	if pidWriteDelay > 0 {
		// A loaded host can be descheduled between the redirection creating the pid
		// file and the pid landing in it; hold that window open deterministically.
		pidWindow = `: > ` + pidTarget + `; sleep ` + strconv.FormatFloat(pidWriteDelay.Seconds(), 'f', -1, 64) + `; `
	}
	script := prologue + pidWindow + `printf '%s' "$$" > ` + pidTarget + `; exec /bin/sleep 30`
	commandArgs := []string{"run", "--tag", tag, "--state", state, "--stall", "1h", "--stdout", filepath.Join(state, "stdout"), "--stderr", filepath.Join(state, "stderr"), "--", "/bin/sh", "-c", script}
	if resource {
		commandArgs = append(commandArgs, "sh", runner, path, childPIDFile)
	} else {
		commandArgs = append(commandArgs, "sh", childPIDFile)
	}
	runCommand := exec.Command(runner, commandArgs...)
	var run proc.RunInfo
	var scratch string
	var childPID int
	var childIdentity string
	if err := runCommand.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if run.RunID != "" {
			if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGTERM); err != nil {
				t.Logf("stop recorded run %s during cleanup: %v", run.RunID, err)
			}
		}
		_ = runCommand.Process.Kill()
		_ = runCommand.Wait()
	})

	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		listing := proc.List(state)
		if listing.Error != nil {
			t.Fatalf("list active test run: %v", listing.Error)
		}
		for _, candidate := range listing.Runs {
			if candidate.Tag == tag && candidate.Status == proc.StatusRunning {
				run = candidate
				if resource {
					if _, err := os.Stat(path); err == nil {
						break
					}
				} else {
					scratchPath, err := scratchPathForRun(state, candidate.RunID)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := os.Stat(scratchPath); err == nil {
						scratch = scratchPath
						break
					}
				}
			}
		}
		if childPID == 0 {
			childPID = pidFromRecord(childPIDFile)
		}
		if run.PID != 0 && childPID != 0 && (resource && fileExists(path) || !resource && scratch != "") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if run.PID == 0 {
		t.Fatalf("run %q did not become visible", tag)
	}
	if childPID == 0 {
		t.Fatalf("run %q never recorded a complete pid in %s", tag, childPIDFile)
	}
	childIdentity, alive, err := proc.ProcessIdentity(childPID)
	if err != nil || !alive || childIdentity == "" {
		t.Fatalf("inspect test-owned child %d: identity=%q alive=%t error=%v", childPID, childIdentity, alive, err)
	}
	if resource {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := os.RemoveAll(scratch); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(t.TempDir(), scratch); err != nil {
			t.Fatal(err)
		}
	}
	if err := proc.SignalRecordedKeeper(state, run.RunID, syscall.SIGKILL); err != nil {
		t.Fatalf("signal recorded keeper: %v", err)
	}
	terminalDeadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(terminalDeadline) {
		listing := proc.List(state)
		for _, candidate := range listing.Runs {
			if candidate.Tag == tag && candidate.Status.Terminal() {
				run = candidate
				break
			}
		}
		if run.Status.Terminal() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !run.Status.Terminal() {
		t.Fatalf("keeper loss did not become terminal; status=%q", run.Status)
	}
	waitCtx, waitCancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	procRun, procWaitErr := proc.WaitTag(waitCtx, state, tag)
	waitCancel()
	if procWaitErr != nil || procRun.Status != proc.StatusDirty || !strings.Contains(procRun.Error, failedCleanupPath(resource, path, scratch)) {
		t.Fatalf("proc wait result = %+v, %v; want dirty cleanup outcome", procRun, procWaitErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	wait := exec.CommandContext(ctx, runner, "wait", "--tag", tag, "--state", state)
	waitOutput, waitErr := wait.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) || exitErr.ExitCode() != 1 {
		listing := proc.List(state)
		t.Fatalf("dirty wait result = %v, output=%s; listing=%+v; want prompt exit 1", waitErr, waitOutput, listing)
	}
	failedPath := path
	if !resource {
		failedPath = scratch
	}
	for _, want := range []string{
		"KB_RUNTIME_RUN_DIRTY", failedPath,
		shellQuote(runner) + " ps --state " + shellQuote(state),
		shellQuote(runner) + " ps --leftovers --state " + shellQuote(state),
	} {
		if !strings.Contains(string(waitOutput), want) {
			t.Errorf("dirty wait output %q omitted %q", waitOutput, want)
		}
	}
}

func scratchPathForRun(state, runID string) (string, error) {
	data, err := os.ReadFile(filepath.Join(state, "runs", runID+".json"))
	if err != nil {
		return "", err
	}
	var record struct {
		Scratch string `json:"scratch"`
	}
	if err := json.Unmarshal(data, &record); err != nil {
		return "", err
	}
	if record.Scratch == "" {
		return "", fmt.Errorf("run %s record omitted scratch path", runID)
	}
	return record.Scratch, nil
}

func failedCleanupPath(resource bool, path, scratch string) string {
	if resource {
		return path
	}
	return scratch
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// pidFromRecord returns the pid written to path, or 0 while the record is
// absent or incomplete: the shell redirection creates the file before the pid
// lands in it, so existence alone is not readiness.
func pidFromRecord(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

func buildRunnerBinary(t *testing.T) string {
	t.Helper()
	runner := filepath.Join(t.TempDir(), "kb-runner")
	build := exec.Command("go", "build", "-o", runner, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, output)
	}
	return runner
}

// case: S-237.27
func TestQuotaShowSetUsesStateDirectoryValues(t *testing.T) {
	state := t.TempDir()
	var output bytes.Buffer
	if code, err := execute([]string{"quota", "show", "--state", state}, &output, &output); code != 0 || err != nil {
		t.Fatalf("quota show default: code=%d err=%v output=%s", code, err, output.String())
	}
	if !strings.Contains(output.String(), "memory=") || !strings.Contains(output.String(), "(default)") {
		t.Fatalf("default quota output = %s", output.String())
	}
	output.Reset()
	if code, err := execute([]string{"quota", "set", "--state", state, "--memory", "12G", "--cpus", "4", "--min-free", "2G"}, &output, &output); code != 0 || err != nil {
		t.Fatalf("quota set: code=%d err=%v output=%s", code, err, output.String())
	}
	for _, want := range []string{"memory=12.0G (set)", "cpus=4 (set)", "min-free=2.0G (set)"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("quota output missing %q: %s", want, output.String())
		}
	}
}

// case: S-237.34
func TestElasticCPUGrantReachesChildEnvironmentAndPS(t *testing.T) {
	state := t.TempDir()
	if err := proc.SetQuota(state, "8G", "2", ""); err != nil {
		t.Fatal(err)
	}
	runner := filepath.Join(state, "kb-runner")
	build := exec.Command("go", "build", "-o", runner, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, output)
	}
	stdout := filepath.Join(state, "child.out")
	command := exec.Command(runner, "run", "--tag", "elastic", "--state", state, "--stall", "1h", "--stdout", stdout, "--stderr", filepath.Join(state, "child.err"), "--cost-key", "elastic", "--mem", "1M", "--cpus", "1..2", "--", "/bin/sh", "-c", "printf '%s %s' \"$KB_RUNNER_CPUS\" \"$KB_RUNNER_MEM_BYTES\"")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("run elastic command: %v\n%s", err, output)
	}
	data, err := os.ReadFile(stdout)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "2 1048576" {
		t.Fatalf("resource env = %q", data)
	}
	var ps bytes.Buffer
	if code, err := execute([]string{"ps", "--state", state}, &ps, &ps); code != 0 || err != nil {
		t.Fatalf("ps: code=%d err=%v output=%s", code, err, ps.String())
	}
	if !strings.Contains(ps.String(), "grant=2") || !strings.Contains(ps.String(), "mem=1.0M") {
		t.Fatalf("ps omitted resource grant: %s", ps.String())
	}
}

// case: S-237.12
func TestPSIncludesEachRunTreeAndElapsed(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("process supervision supports Linux and macOS")
	}
	state := t.TempDir()
	runner := filepath.Join(state, "kb-runner")
	build := exec.Command("go", "build", "-o", runner, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, output)
	}
	run, err := proc.Start(cancellableProcTestContext(t), proc.Config{StateDir: state, Tag: "ps-check", Stall: time.Hour,
		StdoutPath: filepath.Join(state, "out"), StderrPath: filepath.Join(state, "err"),
		Command: []string{"/bin/sleep", "30"},
	})
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	t.Cleanup(func() {
		if err := run.Kill(); err != nil {
			t.Logf("stop test-owned ps run %s: %v", run.RunID, err)
		}
		if err := run.Wait(); err != nil {
			t.Logf("wait for test-owned ps run %s: %v", run.RunID, err)
		}
		if !finished && !waitForTeardownEvent(t, state) {
			t.Log("runner teardown event was not recorded before temporary state cleanup")
		}
	})
	deadline := time.Now().Add(testdeadline.Budget(t))
	var listing []byte
	for time.Now().Before(deadline) {
		listing, _ = exec.Command(runner, "ps", "--state", state).CombinedOutput()
		// The run row prints the whole command vector, so only the child row
		// proves the tree lists the actual leaf command with its elapsed time.
		if runRowReady(listing) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	var runRow, childRow string
	for _, line := range strings.Split(string(listing), "\n") {
		if strings.HasPrefix(line, "ps-check\t") {
			runRow = line
		} else if strings.HasPrefix(line, "  └─ ") {
			childRow = line
		}
	}
	fields := strings.Split(runRow, "\t")
	if len(fields) < 7 || !strings.HasPrefix(fields[4], "elapsed=") || !strings.HasPrefix(fields[5], "tree=") {
		t.Fatalf("ps run row omitted its elapsed or tree fields: %s", listing)
	}
	treeCount, err := strconv.Atoi(strings.TrimPrefix(fields[5], "tree="))
	if err != nil || treeCount == 0 {
		t.Fatalf("ps run row omitted a nonempty tree inventory: %s", listing)
	}
	childCount := 0
	childHasSleep := false
	for _, line := range strings.Split(string(listing), "\n") {
		if strings.HasPrefix(line, "  └─ ") {
			childCount++
			childHasSleep = childHasSleep || strings.Contains(line, "sleep")
			if !strings.Contains(line, " elapsed=") {
				t.Fatalf("ps child row omitted elapsed: %s", line)
			}
		}
	}
	if childCount != treeCount || !childHasSleep || childRow == "" {
		t.Fatalf("ps child row omitted command or elapsed field: %s", listing)
	}
	if err := run.Kill(); err != nil {
		t.Logf("stop test-owned ps run during fixture cleanup: %v", err)
	}
	if err := run.Wait(); err != nil {
		t.Logf("wait for test-owned ps run during fixture cleanup: %v", err)
	}
	finished = true
}

func runRowReady(listing []byte) bool {
	runRowRunning := false
	childRowShowsSleep := false
	for _, line := range strings.Split(string(listing), "\n") {
		if strings.HasPrefix(line, "ps-check\t") {
			fields := strings.Split(line, "\t")
			runRowRunning = len(fields) >= 3 && fields[2] == "RUNNING"
		}
		if strings.HasPrefix(line, "  └─ ") && strings.Contains(line, "sleep") && strings.Contains(line, " elapsed=") {
			childRowShowsSleep = true
		}
	}
	return runRowRunning && childRowShowsSleep
}

func TestGateStatusReportsFreeFromRegistry(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	var output bytes.Buffer
	code, err := execute([]string{"gate", "status", "batch", "--state", state}, &output, &output)
	if err != nil || code != 0 || output.String() != "free\n" {
		t.Fatalf("gate status = code %d, err %v, output %q; want free", code, err, output.String())
	}
}

// case: S-237.20
func TestProcIdentityPrintsCurrentOSIdentity(t *testing.T) {
	want, alive, err := proc.ProcessIdentity(os.Getpid())
	if err != nil || !alive || want == "" {
		t.Fatalf("ProcessIdentity(current PID) = %q, alive=%t, err=%v", want, alive, err)
	}

	var stdout, stderr bytes.Buffer
	code, err := execute([]string{"proc", "identity", strconv.Itoa(os.Getpid())}, &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("proc identity command = code %d, err %v, stderr %q", code, err, stderr.String())
	}
	if got := stdout.String(); got != want+"\n" {
		t.Fatalf("proc identity output = %q, want %q", got, want+"\n")
	}
}

func TestProcIdentityReturnsDistinctCodeForGonePID(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code, err := execute([]string{"proc", "identity", "2147483647"}, &stdout, &stderr)
	if code != 3 || err == nil || !strings.Contains(err.Error(), "PID 2147483647 is not live") || stdout.Len() != 0 {
		t.Fatalf("gone PID identity = code %d, err %v, stdout %q; want code 3 and a visible not-live reason", code, err, stdout.String())
	}
}

// case: S-237.21
func TestProcInventoryReturnsExactOSArgumentElements(t *testing.T) {
	if os.Getenv("KB_RUNNER_INVENTORY_FIXTURE") == "1" {
		time.Sleep(2 * time.Minute)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	odd := []string{"unbalanced'quote", "first-line\nsecond-line", "one argument with spaces"}
	args := []string{"-test.run=^TestProcInventoryReturnsExactOSArgumentElements$", "--"}
	args = append(args, odd...)
	child := exec.Command(executable, args...)
	child.Env = append(os.Environ(), "KB_RUNNER_INVENTORY_FIXTURE=1")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	childIdentity, alive, err := proc.ProcessIdentity(child.Process.Pid)
	if err != nil || !alive || childIdentity == "" {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("identify argv fixture child: identity=%q alive=%t err=%v", childIdentity, alive, err)
	}
	t.Cleanup(func() {
		identity, childAlive, identityErr := proc.ProcessIdentity(child.Process.Pid)
		if identityErr != nil {
			t.Errorf("inspect owned argv fixture during cleanup: %v", identityErr)
		} else if childAlive && identity == childIdentity {
			if killErr := child.Process.Kill(); killErr != nil {
				t.Errorf("stop owned argv fixture: %v", killErr)
			}
		}
		if waitErr := child.Wait(); waitErr != nil {
			var exitErr *exec.ExitError
			if !errors.As(waitErr, &exitErr) {
				t.Errorf("wait owned argv fixture: %v", waitErr)
			}
		}
	})

	var stdout, stderr bytes.Buffer
	code, runErr := execute([]string{"proc", "inventory", "--json"}, &stdout, &stderr)
	if code != 0 || runErr != nil {
		t.Fatalf("proc inventory = code %d, err %v, stderr %q", code, runErr, stderr.String())
	}
	var entries []struct {
		PID              int      `json:"pid"`
		Identity         string   `json:"identity"`
		Argv             []string `json:"argv"`
		Unverified       bool     `json:"unverified"`
		SettleMS         int64    `json:"settle_ms"`
		Samples          int      `json:"samples"`
		ObservationError string   `json:"observation_error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &entries); err != nil {
		t.Fatalf("decode process inventory: %v; output=%q", err, stdout.String())
	}
	for _, entry := range entries {
		if entry.PID == child.Process.Pid {
			want := append([]string{executable}, args...)
			if entry.Unverified || entry.ObservationError != "" || entry.Identity != childIdentity ||
				!equalStrings(entry.Argv, want) || entry.SettleMS != 100 || entry.Samples != 1 {
				t.Fatalf("child inventory = %+v, want exact argv %q and identity %q", entry, want, childIdentity)
			}
			return
		}
	}
	t.Fatalf("inventory omitted live child PID %d; rows=%s", child.Process.Pid, stdout.String())
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// case: S-237.14
func TestWaitLatestTagUsesNewestRunRecord(t *testing.T) {
	dir := t.TempDir()
	runner := filepath.Join(dir, "kb-runner")
	build := exec.Command("go", "build", "-o", runner, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-runner: %v\n%s", err, output)
	}
	state := filepath.Join(dir, "state")
	run := func(tag string, exitCode string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
		defer cancel()
		cmd := exec.CommandContext(ctx, runner, "run", "--tag", tag, "--latest-tag", "stream", "--state", state,
			"--stall", "1h", "--stdout", filepath.Join(dir, tag+".out"), "--stderr", filepath.Join(dir, tag+".err"),
			"--", "/bin/sh", "-c", "exit \"$1\"", "sh", exitCode)
		output, err := cmd.CombinedOutput()
		if exitCode == "0" && err != nil {
			t.Fatalf("run %s: %v\n%s", tag, err, output)
		}
		if exitCode != "0" {
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
				t.Fatalf("run %s result = %v\n%s, want exit 7", tag, err, output)
			}
		}
	}
	run("stream-first", "0")
	run("stream-second", "7")
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	wait := exec.CommandContext(ctx, runner, "wait", "--latest-tag", "stream", "--state", state)
	output, err := wait.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
		t.Fatalf("wait latest result = %v\n%s, want exit 7", err, output)
	}
	if !strings.Contains(string(output), "run stream-second exited after ") {
		t.Fatalf("wait selected the wrong run record: %s", output)
	}
	if _, err := os.Stat(filepath.Join(state, "events.jsonl")); err != nil {
		t.Fatalf("runner event stream missing: %v", err)
	}
}

// case: S-237.11
func TestRunWaitsForItsRunIDWhenTagIsReused(t *testing.T) {
	runner := buildRunnerBinary(t)
	state := t.TempDir()
	run := func(exitCode string) (int, string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, runner, "run", "--tag", "reused", "--state", state,
			"--stall", "1h", "--stdout", filepath.Join(state, "child.out"), "--stderr", filepath.Join(state, "child.err"),
			"--", "/bin/sh", "-c", "exit \"$1\"", "sh", exitCode)
		output, err := command.CombinedOutput()
		if err == nil {
			return 0, string(output)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), string(output)
		}
		t.Fatalf("run with child status %s failed unexpectedly: %v\n%s", exitCode, err, output)
		return 0, ""
	}
	if code, output := run("0"); code != 0 {
		t.Fatalf("first run returned %d, want 0\n%s", code, output)
	}
	if code, output := run("7"); code != 7 {
		t.Fatalf("second run returned %d, want its child's status 7\n%s", code, output)
	}
}

// case: S-237.11
func TestRunCanonicalizesRelativeStateBeforeKeeperAndChildStart(t *testing.T) {
	runner := buildRunnerBinary(t)
	callerDir := t.TempDir()
	childDir := t.TempDir()
	stateArgument := filepath.Join("logs", "runner")
	canonicalState, err := filepath.Abs(filepath.Join(callerDir, stateArgument))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(runner, "run", "--tag", "relative-state", "--state", stateArgument,
		"--stall", "1h", "--stdout", filepath.Join(callerDir, "child.out"), "--stderr", filepath.Join(callerDir, "child.err"),
		"--", "/bin/sh", "-c", "cd \"$1\"; exit 0", "sh", childDir)
	command.Dir = callerDir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run with relative state and changed child cwd: %v\n%s", err, output)
	}
	records, err := filepath.Glob(filepath.Join(canonicalState, "runs", "finished", "*.json"))
	if err != nil || len(records) != 1 {
		t.Fatalf("finished records at canonical state path = %v, err=%v; want one", records, err)
	}
	data, err := os.ReadFile(records[0])
	if err != nil {
		t.Fatal(err)
	}
	var record struct {
		StateDir string `json:"state_dir"`
	}
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record.StateDir != canonicalState {
		t.Fatalf("persisted state_dir = %q, want canonical absolute path %q", record.StateDir, canonicalState)
	}
	if _, err := os.Stat(filepath.Join(childDir, stateArgument, "runs")); !os.IsNotExist(err) {
		t.Fatalf("child cwd contains a re-resolved state directory: stat err=%v", err)
	}
}

// case: S-237.137
func TestMixedVersionRunStateExchange(t *testing.T) {
	fixture := filepath.Join("testdata", "mixed-version", "base-era")
	copyFixture := func(source, destination string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(destination, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	state := t.TempDir()
	copyFixture(filepath.Join(fixture, "state.lock"), filepath.Join(state, "state.lock"))
	copyFixture(filepath.Join(fixture, "events.jsonl"), filepath.Join(state, "events.jsonl"))
	kinds := persistedEventKinds(t, filepath.Join(state, "events.jsonl"))
	if len(kinds) == 0 {
		t.Fatal("base-era writer fixture contains no event kinds")
	}
	gateState := t.TempDir()
	copyFixture(filepath.Join(fixture, "state.lock"), filepath.Join(gateState, "state.lock"))
	gatePath := filepath.Join(gateState, "gates", "bWFpbnRlbmFuY2U.json")
	copyFixture(filepath.Join(fixture, "maintenance-gate.json"), gatePath)
	if _, err := os.Stat(gatePath); err != nil {
		t.Fatalf("base-era gate fixture was not copied: %v", err)
	}
	gate, held, err := proc.GateStatus(gateState, "maintenance")
	if err != nil || held || gate.Name != "" {
		t.Fatalf("read stale base-era gate fixture = %+v, held=%t err=%v", gate, held, err)
	}
	if _, err := os.Stat(gatePath); !os.IsNotExist(err) {
		t.Fatalf("current reader did not prune stale base-era gate fixture: stat err=%v", err)
	}

	recordState := t.TempDir()
	copyFixture(filepath.Join(fixture, "state.lock"), filepath.Join(recordState, "state.lock"))
	copyFixture(filepath.Join(fixture, "run-record.json"), filepath.Join(recordState, "runs", "finished", "base-era.json"))
	listing := proc.List(recordState)
	if listing.Error != nil || len(listing.Runs) != 1 || listing.Runs[0].Tag != "base-era" {
		t.Fatalf("current reader did not read base-era run fixture: %+v", listing)
	}

	listing = proc.List(state)
	var olderFormat *proc.OlderEventFormatError
	if listing.Error == nil || !errors.As(listing.Error, &olderFormat) {
		t.Fatalf("current proc reader did not classify the base-era event fixture: %v", listing.Error)
	}
	status, err := psCommand(runnerRoot{invocation: "kb-runner"}, []string{"--state", state}, io.Discard)
	if err == nil || status == 0 {
		t.Fatalf("current reader accepted base-era event fixture: status=%d err=%v", status, err)
	}
	diagnostic := err.Error()
	for _, want := range []string{"KB_RUNTIME_INPUT_INVALID", "events.jsonl", "line", "record kind", "older kb-runner format", "next:"} {
		if !strings.Contains(diagnostic, want) {
			t.Fatalf("current reader diagnostic %q omitted %q", diagnostic, want)
		}
	}
	var namedKind bool
	for kind := range kinds {
		if strings.Contains(diagnostic, fmt.Sprintf("record kind %q", kind)) {
			namedKind = true
			break
		}
	}
	if !namedKind {
		t.Fatalf("diagnostic did not name a kind written by the base-era event producers %v: %s", kinds, diagnostic)
	}
}

func persistedEventKinds(t *testing.T, path string) map[proc.EventType]struct{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted event fixture %q: %v", path, err)
	}
	kinds := make(map[proc.EventType]struct{})
	for lineNumber, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		var record struct {
			Type proc.EventType `json:"type"`
		}
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("decode writer output event line %d: %v", lineNumber+1, err)
		}
		if record.Type == "" {
			t.Fatalf("writer output event line %d has no kind", lineNumber+1)
		}
		kinds[record.Type] = struct{}{}
	}
	return kinds
}

// case: S-237.149
func TestWaitLatestTagMissingRecordIsBounded(t *testing.T) {
	missingState := filepath.Join(t.TempDir(), "missing-state")
	started := time.Now()
	var output, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"wait", "--latest-tag", "typo", "--appear-within", "60ms", "--state", missingState}, &output, &stderr)
	if status.Code() == 0 || time.Since(started) > time.Second {
		t.Fatalf("wait for missing record = code %d after %s", status.Code(), time.Since(started))
	}
	entry, ok := diag.LookupCatalog("KB_RUNTIME_JOB_NOT_FOUND")
	if !ok || !strings.Contains(stderr.String(), entry.Code) || !strings.Contains(stderr.String(), "not-found") || !strings.Contains(stderr.String(), "next:") {
		t.Fatalf("missing latest-tag result is not a catalogued bounded not-found diagnostic: %s", stderr.String())
	}
}

func waitForTeardownEvent(t testing.TB, state string) bool {
	t.Helper()
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		file, err := os.Open(filepath.Join(state, "events.jsonl"))
		if err == nil {
			found := false
			_ = proc.ReadEvents(file, func(event proc.Event) error {
				found = found || event.Type == proc.EventTeardown
				return nil
			})
			_ = file.Close()
			if found {
				return true
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// case: S-237.44
func TestOwnUnsupportedXattrFailureGivesFilesystemAndNextCommands(t *testing.T) {
	err := ownFailure(
		"kb-runner",
		"kb-runner",
		[]string{"path", "--create", "file", "/tmp/path with space"},
		"/tmp/state",
		proc.Resource{Kind: proc.ResourcePath, ID: "/tmp/path with space"},
		&proc.PathXattrUnsupportedError{Filesystem: "apfs", Path: "/tmp/path with space"},
	).Error()
	for _, expected := range []string{
		`filesystem "apfs"`,
		`df -P '/tmp/path with space'`,
		`'kb-runner' 'own' 'path' '--create' 'file' '/tmp/path with space'`,
	} {
		if !strings.Contains(err, expected) {
			t.Fatalf("own xattr error omitted %q: %s", expected, err)
		}
	}
}

// case: S-237.50
func TestOwnOutsideRunIsActionablyRefused(t *testing.T) {
	t.Setenv("KBLABS_CLIPROC_RUN", "")
	t.Setenv("KBLABS_CLIPROC_STATE", "")
	var output bytes.Buffer
	code, err := execute([]string{"own", "path", "--create", "dir", "/tmp/unowned"}, &output, &output)
	if code == 0 || err == nil || !strings.Contains(err.Error(), "no active run marker") || !strings.Contains(err.Error(), "inside kb-runner run") {
		t.Fatalf("own outside run result = code %d, err %v, output %q", code, err, output.String())
	}
}

// case: S-237.113
func TestSelfInstallAtomicallyReplacesValidatedRunnerBinaries(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	bin := filepath.Join(root, "bin")
	tools := filepath.Join(root, "tools")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "go.mod"), []byte("module fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(tools, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"kb-runner", "kb-runner-zcode"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexec /bin/sleep 1\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	oldProcess := exec.Command(filepath.Join(bin, "kb-runner"))
	if err := oldProcess.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if oldProcess.ProcessState == nil {
			if err := oldProcess.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Errorf("stop old runner process: %v", err)
			}
			if err := oldProcess.Wait(); err != nil {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) {
					t.Errorf("wait for old runner process cleanup: %v", err)
				}
			}
		}
	})
	fakeGo := filepath.Join(tools, "go")
	script := "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then shift; out=\"$1\"; fi; shift; done\nprintf '%s\n' '#!/bin/sh' 'if [ \"$1\" = --version ]; then echo \"$KB_RUNNER_EXPECTED_VERSION\"; else exit 2; fi' > \"$out\"\nchmod 700 \"$out\"\n"
	if err := os.WriteFile(fakeGo, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KB_RUNNER_EXPECTED_VERSION", runnerVersion)
	var out, stderr bytes.Buffer
	code, err := executeRoot(runnerRoot{Root: command.InvocationRoot("kb-runner"), invocation: "kb-runner"}, []string{"self-install", "--source", source, "--root", root}, &out, &stderr)
	if code != 0 || err != nil {
		t.Fatalf("self-install code=%d err=%v stderr=%q", code, err, stderr.String())
	}
	if err := oldProcess.Wait(); err != nil {
		t.Fatalf("running process did not finish from its original executable: %v", err)
	}
	for _, name := range []string{"kb-runner", "kb-runner-zcode"} {
		installed := exec.Command(filepath.Join(bin, name), "--version")
		data, err := installed.Output()
		if err != nil || strings.TrimSpace(string(data)) != runnerVersion {
			t.Fatalf("installed %s version=%q err=%v", name, data, err)
		}
	}
}

// case: S-237.113
func TestRunnerVersionContract(t *testing.T) {
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"--version"}, &stdout, &stderr)
	if status.Code() != 0 || stdout.String() != runnerVersion+"\n" || stderr.Len() != 0 {
		t.Fatalf("version contract status=%d stdout=%q stderr=%q", status.Code(), stdout.String(), stderr.String())
	}
}

// case: S-237.113
func TestSelfInstallRejectsInvalidVersionWithoutChangingInstalledBinaries(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	bin := filepath.Join(root, "bin")
	tools := filepath.Join(root, "tools")
	for _, dir := range []string{source, bin, tools} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(source, "go.mod"), []byte("module fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"kb-runner", "kb-runner-zcode"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("old"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	fakeGo := filepath.Join(tools, "go")
	script := "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then shift; out=\"$1\"; fi; shift; done\nprintf '%s\n' '#!/bin/sh' 'echo wrong binary' > \"$out\"\nchmod 700 \"$out\"\n"
	if err := os.WriteFile(fakeGo, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	var out, stderr bytes.Buffer
	code, err := executeRoot(runnerRoot{Root: command.InvocationRoot("kb-runner"), invocation: "kb-runner"}, []string{"self-install", "--source", source, "--root", root}, &out, &stderr)
	if code == 0 || err == nil {
		t.Fatalf("invalid version accepted: code=%d err=%v", code, err)
	}
	for _, name := range []string{"kb-runner", "kb-runner-zcode"} {
		data, readErr := os.ReadFile(filepath.Join(bin, name))
		if readErr != nil || string(data) != "old" {
			t.Fatalf("invalid build changed %s: %q err=%v", name, data, readErr)
		}
	}
}
