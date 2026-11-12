package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/workspace"
)

// Executor runs a single (package, task) pair with cache lookup/store.
type Executor struct {
	objects            cache.ObjectStore
	manifests          *cache.ManifestStore
	states             *cache.StateStore
	wsRoot             string
	logRoot            string
	liveOutput         bool // stream stdout/stderr while running
	onHeartbeat        func(packageName, taskName string, elapsed time.Duration)
	gate               *admission // memory admission around the real process launch; nil admits everything
	runtimeFingerprint string
	globalInputDigest  string
	ownedInputDigests  map[string]string
	dependencyDigests  map[string]string
}

const taskHeartbeatInterval = 30 * time.Second

// NewExecutor creates an Executor backed by the given cache stores.
func NewExecutor(objects cache.ObjectStore, manifests *cache.ManifestStore, states *cache.StateStore, wsRoot, cacheRoot string, liveOutput bool) *Executor {
	return &Executor{
		objects:            objects,
		manifests:          manifests,
		states:             states,
		wsRoot:             wsRoot,
		logRoot:            filepath.Join(cacheRoot, "logs"),
		liveOutput:         liveOutput,
		runtimeFingerprint: cache.RuntimeFingerprint(),
	}
}

// Run executes (pkg, task) with full cache semantics:
//  1. Compute input hash (owned tracked files, global inputs, dependencies and "^" outputs)
//  2. Cache hit? → restore outputs + return cached result
//  3. Run command
//  4. Store outputs + write manifest
//  5. Return result
//
// depDirs is the list of workspace dependency directories for this package.
// It is used to resolve "^"-prefixed input patterns (e.g. "^dist/**").
func (e *Executor) Run(pkg workspace.Package, def TaskDef, noCache bool, depDirs []string) TaskResult {
	start := time.Now()

	// 1. Compute input hash.
	inputHash, err := hashTaskInputs(pkg, def, depDirs, e.runtimeFingerprint, e.globalInputDigest, e.ownedInputDigests[pkg.Name], e.dependencyDigests[pkg.Name])
	if err != nil {
		failure := fmt.Sprintf("hash inputs: %v", err)
		logPath, logErr := e.writeTaskLog(pkg.Name, def.Name, "", "", failure)
		result := TaskResult{
			Package: pkg.Name, Task: def.Name,
			OK:      false,
			Error:   failure,
			LogPath: logPath,
		}
		if logErr != nil {
			result.LogError = logErr.Error()
			result.LogDirectory = e.logRoot
			result.Error = fmt.Sprintf("%s; write task log: %v", failure, logErr)
		}
		_ = e.states.SetDirty(pkg.Name, def.Name, "last_run_failed")
		return result
	}

	// 2. Cache lookup (skip if cache:false or --no-cache).
	if def.Cache && !noCache {
		// Only successful runs are replayed. A failure can come from state the
		// input hash does not see (a dependency rebuilt mid-run, a flaky
		// process), and replaying it reports a stale red result.
		// A manifest with no outputs for a task that declares outputs restores
		// nothing, so it is not a hit.
		if m, ok := e.manifests.Get(pkg.Name, def.Name, inputHash); ok && m.ExitCode == 0 && (len(def.Outputs) == 0 || len(m.Outputs) > 0) {
			// Restore output files, leaving exactly the manifest's files.
			if err := e.restoreOutputs(m, pkg.Dir, def.Outputs); err == nil {
				return TaskResult{
					Package: pkg.Name,
					Task:    def.Name,
					OK:      true,
					Cached:  true,
					Stdout:  m.Stdout,
					Elapsed: time.Since(start),
				}
			}
			// If restore fails, fall through to re-run.
		}
	}

	// 3. Run command. Memory is reserved only here, after the cache lookup:
	// a cache hit never holds a reservation.
	var slot int
	if e.gate != nil {
		slot = e.gate.acquire()
	}
	stdout, stderr, exitCode, runErr := e.runCommand(def.Command, pkg.Dir, pkg.Name, def.Name, taskEnvironment(def).run, taskHeartbeatInterval)
	if e.gate != nil {
		e.gate.release(slot)
	}
	elapsed := time.Since(start)

	result := TaskResult{
		Package:  pkg.Name,
		Task:     def.Name,
		OK:       exitCode == 0 && runErr == nil,
		Cached:   false,
		ExitCode: exitCode,
		Stdout:   stdout,
		Stderr:   stderr,
		Elapsed:  elapsed,
	}
	if runErr != nil {
		result.Error = runErr.Error()
		var diagnostic *diag.Diag
		if errors.As(runErr, &diagnostic) {
			result.Diagnostic = diagnostic
		}
	} else if !result.OK {
		result.Error = fmt.Sprintf("command exited with code %d", exitCode)
	}
	if !result.OK {
		logPath, logErr := e.writeTaskLog(pkg.Name, def.Name, stdout, stderr, result.Error)
		if logErr != nil {
			result.LogError = logErr.Error()
			result.LogDirectory = e.logRoot
			result.LogPath = logPath
			result.Error = fmt.Sprintf("%s; write task log: %v", result.Error, logErr)
		} else {
			result.LogPath = logPath
		}
	}

	// 4. Cache successful results only. Failed tasks depend on execution state
	//     outside the input hash and must be retried on the next run. A task
	//     whose outputs cannot be stored fails: a manifest without them would
	//     be replayed later as a hit that restores nothing.
	if def.Cache && result.OK {
		m := &cache.Manifest{
			InputHash: inputHash,
			ExitCode:  exitCode,
			Elapsed:   elapsed.String(),
		}
		if len(stdout) <= 64*1024 { // cap stdout at 64KB in manifest
			m.Stdout = stdout
		}
		if len(stderr) <= 8*1024 {
			m.Stderr = stderr
		}

		var cacheErr error
		if len(def.Outputs) > 0 {
			m.Outputs, cacheErr = e.storeOutputs(pkg.Dir, def.Outputs)
		}
		if cacheErr == nil {
			if err := e.manifests.Put(pkg.Name, def.Name, m); err != nil {
				cacheErr = fmt.Errorf("write cache manifest: %w", err)
			}
		}
		if cacheErr != nil {
			result.OK = false
			result.Error = fmt.Sprintf("cache task outputs: %v", cacheErr)
			logPath, logErr := e.writeTaskLog(pkg.Name, def.Name, stdout, stderr, result.Error)
			result.LogPath = logPath
			if logErr != nil {
				result.LogError = logErr.Error()
				result.LogDirectory = e.logRoot
				result.Error = fmt.Sprintf("%s; write task log: %v", result.Error, logErr)
			}
		}
	}

	// 5. Persist execution state — always, regardless of cache:false.
	// Cache hits (early return above) do not update state; only real executions do.
	if result.OK {
		_ = e.states.SetClean(pkg.Name, def.Name, inputHash)
	} else {
		_ = e.states.SetDirty(pkg.Name, def.Name, "last_run_failed")
	}

	return result
}

