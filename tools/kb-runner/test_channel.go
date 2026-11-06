//go:build darwin || linux

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/diag"
)

const (
	testChannelDefaultBudget  = 20
	testChannelDefaultTimeout = 10 * time.Minute
	testChannelMaximumTimeout = 20 * time.Minute
	testChannelMaxLogBytes    = 64 * 1024
	testChannelOutputLimit    = 8 * 1024 * 1024
	testChannelOutputHead     = 8 * 1024
)

type testOutcome string

const (
	testOutcomeStoppedByKillSwitch testOutcome = "stopped-by-kill-switch"
	testOutcomeOutputLimitExceeded testOutcome = "output-limit-exceeded"
)

var errTestChannelKillSwitch = errors.New("outside test channel stopped by kill switch")
var errTestChannelOutputLimit = errors.New("outside test output limit exceeded")

type boundedOutputCapture struct {
	mu            sync.Mutex
	limit         int64
	headLimit     int
	tailLimit     int
	head          []byte
	tail          []byte
	tailNext      int
	tailUsed      int
	seen          int64
	dropped       int64
	limitExceeded bool
	onLimit       func()
}

func newBoundedOutputCapture(limit int64, onLimit func()) *boundedOutputCapture {
	tailLimit := testChannelMaxLogBytes - testChannelOutputHead
	return &boundedOutputCapture{limit: limit, headLimit: testChannelOutputHead, tailLimit: tailLimit, tail: make([]byte, tailLimit), onLimit: onLimit}
}

func (capture *boundedOutputCapture) Write(data []byte) (int, error) {
	written := len(data)
	capture.mu.Lock()
	defer capture.mu.Unlock()
	capture.seen += int64(len(data))
	if len(capture.head) < capture.headLimit {
		amount := capture.headLimit - len(capture.head)
		if amount > len(data) {
			amount = len(data)
		}
		capture.head = append(capture.head, data[:amount]...)
		data = data[amount:]
	}
	for len(data) > 0 {
		amount := len(data)
		if amount > capture.tailLimit-capture.tailNext {
			amount = capture.tailLimit - capture.tailNext
		}
		copy(capture.tail[capture.tailNext:capture.tailNext+amount], data[:amount])
		capture.tailNext = (capture.tailNext + amount) % capture.tailLimit
		if capture.tailUsed+amount > capture.tailLimit {
			capture.tailUsed = capture.tailLimit
		} else {
			capture.tailUsed += amount
		}
		data = data[amount:]
	}
	retained := int64(len(capture.head) + capture.tailUsed)
	if capture.seen > retained {
		capture.dropped = capture.seen - retained
	}
	if capture.seen > capture.limit && !capture.limitExceeded {
		capture.limitExceeded = true
		if capture.onLimit != nil {
			capture.onLimit()
		}
	}
	return written, nil
}

func (capture *boundedOutputCapture) snapshot() (head, tail []byte, seen, dropped int64, exceeded bool) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	tail = make([]byte, capture.tailUsed)
	start := (capture.tailNext - capture.tailUsed + capture.tailLimit) % capture.tailLimit
	first := capture.tailUsed
	if first > capture.tailLimit-start {
		first = capture.tailLimit - start
	}
	copy(tail, capture.tail[start:start+first])
	copy(tail[first:], capture.tail[:capture.tailUsed-first])
	return append([]byte(nil), capture.head...), tail, capture.seen, capture.dropped, capture.limitExceeded
}

func testChannelSpool(state, jobID string) string {
	return filepath.Join(state, "jobs", jobID, "test-channel", "spool")
}

func testChannelCachePath(state, stream string) string {
	key := sha256.Sum256([]byte(stream))
	return filepath.Join(state, "test-channel", "streams", hex.EncodeToString(key[:]), "gocache")
}

type TestRequest struct {
	Tool     string        `json:"tool"`
	Module   string        `json:"module"`
	Packages []string      `json:"packages"`
	Run      string        `json:"run,omitempty"`
	Count    int           `json:"count"`
	Timeout  time.Duration `json:"timeout"`
	Race     bool          `json:"race,omitempty"`
	Verbose  bool          `json:"verbose,omitempty"`
}

