//go:build darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"github.com/kb-labs/kb-runner/internal/proc"
)

const testChannelSandboxExec = "/usr/bin/sandbox-exec"

type testChannelToolchain struct {
	GoBinary   string
	GOROOT     string
	GOMODCACHE string
}

// testChannelSandboxOptions exercises deliberately weakened policies in the
// Darwin boundary test. Production supplies the zero value, which denies them.
type testChannelSandboxOptions struct {
	allowProbeSecretReads   bool
	allowProbeUnixSocket    bool
	allowProbeMachLookup    bool
	probeSymlinkWriteTarget string
}

type testChannelSecretBoundary struct {
	path   string
	prefix string
}

func (boundary testChannelSecretBoundary) overlaps(candidate string) (bool, error) {
	if boundary.prefix == "" {
		return sandboxPathsOverlap(boundary.path, candidate), nil
	}
	relative, err := filepath.Rel(boundary.path, candidate)
	if err != nil {
		return false, fmt.Errorf("compare module cache with secret boundary %q: %w", boundary.path, err)
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return relative == ".", nil
	}
	component := strings.Split(relative, string(os.PathSeparator))[0]
	return strings.HasPrefix(component, boundary.prefix), nil
}

func (boundary testChannelSecretBoundary) appendDenial(profile *strings.Builder) error {
	paths := []string{boundary.path}
	alias := darwinDataVolumeAlias(boundary.path)
	if alias != boundary.path {
		paths = append(paths, alias)
	}
	if boundary.prefix == "" {
		for _, path := range paths {
			fmt.Fprintf(profile, "(deny file-read* (subpath %q) (literal %q))\n", path, path)
		}
		return nil
	}
	for _, path := range paths {
		if err := appendTestChannelRegexDeny(profile, "^"+regexp.QuoteMeta(path)+"/"+regexp.QuoteMeta(boundary.prefix)+`[^/]*(/.*)?$`); err != nil {
			return err
		}
	}
	return nil
}

func darwinDataVolumeAlias(path string) string {
	dataVolumeRoot := filepath.Join(string(os.PathSeparator), "System", "Volumes", "Data")
	if path == dataVolumeRoot || strings.HasPrefix(path, dataVolumeRoot+string(os.PathSeparator)) {
		return string(os.PathSeparator) + strings.TrimPrefix(strings.TrimPrefix(path, dataVolumeRoot), string(os.PathSeparator))
	}
	return filepath.Join(dataVolumeRoot, strings.TrimPrefix(path, string(os.PathSeparator)))
}

type testChannelOutputOpen struct {
	file *os.File
	err  error
}

func createTestChannelOutputFIFO(path string) (<-chan testChannelOutputOpen, error) {
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		return nil, err
	}
	opened := make(chan testChannelOutputOpen, 1)
	go func() { file, err := os.Open(path); opened <- testChannelOutputOpen{file: file, err: err} }()
	return opened, nil
}

func unblockTestChannelOutputFIFO(path string, opened <-chan testChannelOutputOpen) error {
	writer, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("unblock output capture reader %s: %w", path, err)
	}
	writerErr := writer.Close()
	result := <-opened
	var readerErr error
	if result.file != nil {
		readerErr = result.file.Close()
	}
	return errors.Join(writerErr, result.err, readerErr)
}

func resolveTestChannelToolchain() (testChannelToolchain, error) {
	goPath, err := exec.LookPath("go")
	if err != nil {
		return testChannelToolchain{}, fmt.Errorf("Go toolchain is unavailable: %w", err)
	}
	goPath, err = canonicalSandboxPath(goPath)
	if err != nil {
		return testChannelToolchain{}, fmt.Errorf("cannot canonicalize Go toolchain path: %w", err)
	}
	realHome := os.Getenv("HOME")
	if realHome == "" {
		return testChannelToolchain{}, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "runner HOME is unavailable for Go toolchain resolution"}
	}
	toolEnv := exec.Command(goPath, "env", "GOROOT", "GOMODCACHE")
	toolEnv.Env = []string{"HOME=" + realHome, "PATH=" + filepath.Dir(goPath), "GOENV=off", "GOTOOLCHAIN=local", "GOPROXY=off"}
	for _, name := range []string{"GOPATH", "GOMODCACHE"} {
		if value, ok := os.LookupEnv(name); ok {
			toolEnv.Env = append(toolEnv.Env, name+"="+value)
		}
	}
	paths, err := toolEnv.Output()
	if err != nil {
		return testChannelToolchain{}, fmt.Errorf("cannot resolve Go toolchain and module cache paths: %w", err)
	}
	toolPaths := strings.Split(strings.TrimSpace(string(paths)), "\n")
	if len(toolPaths) != 2 || toolPaths[0] == "" || toolPaths[1] == "" {
		return testChannelToolchain{}, errors.New("Go toolchain returned incomplete paths")
	}
	moduleCache, err := canonicalSandboxPath(toolPaths[1])
	if err != nil {
		return testChannelToolchain{}, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("canonicalize runner Go module cache %q: %v", toolPaths[1], err)}
	}
	if err := validateTestChannelModuleCache(moduleCache); err != nil {
		return testChannelToolchain{}, err
	}
	overlap, err := testChannelModuleCacheOverlapsSecrets(moduleCache, realHome)
	if err != nil {
		return testChannelToolchain{}, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("validate runner Go module cache %q: %v", moduleCache, err)}
	}
	if overlap {
		return testChannelToolchain{}, testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("runner Go module cache %q overlaps a denied secret root", moduleCache)}
	}
	return testChannelToolchain{GoBinary: goPath, GOROOT: toolPaths[0], GOMODCACHE: moduleCache}, nil
}

