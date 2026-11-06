//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseTestRequestAcceptsOnlyTypedGoTestShape(t *testing.T) {
	root := t.TempDir()
	module := filepath.Join(root, "tools", "clikit")
	if err := os.MkdirAll(module, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(module, "proc"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(module, "go.mod"), []byte("module example.test/clikit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	request, err := parseTestRequest(root, module, []string{"go", "-run", "^TestX$", "./proc"})
	if err != nil {
		t.Fatalf("parse valid request: %v", err)
	}
	canonicalModule, err := canonicalSandboxPath(module)
	if err != nil {
		t.Fatal(err)
	}
	if request.Module != canonicalModule || request.Run != "^TestX$" || len(request.Packages) != 1 || request.Packages[0] != "./proc" || request.Tool != "go" {
		t.Fatalf("parsed request = %+v", request)
	}
	for _, args := range [][]string{
		{"pnpm", "test"}, {"go", "build", "./..."}, {"go", "test", "-exec", "sh", "./proc"},
		{"go", "test", "-toolexec=sh", "./proc"}, {"go", "test", "-o", "out", "./proc"},
		{"go", "test", "-c", "./proc"}, {"go", "test", "-run", "^TestX$", "../../outside"},
	} {
		if _, err := parseTestRequest(root, module, args); err == nil {
			t.Errorf("parseTestRequest(%q) succeeded", args)
		}
	}
}

func TestTestChannelBrokerRefusesAfterPerJobBudget(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(filepath.Join(worktree, "proc"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/worktree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(state, "jobs", "job-budget"), 0o700); err != nil {
		t.Fatal(err)
	}
	spool := testChannelSpool(state, "job-budget")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	seedTestChannelBudget(t, state, "job-budget", testChannelDefaultBudget-1)
	var executions int
	broker := testChannelBroker{state: state, jobID: "job-budget", worktree: worktree, spool: spool,
		executor: testExecutorFunc(func(_ context.Context, _ testExecution) testResult { executions++; return testResult{ExitCode: 0} })}
	if err := broker.handle(context.Background(), testRequest{ID: "one", Workdir: worktree, Args: []string{"go", "test", "./proc"}}); err != nil {
		t.Fatalf("first request: %v", err)
	}
	err := broker.handle(context.Background(), testRequest{ID: "two", Workdir: worktree, Args: []string{"go", "test", "./proc"}})
	if err == nil || executions != 1 {
		t.Fatalf("second request err=%v executions=%d, want refusal without execution", err, executions)
	}
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || !strings.HasPrefix(refusal.Code, "KB_RUNTIME_") || refusal.Next == "" {
		t.Fatalf("budget refusal = %#v, want typed code and next command", err)
	}
	invalidJob := filepath.Join(state, "jobs", "job-invalid")
	invalidSpool := testChannelSpool(state, "job-invalid")
	if err := os.MkdirAll(invalidSpool, 0o700); err != nil {
		t.Fatal(err)
	}
	invalidBroker := testChannelBroker{state: state, jobID: "job-invalid", worktree: worktree, spool: invalidSpool,
		executor: testExecutorFunc(func(_ context.Context, _ testExecution) testResult { executions++; return testResult{ExitCode: 0} })}
	err = invalidBroker.handle(context.Background(), testRequest{ID: "three", Workdir: worktree, Args: []string{"pnpm", "test"}})
	if !errors.As(err, &refusal) || executions != 1 {
		t.Fatalf("unsupported request err=%v executions=%d, want typed refusal without execution", err, executions)
	}
	if _, err := os.Stat(filepath.Join(invalidJob, "test-channel-budget.json")); err != nil {
		t.Fatalf("refused request was not included in the budget: %v", err)
	}
}

func TestTestChannelBrokerCancelsExecutorWithJobContext(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(filepath.Join(worktree, "proc"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/worktree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	spool := testChannelSpool(state, "job-context")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	observedCancellation := make(chan struct{})
	broker := testChannelBroker{state: state, jobID: "job-context", worktree: worktree, spool: spool,
		executor: testExecutorFunc(func(ctx context.Context, _ testExecution) testResult {
			close(started)
			<-ctx.Done()
			close(observedCancellation)
			return testResult{ExitCode: 124}
		})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- broker.handle(ctx, testRequest{ID: "context", Workdir: worktree, Args: []string{"go", "test", "./proc"}})
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("outside test executor did not start")
	}
	cancel()
	select {
	case <-observedCancellation:
	case <-time.After(time.Second):
		t.Fatal("outside test executor did not receive job cancellation")
	}
	if err := <-finished; err != nil {
		t.Fatalf("write canceled test result: %v", err)
	}
}

func TestTestChannelShimRequestRoundTrip(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	jobID := "job-roundtrip"
	if err := os.MkdirAll(filepath.Join(state, "jobs", jobID), 0o700); err != nil {
		t.Fatal(err)
	}
	spool := testChannelSpool(state, jobID)
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/worktree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "proc"), 0o700); err != nil {
		t.Fatal(err)
	}
	moduleRoot, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	goCmd, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	runner := filepath.Join(root, "kb-runner")
	build := exec.Command(goCmd, "build", "-o", runner, ".")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build runner for shim round trip: %v\n%s", err, output)
	}
	shimDir, err := installCommandShims(state, jobID, runner)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	broker := testChannelBroker{state: state, jobID: jobID, worktree: root, spool: spool,
		executor: testExecutorFunc(func(_ context.Context, execution testExecution) testResult {
			return testResult{ExitCode: 0, Passed: 1, LogTail: []string{execution.Request.Run}}
		})}
	go broker.serve(ctx)
	command := exec.Command(filepath.Join(shimDir, "kb-test"), "go", "-run", "^TestX$", "./proc")
	command.Dir = root
	command.Env = []string{"HOME=" + t.TempDir(), "PATH=" + shimDir + ":/usr/bin:/bin"}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("shim round trip: %v\n%s", err, output)
	}
	var result testResult
	if err := json.Unmarshal(bytes.TrimSpace(output), &result); err != nil {
		t.Fatalf("decode shim result %q: %v", output, err)
	}
	if result.ExitCode != 0 || result.Passed != 1 || len(result.LogTail) != 1 || result.LogTail[0] != "^TestX$" {
		t.Fatalf("round-trip result = %+v", result)
	}
}

func TestTestChannelResultTailIsBounded(t *testing.T) {
	result := testResult{LogTail: []string{strings.Repeat("x", testChannelMaxLogBytes+1)}}
	result.bound()
	if result.logBytes() > testChannelMaxLogBytes {
		t.Fatalf("log tail = %d bytes, limit %d", result.logBytes(), testChannelMaxLogBytes)
	}
}

func TestTestChannelOutputCaptureRetainsBoundedHeadAndTailAndTripsCeiling(t *testing.T) {
	called := make(chan struct{}, 1)
	capture := newBoundedOutputCapture(10, func() { called <- struct{}{} })
	input := []byte("0123456789ABCDEFGHIJ")
	if n, err := capture.Write(input); err != nil || n != len(input) {
		t.Fatalf("capture write = %d, %v", n, err)
	}
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("output ceiling callback did not run")
	}
	head, tail, seen, dropped, exceeded := capture.snapshot()
	if string(head)+string(tail) != string(input) || seen != int64(len(input)) || dropped != 0 || !exceeded {
		t.Fatalf("capture head=%q tail=%q seen=%d dropped=%d exceeded=%t", head, tail, seen, dropped, exceeded)
	}
	small := newBoundedOutputCapture(1, nil)
	largeInput := []byte(strings.Repeat("0123456789abcdefghijklmnopqrstuvwxyz", testChannelMaxLogBytes))
	if _, err := small.Write(largeInput); err != nil {
		t.Fatal(err)
	}
	head, tail, seen, dropped, exceeded = small.snapshot()
	if len(head)+len(tail) > testChannelMaxLogBytes || dropped == 0 || seen != int64(len(largeInput)) || !exceeded || !bytes.Equal(tail, largeInput[len(largeInput)-len(tail):]) {
		t.Fatalf("unbounded output retained: head=%d tail=%d seen=%d dropped=%d exceeded=%t", len(head), len(tail), seen, dropped, exceeded)
	}
}