type testRequest struct {
	ID      string   `json:"id"`
	Workdir string   `json:"workdir"`
	Args    []string `json:"args"`
}

type testResult struct {
	ID              string      `json:"id,omitempty"`
	ExitCode        int         `json:"exitCode"`
	Passed          int         `json:"passed"`
	Failed          int         `json:"failed"`
	Skipped         int         `json:"skipped"`
	Failing         []string    `json:"failingTests,omitempty"`
	LogTail         []string    `json:"logTail,omitempty"`
	Denials         []string    `json:"denials,omitempty"`
	AdmissionReason string      `json:"admissionReason,omitempty"`
	DiagnosticCode  string      `json:"diagnosticCode,omitempty"`
	Diagnostic      string      `json:"diagnostic,omitempty"`
	Outcome         testOutcome `json:"outcome,omitempty"`
	OutputBytes     int64       `json:"outputBytes,omitempty"`
	DroppedBytes    int64       `json:"droppedBytes,omitempty"`
}

func (result *testResult) logBytes() int {
	return len([]byte(strings.Join(result.LogTail, "\n")))
}

func (result *testResult) bound() {
	result.LogTail = boundedTail(result.LogTail, true)
	result.Denials = boundedTail(result.Denials, false)
}

func boundedTail(source []string, markTruncation bool) []string {
	const marker = "[earlier lines truncated]"
	limit := testChannelMaxLogBytes
	truncated := false
	if markTruncation && len([]byte(strings.Join(source, "\n"))) > limit {
		limit -= len(marker) + 1
		truncated = true
	}
	lines := make([]string, 0, len(source))
	used := 0
	for index := len(source) - 1; index >= 0; index-- {
		line := source[index]
		remaining := limit - used
		if remaining <= 0 {
			truncated = true
			break
		}
		bytes := []byte(line)
		if len(bytes) > remaining {
			line = string(bytes[len(bytes)-remaining:])
			truncated = true
		}
		lines = append(lines, line)
		used += len([]byte(line)) + 1
	}
	for left, right := 0, len(lines)-1; left < right; left, right = left+1, right-1 {
		lines[left], lines[right] = lines[right], lines[left]
	}
	if truncated && markTruncation {
		lines = append([]string{marker}, lines...)
	}
	return lines
}

type testExecution struct {
	Request   TestRequest
	JobID     string
	RequestID string
	Stream    string
	State     string
}

type testExecutor interface {
	Execute(context.Context, testExecution) testResult
}

type testExecutorFunc func(context.Context, testExecution) testResult

func (execute testExecutorFunc) Execute(ctx context.Context, execution testExecution) testResult {
	return execute(ctx, execution)
}

func newTestChannelExecutor() testExecutor {
	return testExecutorFunc(executeTestRequest)
}

type testChannelRefusal struct {
	Code  string
	Next  string
	Cause string
}

func (refusal testChannelRefusal) Error() string { return refusal.Cause }

func testChannelDiagnostic(root runnerRoot, refusal testChannelRefusal) error {
	entry, ok := diag.LookupCatalog(refusal.Code)
	if !ok {
		return fmt.Errorf("test-channel diagnostic %s is missing from the shared catalog", refusal.Code)
	}
	return diag.New(entry.Code, entry.Message, diag.WithReason(refusal.Cause), diag.WithBinary(root.InvocationCommand()), diag.WithHint("next: "+refusal.Next))
}

func testChannelInvocation() (string, error) {
	invocation, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve runner invocation for outside test channel: %w", err)
	}
	if invocation == "" {
		return "", errors.New("runner executable path is empty")
	}
	return invocation, nil
}

func testChannelNextCommand() (string, error) {
	invocation, err := testChannelInvocation()
	if err != nil {
		return "", err
	}
	return shellQuote(invocation) + " agent start --help", nil
}