func validateTestChannelModuleCache(moduleCache string) error {
	info, err := os.Stat(moduleCache)
	if err != nil {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("runner Go module cache %q must be an existing directory containing cache/download: %v", moduleCache, err)}
	}
	if !info.IsDir() {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("runner Go module cache %q must be an existing directory containing cache/download", moduleCache)}
	}
	download, err := os.Stat(filepath.Join(moduleCache, "cache", "download"))
	if err != nil || !download.IsDir() {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("runner Go module cache %q must contain an existing cache/download directory", moduleCache)}
	}
	return nil
}

func executeTestRequestOS(ctx context.Context, execution testExecution) (result testResult) {
	if _, err := os.Stat(testChannelSandboxExec); err != nil {
		return testResult{ExitCode: 2, Diagnostic: "outside Go tests require macOS sandbox-exec"}
	}
	toolchain, err := resolveTestChannelToolchain()
	if err != nil {
		var refusal testChannelRefusal
		if errors.As(err, &refusal) {
			return testChannelErrorResult("", err)
		}
		return testResult{ExitCode: 127, Diagnostic: err.Error()}
	}
	tempHome, err := os.MkdirTemp("", "kb-runner-test-home-")
	if err != nil {
		return testResult{ExitCode: 1, Diagnostic: err.Error()}
	}
	defer func() {
		if err := os.RemoveAll(tempHome); err != nil {
			result = testChannelCleanupFailure(result, tempHome, err)
		}
	}()
	for _, name := range []string{"tmp", ".codex", ".claude", ".zcode", ".kb", ".ssh"} {
		if err := os.MkdirAll(filepath.Join(tempHome, name), 0o700); err != nil {
			return testResult{ExitCode: 1, Diagnostic: err.Error()}
		}
	}
	commandTempDir := filepath.Join(tempHome, "tmp")
	cache := testChannelCachePath(execution.State, execution.Stream)
	if err := os.MkdirAll(cache, 0o700); err != nil {
		return testResult{ExitCode: 1, Diagnostic: fmt.Sprintf("create stream-owned Go build cache: %v", err)}
	}
	profile, err := testChannelSandboxProfile(execution.Request.Module, tempHome, toolchain.GoBinary, toolchain.GOROOT, toolchain.GOMODCACHE, cache, os.Getenv("HOME"), testChannelSandboxOptions{})
	if err != nil {
		return testChannelErrorResult("", err)
	}
	profileDir, err := os.MkdirTemp("", "kb-runner-test-profile-")
	if err != nil {
		return testResult{ExitCode: 1, Diagnostic: err.Error()}
	}
	defer func() {
		if err := os.RemoveAll(profileDir); err != nil {
			result = testChannelCleanupFailure(result, profileDir, err)
		}
	}()
	profilePath := filepath.Join(profileDir, "policy.sb")
	if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
		return testResult{ExitCode: 1, Diagnostic: err.Error()}
	}
	goArgs := []string{"test", "-json", "-count=" + strconv.Itoa(execution.Request.Count), "-timeout=" + execution.Request.Timeout.String()}
	if execution.Request.Run != "" {
		goArgs = append(goArgs, "-run", execution.Request.Run)
	}
	if execution.Request.Race {
		goArgs = append(goArgs, "-race")
	}
	if execution.Request.Verbose {
		goArgs = append(goArgs, "-v")
	}
	goArgs = append(goArgs, execution.Request.Packages...)
	logDir, err := os.MkdirTemp("", "kb-runner-test-output-")
	if err != nil {
		return testResult{ExitCode: 1, Diagnostic: err.Error()}
	}
	defer func() {
		if err := os.RemoveAll(logDir); err != nil {
			result = testChannelCleanupFailure(result, logDir, err)
		}
	}()
	command, err := exec.LookPath(testChannelSandboxExec)
	if err != nil {
		return testResult{ExitCode: 2, Diagnostic: "macOS sandbox-exec is unavailable"}
	}
	stdoutPath, stderrPath := filepath.Join(logDir, "stdout.fifo"), filepath.Join(logDir, "stderr.fifo")
	stdoutOpened, err := createTestChannelOutputFIFO(stdoutPath)
	if err != nil {
		return testResult{ExitCode: 1, Diagnostic: "create stdout capture pipe: " + err.Error()}
	}
	stderrOpened, err := createTestChannelOutputFIFO(stderrPath)
	if err != nil {
		return testResult{ExitCode: 1, Diagnostic: errors.Join(fmt.Errorf("create stderr capture pipe: %w", err), unblockTestChannelOutputFIFO(stdoutPath, stdoutOpened)).Error()}
	}
	outputContext, cancelOutput := context.WithCancelCause(ctx)
	defer cancelOutput(context.Canceled)
	commandContext, cancel := context.WithTimeout(outputContext, execution.Request.Timeout)
	defer cancel()
	tag := "outside-test:" + execution.JobID
	if execution.RequestID != "" {
		tag += ":" + execution.RequestID
	}
	config := proc.Config{
		StateDir: execution.State, Tag: tag, CostKey: "go-test", CostClass: proc.CostHeavy,
		Stall: execution.Request.Timeout, StdoutPath: stdoutPath, StderrPath: stderrPath, Dir: execution.Request.Module,
		CleanEnv: true, CommandTempDir: commandTempDir,
		Env:     []string{"HOME=" + tempHome, "PATH=" + filepath.Dir(toolchain.GoBinary), "GOPROXY=off", "GOMODCACHE=" + toolchain.GOMODCACHE, "GOCACHE=" + cache, "GOFLAGS=-mod=readonly", "GOENV=off", "GOTOOLCHAIN=local"},
		Command: append([]string{command, "-f", profilePath, toolchain.GoBinary}, goArgs...),
	}
	run, err := proc.Start(commandContext, config)
	if err != nil {
		result := testResult{ExitCode: 1, Diagnostic: "heavy test admission failed: " + err.Error()}
		var admissionErr *proc.AdmissionCanceledError
		if errors.As(err, &admissionErr) {
			result.AdmissionReason = admissionErr.WaitReason
		}
		if cleanupErr := errors.Join(unblockTestChannelOutputFIFO(stdoutPath, stdoutOpened), unblockTestChannelOutputFIFO(stderrPath, stderrOpened)); cleanupErr != nil {
			result.Diagnostic = errors.Join(errors.New(result.Diagnostic), cleanupErr).Error()
		}
		return result
	}
	stdoutFile := <-stdoutOpened
	stderrFile := <-stderrOpened
	if stdoutFile.err != nil || stderrFile.err != nil {
		var stdoutCloseErr, stderrCloseErr error
		if stdoutFile.file != nil {
			stdoutCloseErr = stdoutFile.file.Close()
		}
		if stderrFile.file != nil {
			stderrCloseErr = stderrFile.file.Close()
		}
		killErr := run.Kill()
		waitErr := run.Wait()
		cause := errors.Join(fmt.Errorf("open bounded outside test output: %w", errors.Join(stdoutFile.err, stderrFile.err)), stdoutCloseErr, stderrCloseErr, killErr, waitErr)
		return testResult{ExitCode: 1, Diagnostic: cause.Error()}
	}
	capture := newBoundedOutputCapture(testChannelOutputLimit, func() { cancelOutput(errTestChannelOutputLimit) })
	result = testResult{}
	parseDone := make(chan error, 1)
	stderrDone := make(chan error, 1)
	stderrResult := testResult{}
	go func() {
		parseErr := consumeGoTestJSON(stdoutFile.file, capture, &result)
		parseDone <- errors.Join(parseErr, stdoutFile.file.Close())
	}()
	go func() {
		copyErr := consumeTestChannelStderr(stderrFile.file, capture, &stderrResult)
		stderrDone <- errors.Join(copyErr, stderrFile.file.Close())
	}()
	wait := make(chan error, 1)
	go func() { wait <- run.Wait() }()
	select {
	case waitErr := <-wait:
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				result.ExitCode = exitErr.ExitCode()
			} else {
				result.ExitCode = 1
				result.Diagnostic = waitErr.Error()
			}
		}
	case <-commandContext.Done():
		killErr := run.Kill()
		waitErr := <-wait
		result.ExitCode = 124
		result.Diagnostic = "outside Go test timed out"
		if errors.Is(context.Cause(outputContext), errTestChannelOutputLimit) {
			result.Outcome = testOutcomeOutputLimitExceeded
			result.Diagnostic = "output limit exceeded"
		}
		if errors.Is(context.Cause(ctx), errTestChannelKillSwitch) {
			result.Outcome = testOutcomeStoppedByKillSwitch
			result.Diagnostic = "stopped by kill switch"
		}
		if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			result.Diagnostic = errors.Join(errors.New(result.Diagnostic), fmt.Errorf("kill timed-out outside Go test: %w", killErr)).Error()
		}
		if waitErr != nil {
			result.Diagnostic = errors.Join(errors.New(result.Diagnostic), fmt.Errorf("wait for timed-out outside Go test: %w", waitErr)).Error()
		}
	}
	parseErr, stderrErr := <-parseDone, <-stderrDone
	result.Denials = boundedTail(append(result.Denials, stderrResult.Denials...), false)
	if parseErr != nil && result.Outcome == "" {
		result.Diagnostic = "parse go test JSON output: " + parseErr.Error()
		result.ExitCode = 1
	}
	if stderrErr != nil && result.Diagnostic == "" {
		result.Diagnostic = "read outside Go test error output: " + stderrErr.Error()
		result.ExitCode = 1
	}
	head, tail, seen, dropped, exceeded := capture.snapshot()
	result.OutputBytes, result.DroppedBytes = seen, dropped
	if exceeded && result.Outcome == "" {
		result.Outcome = testOutcomeOutputLimitExceeded
		result.ExitCode = 124
		result.Diagnostic = "output limit exceeded"
	}
	log := string(head)
	if len(tail) > 0 {
		log += "\n[output tail]\n" + string(tail)
	}
	result.LogTail = tailLines(strings.Split(strings.TrimSpace(log), "\n"))
	result.bound()
	return result
}