func (e *Executor) writeTaskLog(pkgName, taskName, stdout, stderr, runError string) (string, error) {
	key := sha256.Sum256([]byte(pkgName + "\x00" + taskName))
	path := filepath.Join(e.logRoot, hex.EncodeToString(key[:])+".log")
	if err := os.MkdirAll(e.logRoot, 0o700); err != nil {
		return path, err
	}
	var content strings.Builder
	if stdout != "" {
		content.WriteString("stdout:\n")
		content.WriteString(stdout)
		if !strings.HasSuffix(stdout, "\n") {
			content.WriteByte('\n')
		}
	}
	if stderr != "" {
		content.WriteString("stderr:\n")
		content.WriteString(stderr)
		if !strings.HasSuffix(stderr, "\n") {
			content.WriteByte('\n')
		}
	}
	if runError != "" {
		content.WriteString("error:\n")
		content.WriteString(runError)
		content.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(content.String()), 0o600); err != nil {
		return path, err
	}
	return path, nil
}

func (e *Executor) taskFingerprint(def TaskDef) string {
	return taskFingerprint(def, e.runtimeFingerprint)
}

func taskFingerprint(def TaskDef, runtimeFingerprint string) string {
	parts := append([]string{
		cache.FormatVersion,
		runtimeFingerprint,
		def.Name,
		def.Command,
		strings.Join(def.Inputs, "\x00"),
		strings.Join(def.Outputs, "\x00"),
		strings.Join(def.Deps, "\x00"),
		strings.Join(taskEnvironment(def).hashed, "\x00"),
	}, strconv.FormatBool(def.Cache))
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:])
}