func TestTestChannelExecutorRefusesHardLinkedModuleFile(t *testing.T) {
	root := t.TempDir()
	module := filepath.Join(root, "module")
	if err := os.MkdirAll(module, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(root, "outside-secret")
	if err := os.WriteFile(secret, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(secret, filepath.Join(module, "linked-secret")); err != nil {
		t.Fatal(err)
	}
	err := refuseHardLinkedModuleFiles(module)
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("hard-linked module refusal = %v, want typed input refusal", err)
	}
}

func TestTestChannelStateSwitchRefusesBeforeExecution(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "state")
	worktree := filepath.Join(root, "worktree")
	spool := testChannelSpool(state, "job-disabled")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/worktree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "test-channel-off"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	executed := false
	broker := testChannelBroker{state: state, jobID: "job-disabled", worktree: worktree, spool: spool,
		executor: testExecutorFunc(func(context.Context, testExecution) testResult { executed = true; return testResult{ExitCode: 0} })}
	err := broker.handle(context.Background(), testRequest{ID: "disabled", Workdir: worktree, Args: []string{"go", "test", "./"}})
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || executed {
		t.Fatalf("state switch refusal err=%v executed=%t", err, executed)
	}
}

func TestTestChannelSpoolRefusesSymlinkRequestAndNeverFollowsResultTempLink(t *testing.T) {
	root := t.TempDir()
	state, worktree := filepath.Join(root, "state"), filepath.Join(root, "worktree")
	spool := testChannelSpool(state, "job-spool-links")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/spool\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "runner-user-file")
	if err := os.WriteFile(target, []byte("protected"), 0o600); err != nil {
		t.Fatal(err)
	}
	requestID := "0123456789abcdef01234567"
	if err := os.Symlink(target, filepath.Join(spool, "result-"+requestID+".json.tmp")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(spool, "request-"+requestID+".json")); err != nil {
		t.Fatal(err)
	}
	broker := testChannelBroker{state: state, jobID: "job-spool-links", worktree: worktree, spool: spool,
		executor: testExecutorFunc(func(context.Context, testExecution) testResult {
			t.Fatal("symlink request executed")
			return testResult{}
		})}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- broker.serve(ctx) }()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(spool, "result-"+requestID+".json")); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "protected" {
		t.Fatalf("symlink target changed: data=%q err=%v", data, err)
	}
	resultData, err := os.ReadFile(filepath.Join(spool, "result-"+requestID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var result testResult
	if err := json.Unmarshal(resultData, &result); err != nil {
		t.Fatal(err)
	}
	if result.DiagnosticCode != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("symlink refusal is not typed: %+v", result)
	}
	if !strings.Contains(result.Diagnostic, "symbolic link") {
		t.Fatalf("symlink refusal lost its typed cause: %+v", result)
	}
}