func testChannelCleanupFailure(result testResult, path string, err error) testResult {
	result.ExitCode = 1
	cleanupErr := fmt.Errorf("remove outside test temporary path %q: %w", path, err)
	if result.Diagnostic == "" {
		result.Diagnostic = cleanupErr.Error()
	} else {
		result.Diagnostic = errors.Join(errors.New(result.Diagnostic), cleanupErr).Error()
	}
	return result
}

func testChannelSandboxProfile(worktree, tempHome, goBinary, goRoot, moduleCache, goCache, userHome string, options testChannelSandboxOptions) (string, error) {
	paths := []string{worktree, tempHome, goBinary, goRoot, moduleCache, goCache, "/System", "/usr/lib"}
	canonicalPaths := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "test-channel sandbox path is empty"}
		}
		canonical, err := canonicalSandboxPath(path)
		if err != nil {
			return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("canonicalize test-channel sandbox path %q: %v", path, err)}
		}
		canonicalPaths = append(canonicalPaths, canonical)
	}
	paths = canonicalPaths
	worktreeRoot := paths[0]
	overlap, err := testChannelModuleCacheOverlapsSecrets(paths[4], userHome, tempHome)
	if err != nil {
		return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("validate module-cache secret boundaries: %v", err)}
	}
	if overlap {
		return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "module cache overlaps a denied secret root"}
	}
	literals := make([]string, 0, 4)
	for _, path := range []string{"/", "/dev/null", "/dev/zero", "/dev/dtracehelper"} {
		canonical, err := canonicalSandboxPath(path)
		if err != nil {
			return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("canonicalize test-channel device/root path %q: %v", path, err)}
		}
		literals = append(literals, canonical)
	}
	homeRoots := make([]string, 0, 2)
	for _, home := range []string{userHome, tempHome} {
		if home == "" {
			continue
		}
		canonicalHome, err := canonicalSandboxPath(home)
		if err != nil {
			return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("canonicalize HOME for test-channel denials: %v", err)}
		}
		found := false
		for _, existing := range homeRoots {
			if existing == canonicalHome {
				found = true
				break
			}
		}
		if !found {
			homeRoots = append(homeRoots, canonicalHome)
		}
	}
	var profile strings.Builder
	profile.WriteString("(version 1)\n(deny default)\n")
	profile.WriteString("(allow process-exec)\n(allow process-fork)\n(allow process-info*)\n(allow sysctl-read)\n(allow signal (target same-sandbox))\n")
	profile.WriteString("(deny network*)\n")
	if options.allowProbeUnixSocket {
		profile.WriteString("(allow network-outbound)\n")
	}
	if options.allowProbeMachLookup {
		profile.WriteString("(allow mach-lookup)\n")
	}
	fmt.Fprintf(&profile, "(allow file-read* (literal %q) (literal %q))\n(allow file-read-metadata)\n", literals[0], literals[1])
	for _, path := range paths {
		fmt.Fprintf(&profile, "(allow file-read* (subpath %q))\n", path)
	}
	if !options.allowProbeSecretReads {
		for _, path := range paths {
			if path == worktreeRoot {
				continue
			}
			if err := appendTestChannelRegexDeny(&profile, "^"+regexp.QuoteMeta(path)+`(/.*)?/\.env(\.[^/]*)?$`); err != nil {
				return "", err
			}
		}
	}
	if !options.allowProbeSecretReads {
		secretBoundaries, err := testChannelSecretBoundaries(homeRoots...)
		if err != nil {
			return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("canonicalize secret boundary: %v", err)}
		}
		for _, boundary := range secretBoundaries {
			if err := boundary.appendDenial(&profile); err != nil {
				return "", err
			}
		}
	}
	for _, path := range []string{paths[0], paths[1], paths[5]} {
		fmt.Fprintf(&profile, "(allow file-write* (subpath %q))\n", path)
	}
	if options.probeSymlinkWriteTarget != "" {
		canonical, err := canonicalSandboxPath(options.probeSymlinkWriteTarget)
		if err != nil {
			return "", testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: fmt.Sprintf("canonicalize weakened probe write target %q: %v", options.probeSymlinkWriteTarget, err)}
		}
		fmt.Fprintf(&profile, "(allow file-write* (subpath %q))\n", canonical)
	}
	fmt.Fprintf(&profile, "(allow file-write* file-ioctl (literal %q) (literal %q) (literal %q))\n", literals[1], literals[2], literals[3])
	return profile.String(), nil
}