func hashTaskInputs(pkg workspace.Package, def TaskDef, depDirs []string, runtimeFingerprint, globalInputDigest, ownedInputDigest, dependencyDigest string) (string, error) {
	dependencyOutputs := make([]string, 0, len(def.Inputs))
	for _, input := range def.Inputs {
		if strings.HasPrefix(input, "^") {
			dependencyOutputs = append(dependencyOutputs, input)
		}
	}
	return cache.HashInputsWithOwnership(pkg.Dir, depDirs, dependencyOutputs, taskFingerprint(def, runtimeFingerprint), globalInputDigest, ownedInputDigest, dependencyDigest)
}

// runCommand executes a shell command in dir, returning stdout, stderr, exit code.
// If e.liveOutput is true, output is also streamed to os.Stdout/os.Stderr in real time.
func (e *Executor) runCommand(command, dir, packageName, taskName string, taskEnv []string, heartbeatInterval time.Duration) (stdout, stderr string, exitCode int, err error) {
	parts := splitCommand(command)
	if len(parts) == 0 {
		return "", "", 1, fmt.Errorf("empty command")
	}

	bin := resolveBin(parts[0], e.wsRoot, dir)

	var outBuf, errBuf bytes.Buffer

	var outW, errW io.Writer = &outBuf, &errBuf
	if e.liveOutput {
		outW = io.MultiWriter(&outBuf, os.Stdout)
		errW = io.MultiWriter(&errBuf, os.Stderr)
	}

	// Exactly the task's declared environment plus the toolchain's (env.go);
	// the rest of the host environment is deliberately not inherited.
	env := append(append([]string(nil), taskEnv...),
		"NODE_PATH="+filepath.Join(e.wsRoot, "node_modules"),
	)
	started := time.Now()
	type commandResult struct {
		result toolchain.Result
		err    error
	}
	wait := make(chan commandResult, 1)
	go func() {
		result, err := toolchain.Run(context.Background(), toolchain.Invocation{
			Tool: parts[0], Executable: bin, Args: parts[1:], Dir: dir, Env: env,
			Operation: toolchain.OperationWorkspaceTask, Stdout: outW, Stderr: errW,
		})
		wait <- commandResult{result: result, err: err}
	}()
	var completed commandResult
	if e.onHeartbeat == nil || heartbeatInterval <= 0 {
		completed = <-wait
	} else {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case completed = <-wait:
				goto finished
			case <-ticker.C:
				select {
				case completed = <-wait:
					goto finished
				default:
					e.onHeartbeat(packageName, taskName, time.Since(started))
				}
			}
		}
	}

finished:
	if completed.err != nil {
		var commandFailure *toolchain.CommandError
		var exit *exec.ExitError
		// Only a process that ran and exited non-zero is an exit code. A process
		// that never started has no exit code (0 would read as success).
		if errors.As(completed.err, &commandFailure) && errors.As(commandFailure, &exit) {
			return outBuf.String(), errBuf.String(), completed.result.ExitCode, nil
		}
		if errors.Is(completed.err, exec.ErrNotFound) || errors.Is(completed.err, fs.ErrNotExist) {
			return outBuf.String(), errBuf.String(), 127, &CommandNotFoundError{Command: parts[0], Err: completed.err}
		}
		return outBuf.String(), errBuf.String(), 1, completed.err
	}
	return outBuf.String(), errBuf.String(), completed.result.ExitCode, completed.err
}

// CommandNotFoundError is a task command whose executable does not exist: the
// process never started, so the task failed and no exit code was produced.
type CommandNotFoundError struct {
	Command string
	Err     error
}

func (e *CommandNotFoundError) Error() string {
	return fmt.Sprintf("command not found: %s (hint: install it, run `pnpm install` for a node tool)", e.Command)
}

func (e *CommandNotFoundError) Unwrap() error { return e.Err }

// storeOutputs walks output glob patterns, stores each file in ObjectStore,
// returns the OutputRef list for the manifest.
func (e *Executor) storeOutputs(pkgDir string, patterns []string) ([]cache.OutputRef, error) {
	fileList, err := expandOutputFiles(pkgDir, patterns)
	if err != nil {
		return nil, err
	}
	if len(fileList) == 0 {
		return nil, fmt.Errorf("declared outputs %s matched no file in %s", strings.Join(patterns, ", "), pkgDir)
	}
	sort.Strings(fileList)

	var refs []cache.OutputRef
	for _, rel := range fileList {
		absPath := filepath.Join(pkgDir, rel)
		info, err := os.Stat(absPath)
		if err != nil {
			return nil, fmt.Errorf("stat %s: %w", rel, err)
		}
		sha, err := e.objects.PutFile(absPath)
		if err != nil {
			return nil, fmt.Errorf("store %s: %w", rel, err)
		}
		mode := uint32(info.Mode().Perm())
		refs = append(refs, cache.OutputRef{Path: rel, Object: sha, Mode: &mode})
	}
	return refs, nil
}