func TestTestChannelShimRefusesSymlinkResult(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "runner-file")
	if err := os.WriteFile(target, []byte("protected"), 0o600); err != nil {
		t.Fatal(err)
	}
	resultPath := filepath.Join(root, "result.json")
	if err := os.Symlink(target, resultPath); err != nil {
		t.Fatal(err)
	}
	_, err := readTestChannelResult(resultPath)
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) || refusal.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("symlink result error = %v, want typed refusal", err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "protected" {
		t.Fatalf("symlink result target changed: %q, %v", data, err)
	}
}

func TestTestChannelStateSwitchCancelsRunningExecutorWithTypedOutcome(t *testing.T) {
	root := t.TempDir()
	state, worktree := filepath.Join(root, "state"), filepath.Join(root, "worktree")
	spool := testChannelSpool(state, "job-switch-running")
	if err := os.MkdirAll(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(worktree, "go.mod"), []byte("module example.test/switch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	broker := testChannelBroker{state: state, jobID: "job-switch-running", worktree: worktree, spool: spool,
		executor: testExecutorFunc(func(ctx context.Context, _ testExecution) testResult {
			close(started)
			<-ctx.Done()
			return testResult{ExitCode: 124}
		})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- broker.serve(ctx) }()
	request := testRequest{ID: "0123456789abcdef01234567", Workdir: worktree, Args: []string{"go", "test", "."}}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(spool, "request-"+request.ID+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("executor did not start")
	}
	if err := os.WriteFile(filepath.Join(state, "test-channel-off"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-func() <-chan struct{} {
		ch := make(chan struct{})
		go func() {
			defer close(ch)
			for {
				if _, e := os.Stat(filepath.Join(spool, "result-"+request.ID+".json")); e == nil {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}()
		return ch
	}():
	case <-time.After(10 * time.Second):
		t.Fatal("kill switch did not finish the active request")
	}
	cancel()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	resultData, err := os.ReadFile(filepath.Join(spool, "result-"+request.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var result testResult
	if err := json.Unmarshal(resultData, &result); err != nil {
		t.Fatal(err)
	}
	if result.Outcome != testOutcomeStoppedByKillSwitch {
		t.Fatalf("result outcome = %q, want stopped-by-kill-switch", result.Outcome)
	}
}

func seedTestChannelBudget(t *testing.T, state, jobID string, count int) {
	t.Helper()
	path := filepath.Join(state, "jobs", jobID, "test-channel-budget.json")
	data, err := json.Marshal(count)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