func testChannelSecretBoundaries(homes ...string) ([]testChannelSecretBoundary, error) {
	canonicalHomes := make([]string, 0, len(homes))
	for _, home := range homes {
		if home == "" {
			continue
		}
		canonicalHome, err := canonicalSandboxPath(home)
		if err != nil {
			return nil, err
		}
		if !containsString(canonicalHomes, canonicalHome) {
			canonicalHomes = append(canonicalHomes, canonicalHome)
		}
	}
	boundaries := make([]testChannelSecretBoundary, 0, len(canonicalHomes)*7)
	for _, home := range canonicalHomes {
		for _, path := range []string{filepath.Join(home, ".codex"), filepath.Join(home, ".claude"), filepath.Join(home, ".ssh"), filepath.Join(home, ".kb", "credentials.json"), filepath.Join(home, "Library", "Keychains"), filepath.Join(home, ".env")} {
			canonical, err := canonicalSandboxPath(path)
			if err != nil {
				return nil, fmt.Errorf("canonicalize secret boundary path %q: %w", path, err)
			}
			boundaries = append(boundaries, testChannelSecretBoundary{path: canonical})
		}
		boundaries = append(boundaries, testChannelSecretBoundary{path: home, prefix: ".zcode"})
	}
	return boundaries, nil
}