func testChannelErrorResult(id string, err error) testResult {
	result := testResult{ID: id, ExitCode: 2}
	var refusal testChannelRefusal
	if !errors.As(err, &refusal) {
		result.Diagnostic = err.Error()
		return result
	}
	result.DiagnosticCode = refusal.Code
	invocation, executableErr := testChannelInvocation()
	if executableErr != nil {
		result.Diagnostic = executableErr.Error()
		return result
	}
	root := runnerRoot{invocation: invocation}
	if refusal.Next == "" {
		refusal.Next = root.InvocationCommand() + " agent start --help"
	}
	diagnostic := testChannelDiagnostic(root, refusal)
	var typed *diag.Diag
	if errors.As(diagnostic, &typed) {
		result.Diagnostic = renderDiagnostic(typed)
	} else {
		result.Diagnostic = diagnostic.Error()
	}
	return result
}

func parseTestRequest(worktree, requestDir string, args []string) (TestRequest, error) {
	refuse := func(reason string) (TestRequest, error) {
		return TestRequest{}, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: reason}
	}
	if len(args) < 1 || args[0] != "go" {
		return refuse("kb-test accepts only the go test tool")
	}
	root, err := canonicalSandboxPath(worktree)
	if err != nil {
		return refuse("job worktree is not an existing canonical directory")
	}
	args = args[1:]
	if len(args) > 0 && args[0] == "test" {
		args = args[1:]
	}
	request := TestRequest{Tool: "go", Count: 1, Timeout: testChannelDefaultTimeout}
	var packages []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		value := func(flag string) (string, error) {
			if index+1 >= len(args) {
				return "", fmt.Errorf("%s requires a value", flag)
			}
			index++
			return args[index], nil
		}
		switch {
		case arg == "-run":
			request.Run, err = value(arg)
		case strings.HasPrefix(arg, "-run="):
			request.Run = strings.TrimPrefix(arg, "-run=")
		case arg == "-count":
			var raw string
			raw, err = value(arg)
			if err == nil {
				request.Count, err = strconv.Atoi(raw)
			}
		case strings.HasPrefix(arg, "-count="):
			request.Count, err = strconv.Atoi(strings.TrimPrefix(arg, "-count="))
		case arg == "-timeout":
			var raw string
			raw, err = value(arg)
			if err == nil {
				request.Timeout, err = time.ParseDuration(raw)
			}
		case strings.HasPrefix(arg, "-timeout="):
			request.Timeout, err = time.ParseDuration(strings.TrimPrefix(arg, "-timeout="))
		case arg == "-race":
			request.Race = true
		case arg == "-v":
			request.Verbose = true
		case strings.HasPrefix(arg, "-"):
			return refuse("unsupported go test option " + arg)
		default:
			packages = append(packages, arg)
		}
		if err != nil {
			return refuse("invalid go test option " + arg)
		}
	}
	if request.Count < 1 || request.Timeout <= 0 || request.Timeout > testChannelMaximumTimeout {
		return refuse("count must be positive and timeout must not exceed 20m")
	}
	if len(packages) == 0 {
		packages = []string{"."}
	}
	cwd, err := canonicalSandboxPath(requestDir)
	if err != nil || !pathWithin(root, cwd) {
		return refuse("requesting directory is outside the job worktree")
	}
	module := ""
	for candidate := cwd; pathWithin(root, candidate); candidate = filepath.Dir(candidate) {
		info, statErr := os.Stat(filepath.Join(candidate, "go.mod"))
		if statErr == nil {
			if !info.Mode().IsRegular() {
				return refuse("Go module manifest is not a regular file")
			}
			module = candidate
			break
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return refuse("cannot inspect Go module manifest")
		}
		if candidate == root {
			break
		}
	}
	if module == "" {
		return refuse("requesting directory is not inside a Go module in the job worktree")
	}
	resolvedPackages := make([]string, 0, len(packages))
	for _, item := range packages {
		if filepath.IsAbs(item) || item == "" || strings.Contains(item, "\\") || strings.HasPrefix(item, "../") || item == ".." {
			return refuse("package paths must remain inside the selected Go module")
		}
		if item != "." && item != "..." && !strings.HasPrefix(item, "./") {
			return refuse("packages must be relative paths inside the selected Go module")
		}
		clean := filepath.Clean(item)
		resolved := filepath.Clean(filepath.Join(cwd, clean))
		if !pathWithin(module, resolved) {
			return refuse("package path resolves outside the selected Go module")
		}
		probe := strings.TrimSuffix(resolved, string(filepath.Separator)+"...")
		canonical, resolveErr := canonicalSandboxPath(probe)
		if resolveErr != nil {
			return refuse("package path cannot be resolved inside the selected Go module")
		}
		if !pathWithin(module, canonical) {
			return refuse("package path resolves through a symlink outside the selected Go module")
		}
		resolvedPackages = append(resolvedPackages, item)
	}
	request.Module, err = canonicalSandboxPath(module)
	if err != nil {
		return refuse("Go module path cannot be canonicalized")
	}
	request.Packages = resolvedPackages
	return request, nil
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