// restoreOutputs copies cached output files back to their locations in pkgDir
// and then removes every file the declared output patterns still match that the
// manifest does not own, so the outputs are exactly the cached build's and not
// an overlay on an older one.
func (e *Executor) restoreOutputs(m *cache.Manifest, pkgDir string, patterns []string) error {
	owned := make(map[string]bool, len(m.Outputs))
	for _, ref := range m.Outputs {
		if ref.Mode == nil {
			return fmt.Errorf("restore %s: cached output has no file mode", ref.Path)
		}
		dest := filepath.Join(pkgDir, ref.Path)
		if err := e.objects.RestoreFile(ref.Object, dest, os.FileMode(*ref.Mode)); err != nil {
			return fmt.Errorf("restore %s: %w", ref.Path, err)
		}
		owned[filepath.ToSlash(ref.Path)] = true
	}
	if len(patterns) == 0 {
		return nil
	}
	present, err := expandOutputFiles(pkgDir, patterns)
	if err != nil {
		return fmt.Errorf("list outputs to prune: %w", err)
	}
	for _, rel := range present {
		if owned[filepath.ToSlash(rel)] {
			continue
		}
		if err := os.Remove(filepath.Join(pkgDir, rel)); err != nil {
			return fmt.Errorf("remove stale output %s: %w", rel, err)
		}
	}
	return nil
}

// expandOutputFiles returns relative paths of files matching patterns in pkgDir.
// Simpler than HashInputs — we don't need a hash, just file paths.
func expandOutputFiles(pkgDir string, patterns []string) ([]string, error) {
	seen := make(map[string]bool)
	for _, pattern := range patterns {
		pattern = strings.TrimPrefix(pattern, "^")
		err := filepath.WalkDir(pkgDir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(pkgDir, path)
			if matchGlobSimple(pattern, filepath.ToSlash(rel)) {
				seen[rel] = true
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	var result []string
	for rel := range seen {
		result = append(result, rel)
	}
	return result, nil
}

// matchGlobSimple matches a path against a glob pattern (** supported).
func matchGlobSimple(pattern, path string) bool {
	patParts := strings.Split(filepath.ToSlash(pattern), "/")
	pathParts := strings.Split(path, "/")
	return matchGlobParts(patParts, pathParts)
}

func matchGlobParts(patParts, pathParts []string) bool {
	for len(patParts) > 0 {
		pat := patParts[0]
		patParts = patParts[1:]
		if pat == "**" {
			for i := 0; i <= len(pathParts); i++ {
				if matchGlobParts(patParts, pathParts[i:]) {
					return true
				}
			}
			return false
		}
		if len(pathParts) == 0 {
			return false
		}
		ok, _ := filepath.Match(pat, pathParts[0])
		if !ok {
			return false
		}
		pathParts = pathParts[1:]
	}
	return len(pathParts) == 0
}

// resolveBin finds binary in workspace node_modules/.bin or PATH.
func resolveBin(name, wsRoot, packageDir string) string {
	// Handle compound commands like "eslint src/" — name is just "eslint".
	if filepath.IsAbs(name) {
		return name
	}
	for _, candidate := range []string{
		filepath.Join(packageDir, "node_modules", ".bin", name),
		filepath.Join(wsRoot, "node_modules", ".bin", name),
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return name
}

// splitCommand splits a command string into parts, handling simple quoting.
// "eslint src/" → ["eslint", "src/"]
// "tsc --noEmit" → ["tsc", "--noEmit"]
func splitCommand(cmd string) []string {
	var parts []string
	var current strings.Builder
	inQuote := false
	quoteChar := rune(0)

	for _, r := range cmd {
		switch {
		case inQuote && r == quoteChar:
			inQuote = false
		case !inQuote && (r == '\'' || r == '"'):
			inQuote = true
			quoteChar = r
		case !inQuote && r == ' ':
			if current.Len() > 0 {
				parts = append(parts, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	return parts
}