func testChannelModuleCacheOverlapsSecrets(moduleCache string, homes ...string) (bool, error) {
	canonicalCache, err := canonicalSandboxPath(moduleCache)
	if err != nil {
		return false, err
	}
	boundaries, err := testChannelSecretBoundaries(homes...)
	if err != nil {
		return false, err
	}
	for _, boundary := range boundaries {
		overlap, err := boundary.overlaps(canonicalCache)
		if err != nil {
			return false, err
		}
		if overlap {
			return true, nil
		}
	}
	return false, nil
}

func sandboxPathsOverlap(left, right string) bool {
	for _, pair := range [][2]string{{left, right}, {right, left}} {
		relative, err := filepath.Rel(pair[0], pair[1])
		if err == nil && (relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))) {
			return true
		}
	}
	return false
}

func containsString(values []string, value string) bool {
	for _, existing := range values {
		if existing == value {
			return true
		}
	}
	return false
}

func appendTestChannelRegexDeny(profile *strings.Builder, pattern string) error {
	if strings.ContainsAny(pattern, "\"\r\n") {
		return testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Cause: "test-channel sandbox regex path contains an unrepresentable character"}
	}
	fmt.Fprintf(profile, "(deny file-read* (regex #\"%s\"))\n", pattern)
	return nil
}