type testChannelBroker struct {
	state, jobID, stream, worktree, spool string
	executor                              testExecutor
	mu                                    sync.Mutex
	active                                bool
}

func (broker *testChannelBroker) handle(ctx context.Context, request testRequest) error {
	broker.mu.Lock()
	if broker.active {
		broker.mu.Unlock()
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "one outside test request per job may run at a time"}
	}
	broker.active = true
	broker.mu.Unlock()
	defer func() { broker.mu.Lock(); broker.active = false; broker.mu.Unlock() }()
	if _, err := os.Stat(filepath.Join(broker.state, "test-channel-off")); err == nil {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test channel is disabled by runner state"}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read outside test channel state switch: %w", err)
	}
	worktree, err := canonicalSandboxPath(broker.worktree)
	if err != nil {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "job worktree is unavailable"}
	}
	countPath := filepath.Join(broker.state, "jobs", broker.jobID, "test-channel-budget.json")
	count := 0
	if data, readErr := os.ReadFile(countPath); readErr == nil {
		if err := json.Unmarshal(data, &count); err != nil {
			return fmt.Errorf("read outside test request budget: %w", err)
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return fmt.Errorf("read outside test request budget: %w", readErr)
	}
	if count >= testChannelDefaultBudget {
		next, err := testChannelNextCommand()
		if err != nil {
			return err
		}
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Next: next, Cause: "outside test request budget exhausted"}
	}
	if err := writeJSONAtomic(countPath, count+1); err != nil {
		return fmt.Errorf("persist outside test request budget: %w", err)
	}
	parsed, err := parseTestRequest(worktree, request.Workdir, request.Args)
	if err != nil {
		return err
	}
	if broker.executor == nil {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside Go test execution policy is unavailable"}
	}
	result := broker.executor.Execute(ctx, testExecution{Request: parsed, JobID: broker.jobID, RequestID: request.ID, Stream: broker.stream, State: broker.state})
	if errors.Is(context.Cause(ctx), errTestChannelKillSwitch) {
		result.ExitCode = 124
		result.Outcome = testOutcomeStoppedByKillSwitch
		result.Diagnostic = "stopped by kill switch"
	}
	result.ID = request.ID
	result.bound()
	return writeJSONAtomic(filepath.Join(broker.spool, "result-"+request.ID+".json"), result)
}

func (broker *testChannelBroker) serve(ctx context.Context) error {
	jobContext, cancel := context.WithCancelCause(ctx)
	defer cancel(context.Canceled)
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Lstat(filepath.Join(broker.state, "test-channel-off")); err == nil {
				cancel(errTestChannelKillSwitch)
				return
			} else if !errors.Is(err, os.ErrNotExist) {
				cancel(fmt.Errorf("read outside test channel state switch: %w", err))
				return
			}
			select {
			case <-jobContext.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	defer func() { cancel(context.Canceled); <-watcherDone }()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		entries, err := os.ReadDir(broker.spool)
		if err != nil {
			return fmt.Errorf("read outside test request spool: %w", err)
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "request-") || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			path := filepath.Join(broker.spool, entry.Name())
			id := strings.TrimSuffix(strings.TrimPrefix(entry.Name(), "request-"), ".json")
			if _, decodeErr := hex.DecodeString(id); decodeErr != nil || len(id) != 24 {
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					return fmt.Errorf("remove malformed outside test request: %w", err)
				}
				continue
			}
			data, readErr := readTestChannelRequest(path)
			if readErr != nil {
				result := testChannelErrorResult(id, readErr)
				if writeErr := writeJSONAtomic(filepath.Join(broker.spool, "result-"+id+".json"), result); writeErr != nil {
					return fmt.Errorf("write outside test refusal result: %w", writeErr)
				}
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					return fmt.Errorf("remove refused outside test request: %w", err)
				}
				continue
			}
			var request testRequest
			if err = json.Unmarshal(data, &request); err != nil {
				request.ID = id
				err = testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test request is not valid structured data"}
			} else if request.ID != id {
				request.ID = id
				err = testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "invalid outside test request identity"}
			} else {
				err = broker.handle(jobContext, request)
			}
			if err != nil {
				result := testChannelErrorResult(id, err)
				if writeErr := writeJSONAtomic(filepath.Join(broker.spool, "result-"+id+".json"), result); writeErr != nil {
					return fmt.Errorf("write outside test refusal result: %w", writeErr)
				}
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove processed outside test request: %w", err)
			}
		}
		select {
		case <-jobContext.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func writeJSONAtomic(path string, value any) (writeErr error) {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() {
		if err := os.Remove(tmpPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeErr = errors.Join(writeErr, fmt.Errorf("remove temporary outside test spool file: %w", err))
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return errors.Join(err, tmp.Close())
	}
	if _, err := tmp.Write(data); err != nil {
		return errors.Join(err, tmp.Close())
	}
	if err := tmp.Sync(); err != nil {
		return errors.Join(err, tmp.Close())
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func readTestChannelRequest(path string) (data []byte, readErr error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.EMLINK) {
			return nil, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test request must be a regular file, not a symbolic link"}
		}
		if errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return nil, fmt.Errorf("open outside test request without following links: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	defer func() { readErr = errors.Join(readErr, file.Close()) }()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect outside test request: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test request must be a regular file"}
	}
	data, err = io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil {
		return nil, fmt.Errorf("read outside test request: %w", err)
	}
	if len(data) > 16*1024 {
		return nil, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test request exceeds the 16 KiB request limit"}
	}
	return data, nil
}

func readTestChannelResult(path string) (data []byte, readErr error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.EMLINK) {
			return nil, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test result must be a regular file, not a symbolic link"}
		}
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer func() { readErr = errors.Join(readErr, file.Close()) }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test result must be a regular file"}
	}
	data, err = io.ReadAll(io.LimitReader(file, 256*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 256*1024 {
		return nil, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test result exceeds the 256 KiB result limit"}
	}
	return data, nil
}

func runTestChannelRequest(ctx context.Context, spool string, args []string) (testResult, error) {
	requestDir, err := os.Getwd()
	if err != nil {
		return testResult{}, err
	}
	return runTestChannelRequestAt(ctx, spool, requestDir, args)
}

func runTestChannelRequestAt(ctx context.Context, spool, requestDir string, args []string) (testResult, error) {
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return testResult{}, err
	}
	id := hex.EncodeToString(nonce[:])
	request := testRequest{ID: id, Workdir: requestDir, Args: append([]string(nil), args...)}
	if err := writeJSONAtomic(filepath.Join(spool, "request-"+id+".json"), request); err != nil {
		return testResult{}, err
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return testResult{}, ctx.Err()
		case <-ticker.C:
			resultPath := filepath.Join(spool, "result-"+id+".json")
			data, err := readTestChannelResult(resultPath)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return testResult{}, err
			}
			if err := os.Remove(resultPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return testResult{}, err
			}
			var result testResult
			if err := json.Unmarshal(data, &result); err != nil {
				return testResult{}, err
			}
			if result.Diagnostic != "" {
				return result, errors.New(result.Diagnostic)
			}
			return result, nil
		}
	}
}

func executeTestRequest(ctx context.Context, execution testExecution) testResult {
	if err := refuseHardLinkedModuleFiles(execution.Request.Module); err != nil {
		return testChannelErrorResult("", err)
	}
	return executeTestRequestOS(ctx, execution)
}

func refuseHardLinkedModuleFiles(module string) error {
	return filepath.WalkDir(module, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("inspect outside test module tree: %w", walkErr)
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("inspect outside test module file: %w", err)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		identity, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("outside test module file identity is unavailable")
		}
		if identity.Nlink > 1 {
			return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "outside test module contains a hard-linked regular file"}
		}
		return nil
	})
}

func parseGoTestJSON(output []byte, result *testResult) error {
	type event struct {
		Action string `json:"Action"`
		Test   string `json:"Test"`
		Output string `json:"Output"`
	}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		var item event
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			return fmt.Errorf("line %d: %w", lineNumber, err)
		}
		addDenialLine(result, item.Output)
		if item.Test == "" {
			continue
		}
		switch item.Action {
		case "pass":
			result.Passed++
		case "fail":
			result.Failed++
			result.Failing = append(result.Failing, item.Test)
		case "skip":
			result.Skipped++
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	sort.Strings(result.Failing)
	return nil
}

func consumeGoTestJSON(reader io.Reader, capture io.Writer, result *testResult) error {
	type event struct {
		Action string `json:"Action"`
		Test   string `json:"Test"`
		Output string `json:"Output"`
	}
	decoder := json.NewDecoder(io.TeeReader(reader, capture))
	for {
		var item event
		err := decoder.Decode(&item)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			_, drainErr := io.Copy(capture, reader)
			return errors.Join(fmt.Errorf("decode go test JSON stream: %w", err), drainErr)
		}
		addDenialLine(result, item.Output)
		if item.Test == "" {
			continue
		}
		switch item.Action {
		case "pass":
			result.Passed++
		case "fail":
			result.Failed++
			result.Failing = append(result.Failing, item.Test)
		case "skip":
			result.Skipped++
		}
	}
}

func addDenialLine(result *testResult, output string) {
	for _, line := range strings.Split(output, "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "denied") || strings.Contains(lower, "operation not permitted") || strings.Contains(lower, "permission denied") {
			result.Denials = boundedTail(append(result.Denials, line), false)
		}
	}
}

func consumeTestChannelStderr(reader io.Reader, capture io.Writer, result *testResult) error {
	buffer := make([]byte, 32*1024)
	line := make([]byte, 0, 4096)
	for {
		count, readErr := reader.Read(buffer)
		if count > 0 {
			chunk := buffer[:count]
			if _, err := capture.Write(chunk); err != nil {
				return err
			}
			for _, value := range chunk {
				if value == '\n' {
					addDenialLine(result, string(line))
					line = line[:0]
					continue
				}
				if len(line) < testChannelMaxLogBytes {
					line = append(line, value)
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			addDenialLine(result, string(line))
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func tailLines(lines []string) []string {
	if len(lines) > 400 {
		lines = lines[len(lines)-400:]
	}
	return lines
}

func testChannelRequestCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	if len(args) < 2 || args[0] != "request" {
		return 2, fmt.Errorf("%s test-channel: request is required; next: %s agent start --help", root.Name(), root.InvocationCommand())
	}
	fs := flag.NewFlagSet("test-channel request", flag.ContinueOnError)
	fs.SetOutput(errOut)
	spool := fs.String("spool", "", "job test-channel spool directory")
	if err := fs.Parse(args[1:]); err != nil {
		return 2, err
	}
	command := fs.Args()
	if len(command) > 0 && command[0] == "--" {
		command = command[1:]
	}
	if *spool == "" {
		return 2, fmt.Errorf("%s test-channel request: spool is required; next: %s agent start --help", root.Name(), root.InvocationCommand())
	}
	ctx, cancel := context.WithTimeout(context.Background(), testChannelMaximumTimeout+time.Minute)
	defer cancel()
	result, err := runTestChannelRequest(ctx, *spool, command)
	if err != nil {
		return result.ExitCode, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return 1, fmt.Errorf("encode outside test result: %w", err)
	}
	_, writeErr := fmt.Fprintln(out, string(data))
	return result.ExitCode, writeErr
}
