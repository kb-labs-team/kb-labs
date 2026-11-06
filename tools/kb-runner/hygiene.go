//go:build darwin || linux

package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

const (
	hygieneDefaultCacheBudget = uint64(4 << 30)
	hygieneDiskFloor          = uint64(3 << 30)
	hygieneArtifactAge        = 3 * 24 * time.Hour
	hygieneRetireAge          = 48 * time.Hour
)

type hygieneOptions struct {
	Root, State, Integration, Cache string
	Context                         context.Context
	Progress                        func(hygieneAction)
	DryRun                          bool
	Now                             time.Time
	CacheBudget                     uint64
	WorktreeOnly                    bool
	RetireAge                       time.Duration
}

type hygieneAction struct {
	Rule          string `json:"rule"`
	Path          string `json:"path,omitempty"`
	Action        string `json:"action"`
	Bytes         uint64 `json:"bytes"`
	ObservedBytes uint64 `json:"observedBytes,omitempty"`
	Cause         string `json:"cause,omitempty"`
}

type hygieneReport struct {
	DryRun            bool            `json:"dryRun"`
	Actions           []hygieneAction `json:"actions"`
	Bytes             uint64          `json:"bytesFreed"`
	eventRoot         string
	foreignUIDAlerted bool
	progress          func(hygieneAction)
}

type hygieneJournalRecord struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	Rule       string `json:"rule"`
	Path       string `json:"path"`
	Reason     string `json:"reason"`
	Action     string `json:"action"`
	Bytes      uint64 `json:"bytesFreed"`
	Archive    string `json:"archivePath,omitempty"`
	ArchiveSHA string `json:"archiveSHA256,omitempty"`
	At         string `json:"at"`
}

func hygieneCommand(root runnerRoot, args []string, out, _ io.Writer) (status int, runErr error) {
	if len(args) == 0 || args[0] != "sweep" {
		if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
			_, err := fmt.Fprintf(out, "Usage: %s hygiene sweep [--dry-run] [--json]\n", root.Name())
			return 0, err
		}
		return 2, fmt.Errorf("%s hygiene: use hygiene sweep [--dry-run] [--json]; next: %s hygiene --help", root.Name(), root.InvocationCommand())
	}
	fs := flag.NewFlagSet("hygiene sweep", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	dryRun := fs.Bool("dry-run", false, "plan actions without changing files")
	jsonOutput := fs.Bool("json", false, "print the structured sweep report")
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	worktreeRoot := fs.String("root", os.Getenv("KBLABS_WORKTREES_ROOT"), "orchestration worktree root")
	integration := fs.String("integration-tree", "", "configured integration worktree")
	cache := fs.String("cache", "", "Go build cache to measure")
	budget := fs.Uint64("cache-budget", 0, "maximum Go build cache bytes (default 4 GiB; KBLABS_RUNNER_GOCACHE_BUDGET_BYTES overrides)")
	retireAge := fs.Duration("orphan-age", 0, "minimum age before removing an unregistered dirty worktree (default 48h; KBLABS_RUNNER_ORPHAN_AGE overrides)")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, writeErr := fmt.Fprintf(out, "Usage: %s hygiene sweep [--root PATH] [--integration-tree PATH] [--state PATH] [--dry-run] [--json]\n", root.Name())
			return 0, writeErr
		}
		return 2, fmt.Errorf("%s hygiene sweep: %w; next: %s hygiene sweep --help", root.Name(), err, root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "hygiene sweep", *state)
	if err != nil {
		return 2, err
	}
	*state = resolvedState
	if *worktreeRoot == "" {
		return 2, fmt.Errorf("%s hygiene sweep: --root or KBLABS_WORKTREES_ROOT is required; next: %s hygiene sweep --root <orchestration-root> --dry-run --json", root.Name(), root.InvocationCommand())
	}
	resolvedRoot, err := filepath.Abs(*worktreeRoot)
	if err != nil {
		return 1, fmt.Errorf("resolve orchestration root: %w", err)
	}
	if *integration == "" {
		tasks, err := newSchedulerStore(*state).tasks()
		if err != nil {
			return 1, fmt.Errorf("read scheduler tasks to resolve integration worktree: %w", err)
		}
		if len(tasks) == 0 {
			return 2, fmt.Errorf("%s hygiene sweep: no scheduler task identifies the configured integration tree; pass --integration-tree; next: %s hygiene sweep --help", root.Name(), root.InvocationCommand())
		}
		data, err := os.ReadFile(filepath.Join(tasks[0].RepoRoot, "tools", "kb-runner", "scheduler-policy.json"))
		if err != nil {
			return 1, fmt.Errorf("read integration policy for scheduler task %s: %w", tasks[0].ID, err)
		}
		var policy schedulerPolicy
		if err := json.Unmarshal(data, &policy); err != nil {
			return 1, fmt.Errorf("decode integration policy for scheduler task %s: %w", tasks[0].ID, err)
		}
		*integration = filepath.Join(tasks[0].WorktreeRoot, strings.TrimPrefix(policy.IntegrationBranch, "agent/"))
	}
	lease, acquired, err := proc.AcquireFileLease(hygieneLeasePath(*state), proc.LeaseExclusiveTry)
	if err != nil {
		return 1, fmt.Errorf("acquire hygiene sweep lease: %w; next: %s hygiene sweep --state %q --dry-run --json", err, root.InvocationCommand(), *state)
	}
	if !acquired {
		return 2, fmt.Errorf("hygiene sweep is already running; next: %s hygiene sweep --state %q --dry-run --json", root.InvocationCommand(), *state)
	}
	defer func() { runErr = errors.Join(runErr, lease.Close()) }()
	report, err := runHygieneSweep(hygieneOptions{Root: resolvedRoot, State: *state, Integration: *integration, Cache: *cache, DryRun: *dryRun, CacheBudget: *budget, RetireAge: *retireAge, Now: time.Now()})
	if err != nil {
		return 1, err
	}
	if *jsonOutput {
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			return 1, fmt.Errorf("write hygiene report: %w", err)
		}
		return 0, nil
	}
	for _, action := range report.Actions {
		if _, err := fmt.Fprintf(out, "%s %s bytes=%d", action.Action, action.Path, action.Bytes); err != nil {
			return 1, err
		}
		if action.Cause != "" {
			if _, err := fmt.Fprintf(out, " cause=%s", action.Cause); err != nil {
				return 1, err
			}
		}
		if _, err := fmt.Fprintln(out); err != nil {
			return 1, err
		}
	}
	_, err = fmt.Fprintf(out, "bytes freed: %d\n", report.Bytes)
	return 0, err
}

func runHygieneSweep(options hygieneOptions) (hygieneReport, error) {
	if options.Context == nil {
		options.Context = context.Background()
	}
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	var cacheBudgetErr error
	if options.CacheBudget == 0 {
		budget := os.Getenv("KBLABS_RUNNER_GOCACHE_BUDGET_BYTES")
		if budget == "" {
			options.CacheBudget = hygieneDefaultCacheBudget
		} else {
			parsed, err := strconv.ParseUint(budget, 10, 64)
			if err != nil {
				cacheBudgetErr = fmt.Errorf("KBLABS_RUNNER_GOCACHE_BUDGET_BYTES must be an unsigned byte count: %w", err)
			} else {
				options.CacheBudget = parsed
			}
		}
	}
	var retireAgeErr error
	if options.RetireAge == 0 {
		age := os.Getenv("KBLABS_RUNNER_ORPHAN_AGE")
		if age == "" {
			options.RetireAge = hygieneRetireAge
		} else {
			parsed, err := time.ParseDuration(age)
			if err != nil || parsed <= 0 {
				retireAgeErr = fmt.Errorf("KBLABS_RUNNER_ORPHAN_AGE must be a positive duration: %q", age)
			} else {
				options.RetireAge = parsed
			}
		}
	}
	report := hygieneReport{DryRun: options.DryRun, Actions: []hygieneAction{}, eventRoot: options.Root, progress: options.Progress}
	if err := options.Context.Err(); err != nil {
		return report, err
	}
	if !options.DryRun {
		if err := reconcileHygieneJournal(options.Root); err != nil {
			reportHygieneAlert(&report, "journal", options.Root, err)
			return report, nil
		}
	}
	if retireAgeErr != nil {
		reportHygieneAlert(&report, "worktree", options.Root, retireAgeErr)
	} else if err := sweepWorktrees(options, &report); err != nil {
		reportHygieneAlert(&report, "worktree", options.Root, err)
	}
	if !options.WorktreeOnly {
		for _, state := range ownedRunnerStates(options.Root, options.State) {
			if err := sweepJobTemp(state, options.Context, options.DryRun, &report); err != nil {
				reportHygieneAlert(&report, "job-temp", state, err)
			}
			if err := sweepTestChannelCaches(state, options.Context, options.DryRun, &report); err != nil {
				reportHygieneAlert(&report, "test-channel-cache", filepath.Join(state, "test-channel", "streams"), err)
			}
		}
		if cacheBudgetErr != nil {
			reportHygieneAlert(&report, "go-cache", options.Cache, cacheBudgetErr)
		} else if err := sweepGoCache(options, &report); err != nil {
			reportHygieneAlert(&report, "go-cache", options.Cache, err)
		}
		if err := sweepBatchArtifacts(options, &report); err != nil {
			reportHygieneAlert(&report, "batch-artifact", filepath.Join(options.Root, "reports"), err)
		}
	}
	return report, nil
}

func reportHygieneAlert(report *hygieneReport, rule, path string, failure error) {
	action := hygieneAction{Rule: rule, Path: path, Action: "alert", Cause: failure.Error()}
	report.Actions = append(report.Actions, action)
	if report.progress != nil {
		report.progress(action)
	}
	if report.DryRun || report.eventRoot == "" {
		return
	}
	if err := appendHygieneEvent(report.eventRoot, action); err != nil {
		log.Printf("kb-runner hygiene alert: rule=%s path=%q cause=%q event_error=%q", rule, path, failure.Error(), err.Error())
	}
}

func (options schedulerRunOptions) hygieneOptions() (hygieneOptions, bool, error) {
	tasks, err := options.store.tasks()
	if err != nil {
		return hygieneOptions{}, false, err
	}
	if len(tasks) == 0 {
		return hygieneOptions{}, false, nil
	}
	task := tasks[0]
	policy, err := options.policy(task)
	if err != nil {
		return hygieneOptions{}, false, err
	}
	integration := filepath.Join(task.WorktreeRoot, strings.TrimPrefix(policy.IntegrationBranch, "agent/"))
	return hygieneOptions{Root: task.WorktreeRoot, State: options.state, Integration: integration, Now: time.Now()}, true, nil
}

func (options schedulerRunOptions) startHygieneSweep(parent context.Context, worktreeOnly bool) {
	work := func() {
		hygiene, available, err := options.hygieneOptions()
		if err != nil {
			options.reportSchedulerHygieneAlert("sweep", options.state, err)
			return
		}
		if !available {
			return
		}
		hygiene.WorktreeOnly = worktreeOnly
		hygiene.Context = parent
		hygiene.Progress = func(action hygieneAction) {
			if parent.Err() != nil {
				return
			}
			if err := appendHygieneEvent(hygiene.Root, hygieneAction{Rule: action.Rule, Path: action.Path, Action: "progress", Cause: action.Action}); err != nil {
				options.reportSchedulerHygieneAlert("journal", action.Path, err)
			}
		}
		lease, acquired, err := proc.AcquireFileLease(hygieneLeasePath(options.state), proc.LeaseExclusiveTry)
		if err != nil {
			options.reportSchedulerHygieneAlert("sweep", hygiene.Root, fmt.Errorf("acquire hygiene lease: %w", err))
			return
		}
		if !acquired {
			_ = appendHygieneAction(&hygieneReport{eventRoot: hygiene.Root}, hygieneAction{Rule: "sweep", Path: hygiene.Root, Action: "skipped", Cause: "another hygiene sweep holds the dedicated lease"})
			return
		}
		defer lease.Close()
		if err := appendHygieneEvent(hygiene.Root, hygieneAction{Rule: "sweep", Path: hygiene.Root, Action: "started"}); err != nil {
			options.reportSchedulerHygieneAlert("journal", hygiene.Root, fmt.Errorf("record sweep start: %w", err))
			return
		}
		if parent.Err() != nil {
			return
		}
		_, err = runHygieneSweep(hygiene)
		if err != nil {
			options.reportSchedulerHygieneAlert("sweep", hygiene.Root, err)
			return
		}
		if err := appendHygieneEvent(hygiene.Root, hygieneAction{Rule: "sweep", Path: hygiene.Root, Action: "completed"}); err != nil {
			options.reportSchedulerHygieneAlert("journal", hygiene.Root, err)
		}
	}
	if options.maintenance != nil {
		options.maintenance.Start(work)
		return
	}
	go work()
}

func (options schedulerRunOptions) reportSchedulerHygieneAlert(rule, path string, cause error) {
	if err := options.store.appendEvent(map[string]any{"kind": "hygiene.alert", "rule": rule, "path": path, "cause": cause.Error(), "time": time.Now().UTC()}); err != nil {
		log.Printf("kb-runner hygiene alert could not be persisted: rule=%s path=%q cause=%q event_error=%q", rule, path, cause.Error(), err.Error())
	}
}

func (options schedulerRunOptions) orchestrationDiskLow() (bool, error) {
	hygiene, available, err := options.hygieneOptions()
	if err != nil || !available {
		return false, err
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(hygiene.Root, &stat); err != nil {
		return false, fmt.Errorf("inspect free space for orchestration root %s: %w", hygiene.Root, err)
	}
	return uint64(stat.Bavail)*uint64(stat.Bsize) < hygieneDiskFloor, nil
}

func ownedRunnerStates(root, state string) []string {
	states := []string{filepath.Join(root, "logs", "runner"), filepath.Join(root, "logs", "runner-zcode")}
	if state != "" {
		abs, err := filepath.Abs(state)
		if err == nil && withinRoot(root, abs) {
			states = append(states, abs)
		}
	}
	sort.Strings(states)
	out := states[:0]
	for _, candidate := range states {
		if len(out) == 0 || out[len(out)-1] != candidate {
			out = append(out, candidate)
		}
	}
	return out
}

func sweepJobTemp(state string, ctx context.Context, dryRun bool, report *hygieneReport) error {
	jobs, err := newJobStore(state).List()
	if err != nil {
		return fmt.Errorf("list runner jobs in %s: %w", state, err)
	}
	byID := make(map[string]Job, len(jobs))
	for _, job := range jobs {
		byID[job.ID] = job
	}
	jobsDir := filepath.Join(state, "jobs")
	entries, err := os.ReadDir(jobsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		if err := validateJobID(id); err != nil {
			reportHygieneAlert(report, "job-temp", filepath.Join(jobsDir, id), err)
			continue
		}
		job, exists := byID[id]
		if exists && !job.State.Terminal() {
			continue
		}
		temp := filepath.Join(jobsDir, id, "tmp")
		bytes, err := treeBytes(temp)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			reportHygieneAlert(report, "job-temp", temp, err)
			continue
		}
		if dryRun {
			report.Actions = append(report.Actions, hygieneAction{Rule: "job-temp", Path: temp, Action: "would-reap", Bytes: bytes})
			continue
		}
		action := hygieneAction{Rule: "job-temp", Path: temp, Action: "reaped", Bytes: bytes, Cause: "terminal job temporary directory"}
		intent, err := beginHygieneReclaim(report, action, "", "")
		if err != nil {
			reportHygieneAlert(report, "job-temp", temp, err)
			continue
		}
		reclaimed, found, failure, failurePath := reapJobTemp(jobsDir, id)
		if failure != "" {
			reportHygieneAlert(report, "job-temp", failurePath, fmt.Errorf("reap job temp %s: %s", id, failure))
			continue
		}
		if found {
			if reclaimed != intent.Bytes {
				reportHygieneAlert(report, "job-temp", temp, fmt.Errorf("job temp reclaim measured %d bytes after intent recorded %d", reclaimed, intent.Bytes))
				continue
			}
			if err := completeHygieneReclaim(report.eventRoot, intent); err != nil {
				reportHygieneAlert(report, "job-temp", temp, err)
				continue
			}
			recordHygieneReclaimResult(report, intent)
		}
	}
	return nil
}

func sweepTestChannelCaches(state string, ctx context.Context, dryRun bool, report *hygieneReport) error {
	jobs, err := newJobStore(state).ListRecords()
	if err != nil {
		return fmt.Errorf("list runner jobs for outside-test caches in %s: %w", state, err)
	}
	active := make(map[string]struct{})
	for _, job := range jobs {
		if !job.State.Terminal() {
			active[filepath.Base(filepath.Dir(testChannelCachePath(state, job.Stream)))] = struct{}{}
		}
	}
	root := filepath.Join(state, "test-channel", "streams")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read outside-test stream caches: %w", err)
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.IsDir() {
			return fmt.Errorf("outside-test cache entry %q is not a directory", entry.Name())
		}
		if _, keep := active[entry.Name()]; keep {
			continue
		}
		path := filepath.Join(root, entry.Name())
		bytes, err := treeBytes(path)
		if err != nil {
			return fmt.Errorf("measure abandoned outside-test cache %s: %w", path, err)
		}
		if dryRun {
			report.Actions = append(report.Actions, hygieneAction{Rule: "test-channel-cache", Path: path, Action: "would-reap", Bytes: bytes, Cause: "stream has no active runner job"})
			continue
		}
		action := hygieneAction{Rule: "test-channel-cache", Path: path, Action: "reaped", Bytes: bytes, Cause: "stream has no active runner job"}
		intent, err := beginHygieneReclaim(report, action, "", "")
		if err != nil {
			return fmt.Errorf("journal abandoned outside-test cache %s: %w", path, err)
		}
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("reap abandoned outside-test cache %s: %w", path, err)
		}
		if err := completeHygieneReclaim(report.eventRoot, intent); err != nil {
			return fmt.Errorf("complete abandoned outside-test cache journal %s: %w", path, err)
		}
		recordHygieneReclaimResult(report, intent)
	}
	return nil
}

func sweepGoCache(options hygieneOptions, report *hygieneReport) (returnErr error) {
	cache := options.Cache
	if cache == "" {
		cache = os.Getenv("GOCACHE")
	}
	if cache == "" {
		out, err := exec.Command("go", "env", "GOCACHE").Output()
		if err != nil {
			return fmt.Errorf("locate Go build cache: %w", err)
		}
		cache = strings.TrimSpace(string(out))
	}
	if _, err := os.Stat(cache); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect Go build cache %s: %w", cache, err)
	}
	owned, err := runnerOwnsGoCache(options.Root, cache)
	if err != nil {
		return err
	}
	if !owned {
		return appendHygieneAction(report, hygieneAction{Rule: "go-cache", Path: cache, Action: "skipped", Cause: "Go cache is outside the configured orchestration root"})
	}
	bytes, err := treeBytes(cache)
	if err != nil {
		return fmt.Errorf("measure Go build cache %s: %w", cache, err)
	}
	if bytes <= options.CacheBudget {
		return nil
	}
	state := options.State
	if state == "" {
		state = defaultRunnerState()
	}
	if err := os.MkdirAll(state, 0o700); err != nil {
		return err
	}
	if options.DryRun {
		report.Actions = append(report.Actions, hygieneAction{Rule: "go-cache", Path: cache, Action: "would-clean", Bytes: bytes})
		return nil
	}
	action := hygieneAction{Rule: "go-cache", Path: cache, Action: "cleaned", Bytes: bytes, Cause: "Go cache exceeded its configured byte budget"}
	intent, err := beginHygieneReclaim(report, action, "", "")
	if err != nil {
		return err
	}
	stdout, err := os.CreateTemp(os.TempDir(), "kb-runner-hygiene-stdout-")
	if err != nil {
		return err
	}
	stdoutPath := stdout.Name()
	defer func() { returnErr = errors.Join(returnErr, os.Remove(stdoutPath)) }()
	if err := stdout.Close(); err != nil {
		return err
	}
	stderr, err := os.CreateTemp(os.TempDir(), "kb-runner-hygiene-stderr-")
	if err != nil {
		return err
	}
	stderrPath := stderr.Name()
	defer func() { returnErr = errors.Join(returnErr, os.Remove(stderrPath)) }()
	if err := stderr.Close(); err != nil {
		return err
	}
	cleanupContext, cancel := context.WithCancel(options.Context)
	defer cancel()
	run, err := proc.Start(cleanupContext, proc.Config{StateDir: state, Tag: "hygiene-go-cache", Stall: 30 * time.Minute, StdoutPath: stdoutPath, StderrPath: stderrPath, CostKey: "go-test", CostClass: proc.CostHeavy, CostKeyLeaseMode: proc.LeaseExclusiveTry, Env: []string{"GOCACHE=" + cache}, Command: []string{"go", "clean", "-cache"}})
	if err != nil {
		if errors.Is(err, proc.ErrLeaseBusy) {
			return appendHygieneAction(report, hygieneAction{Rule: "go-cache", Path: cache, Action: "skipped", ObservedBytes: bytes, Cause: "go-test cost-key slot is held by another run"})
		}
		return fmt.Errorf("start governed Go cache cleanup: %w", err)
	}
	if err := run.Wait(); err != nil {
		return fmt.Errorf("clean Go build cache %s: %w", cache, err)
	}
	if err := completeHygieneReclaim(report.eventRoot, intent); err != nil {
		return err
	}
	recordHygieneReclaimResult(report, intent)
	return nil
}

func runnerOwnsGoCache(root, cache string) (bool, error) {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false, fmt.Errorf("resolve orchestration root for Go cache ownership: %w", err)
	}
	resolvedCache, err := filepath.EvalSymlinks(cache)
	if err != nil {
		return false, fmt.Errorf("resolve Go cache for ownership: %w", err)
	}
	if withinRoot(resolvedRoot, resolvedCache) {
		return true, nil
	}
	configuredRoot := os.Getenv("KBLABS_WORKTREES_ROOT")
	if configuredRoot == "" {
		return false, nil
	}
	configuredRoot, err = filepath.EvalSymlinks(configuredRoot)
	if err != nil {
		return false, fmt.Errorf("resolve configured orchestration root %s: %w", os.Getenv("KBLABS_WORKTREES_ROOT"), err)
	}
	if configuredRoot != resolvedRoot {
		return false, nil
	}
	configuredCache := os.Getenv("GOCACHE")
	if configuredCache == "" {
		output, err := exec.Command("go", "env", "GOCACHE").Output()
		if err != nil {
			return false, fmt.Errorf("resolve configured Go cache: %w", err)
		}
		configuredCache = strings.TrimSpace(string(output))
	}
	configuredCache, err = filepath.EvalSymlinks(configuredCache)
	if err != nil {
		return false, fmt.Errorf("resolve configured Go cache %s: %w", configuredCache, err)
	}
	return configuredCache == resolvedCache, nil
}

func sweepBatchArtifacts(options hygieneOptions, report *hygieneReport) error {
	ctx := options.Context
	if ctx == nil {
		ctx = context.Background()
	}
	pattern := filepath.Join(options.Root, "reports", "j*-local")
	local, err := filepath.Glob(pattern)
	if err != nil {
		return err
	}
	shared, err := filepath.Glob(filepath.Join(options.Root, "reports", "j*-shared"))
	if err != nil {
		return err
	}
	paths := append(local, shared...)
	sort.Slice(paths, func(i, j int) bool {
		left, leftErr := os.Stat(paths[i])
		right, rightErr := os.Stat(paths[j])
		if leftErr == nil && rightErr == nil && !left.ModTime().Equal(right.ModTime()) {
			return left.ModTime().After(right.ModTime())
		}
		return paths[i] > paths[j]
	})
	protected := make(map[string]bool)
	for i := 0; i < len(paths) && i < 3; i++ {
		protected[paths[i]] = true
	}
	sort.Strings(paths)
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		if protected[path] {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			reportHygieneAlert(report, "batch-artifact", path, err)
			continue
		}
		if !info.IsDir() || options.Now.Sub(info.ModTime()) < hygieneArtifactAge {
			continue
		}
		bytes, err := treeBytes(path)
		if err != nil {
			reportHygieneAlert(report, "batch-artifact", path, err)
			continue
		}
		archive := path + ".tar.gz"
		if options.DryRun {
			report.Actions = append(report.Actions, hygieneAction{Rule: "batch-artifact", Path: path, Action: "would-compress", Bytes: bytes})
			continue
		}
		if err := createTarGz(ctx, path, archive); err != nil {
			reportHygieneAlert(report, "batch-artifact", path, err)
			continue
		}
		if err := verifyTarGz(path, archive); err != nil {
			reportHygieneAlert(report, "batch-artifact", path, fmt.Errorf("verify batch archive %s: %w", archive, err))
			if removeErr := os.Remove(archive); removeErr != nil {
				reportHygieneAlert(report, "batch-artifact", archive, fmt.Errorf("remove unverified archive: %w", removeErr))
			}
			continue
		}
		archiveInfo, err := os.Stat(archive)
		if err != nil {
			reportHygieneAlert(report, "batch-artifact", archive, err)
			continue
		}
		if uint64(archiveInfo.Size()) >= bytes {
			bytes = 0
		} else {
			bytes -= uint64(archiveInfo.Size())
		}
		archiveSHA, err := fileSHA256(archive)
		if err != nil {
			reportHygieneAlert(report, "batch-artifact", archive, err)
			continue
		}
		action := hygieneAction{Rule: "batch-artifact", Path: path, Action: "compressed", Bytes: bytes, Cause: "verified reversible archive created"}
		intent, err := beginHygieneReclaim(report, action, archive, archiveSHA)
		if err != nil {
			reportHygieneAlert(report, "batch-artifact", path, err)
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			reportHygieneAlert(report, "batch-artifact", path, fmt.Errorf("remove verified archive source: %w", err))
			continue
		}
		if err := completeHygieneReclaim(report.eventRoot, intent); err != nil {
			reportHygieneAlert(report, "batch-artifact", path, err)
			continue
		}
		recordHygieneReclaimResult(report, intent)
	}
	return nil
}

func createTarGz(ctx context.Context, source, destination string) error {
	file, err := os.Create(destination)
	if err != nil {
		return err
	}
	compressor := gzip.NewWriter(file)
	writer := tar.NewWriter(compressor)
	base := filepath.Dir(source)
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(base, path)
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				return err
			}
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(rel)
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("batch artifact contains unsupported file type at %s", path)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		copyErr := copyWithContext(ctx, writer, input)
		closeErr := input.Close()
		return errors.Join(copyErr, closeErr)
	})
	closeErr := errors.Join(writer.Close(), compressor.Close(), file.Close())
	if err != nil {
		return errors.Join(err, os.Remove(destination))
	}
	if closeErr != nil {
		return errors.Join(closeErr, os.Remove(destination))
	}
	return nil
}

func copyWithContext(ctx context.Context, destination io.Writer, source io.Reader) error {
	buffer := make([]byte, 128*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		read, err := source.Read(buffer)
		if read > 0 {
			if _, writeErr := destination.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

type archiveTreeNode struct {
	Mode    os.FileMode
	Target  string
	Content [32]byte
}

func verifyTarGz(source, archive string) (returnErr error) {
	temporary, err := os.MkdirTemp("", "kb-runner-archive-verify-")
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, os.RemoveAll(temporary)) }()
	if err := extractTarGz(archive, temporary); err != nil {
		return err
	}
	restored := filepath.Join(temporary, filepath.Base(source))
	sourceTree, err := snapshotArchiveTree(source)
	if err != nil {
		return err
	}
	restoredTree, err := snapshotArchiveTree(restored)
	if err != nil {
		return err
	}
	if len(sourceTree) != len(restoredTree) {
		return fmt.Errorf("archive tree entry count changed: source=%d restored=%d", len(sourceTree), len(restoredTree))
	}
	for name, sourceNode := range sourceTree {
		restoredNode, exists := restoredTree[name]
		if !exists || sourceNode.Mode.Type() != restoredNode.Mode.Type() || sourceNode.Mode.Perm() != restoredNode.Mode.Perm() || sourceNode.Target != restoredNode.Target || sourceNode.Content != restoredNode.Content {
			return fmt.Errorf("archive tree entry %q differs after extraction", name)
		}
	}
	return nil
}

func extractTarGz(archive, destination string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return errors.Join(err, file.Close())
	}
	reader := tar.NewReader(compressed)
	var directories []struct {
		path string
		mode os.FileMode
	}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return errors.Join(err, compressed.Close(), file.Close())
		}
		name := filepath.Clean(filepath.FromSlash(header.Name))
		if !filepath.IsLocal(name) || name == "." {
			return errors.Join(fmt.Errorf("archive contains unsafe path %q", header.Name), compressed.Close(), file.Close())
		}
		path := filepath.Join(destination, name)
		mode := os.FileMode(header.Mode).Perm()
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o700); err != nil {
				return errors.Join(err, compressed.Close(), file.Close())
			}
			directories = append(directories, struct {
				path string
				mode os.FileMode
			}{path: path, mode: mode})
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return errors.Join(err, compressed.Close(), file.Close())
			}
			if err := os.Symlink(header.Linkname, path); err != nil {
				return errors.Join(err, compressed.Close(), file.Close())
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return errors.Join(err, compressed.Close(), file.Close())
			}
			output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return errors.Join(err, compressed.Close(), file.Close())
			}
			_, copyErr := io.CopyN(output, reader, header.Size)
			chmodErr := output.Chmod(mode)
			closeErr := output.Close()
			if err := errors.Join(copyErr, chmodErr, closeErr); err != nil {
				return errors.Join(err, compressed.Close(), file.Close())
			}
		default:
			return errors.Join(fmt.Errorf("archive contains unsupported entry type %d", header.Typeflag), compressed.Close(), file.Close())
		}
	}
	var closeErr error
	closeErr = errors.Join(closeErr, compressed.Close(), file.Close())
	for index := len(directories) - 1; index >= 0; index-- {
		closeErr = errors.Join(closeErr, os.Chmod(directories[index].path, directories[index].mode))
	}
	return closeErr
}

func snapshotArchiveTree(root string) (map[string]archiveTreeNode, error) {
	entries := make(map[string]archiveTreeNode)
	err := filepath.WalkDir(root, func(path string, _ fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		node := archiveTreeNode{Mode: info.Mode()}
		if info.Mode()&os.ModeSymlink != 0 {
			node.Target, err = os.Readlink(path)
			if err != nil {
				return err
			}
		} else if info.Mode().IsRegular() {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, file)
			closeErr := file.Close()
			if err := errors.Join(copyErr, closeErr); err != nil {
				return err
			}
			copy(node.Content[:], hash.Sum(nil))
		} else if !info.IsDir() {
			return fmt.Errorf("archive source contains unsupported file type at %s", path)
		}
		entries[filepath.ToSlash(relative)] = node
		return nil
	})
	return entries, err
}

func treeBytes(root string) (uint64, error) {
	var total uint64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += uint64(info.Size())
		}
		return nil
	})
	return total, err
}

func appendHygieneAction(report *hygieneReport, action hygieneAction) error {
	recordHygieneAction(report, action)
	if report.DryRun || report.eventRoot == "" {
		return nil
	}
	if err := appendHygieneEvent(report.eventRoot, action); err != nil {
		return fmt.Errorf("record hygiene event for %s: %w", action.Path, err)
	}
	return nil
}

func recordHygieneAction(report *hygieneReport, action hygieneAction) {
	report.Actions = append(report.Actions, action)
	if report.progress != nil {
		report.progress(action)
	}
	switch action.Action {
	case "removed", "archived-and-removed", "reaped", "cleaned", "compressed":
		report.Bytes += action.Bytes
	}
}

func hygieneActionFromIntent(intent hygieneJournalRecord) hygieneAction {
	return hygieneAction{Rule: intent.Rule, Path: intent.Path, Action: intent.Action, Bytes: intent.Bytes, Cause: intent.Reason}
}

func recordHygieneReclaimResult(report *hygieneReport, intent hygieneJournalRecord) {
	recordHygieneAction(report, hygieneActionFromIntent(intent))
}

func appendHygieneEvent(root string, action hygieneAction) (returnErr error) {
	return appendHygieneEventRecord(root, action, "")
}

func appendHygieneReclaimEvent(root string, intent hygieneJournalRecord) (returnErr error) {
	if intent.ID == "" || intent.Action == "" {
		return errors.New("hygiene reclaim event requires intent ID and action")
	}
	action := hygieneAction{Rule: intent.Rule, Path: intent.Path, Action: intent.Action, Bytes: intent.Bytes, Cause: intent.Reason}
	return appendHygieneEventRecord(root, action, intent.ID)
}

func appendHygieneEventRecord(root string, action hygieneAction, reclaimID string) (returnErr error) {
	events := filepath.Join(root, "logs", "events.log")
	if err := os.MkdirAll(filepath.Dir(events), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(events, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return errors.Join(err, file.Close())
	}
	defer func() {
		returnErr = errors.Join(returnErr, syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
	}()
	body := hygieneEventBody(action, reclaimID)
	if reclaimID != "" {
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return err
		}
		data, err := io.ReadAll(file)
		if err != nil {
			return err
		}
		marker := fmt.Sprintf("reclaim_id=%q", reclaimID)
		for _, line := range strings.Split(string(data), "\n") {
			_, existingBody, ok := strings.Cut(line, " | ")
			if !ok || !strings.Contains(existingBody, marker) {
				continue
			}
			if existingBody != body {
				return fmt.Errorf("reclaim event %s already exists with different content", reclaimID)
			}
			return file.Sync()
		}
	}
	if _, err := fmt.Fprintf(file, "%s | %s\n", time.Now().Format("01-02 15:04"), body); err != nil {
		return err
	}
	return file.Sync()
}

func hygieneEventBody(action hygieneAction, reclaimID string) string {
	body := fmt.Sprintf("HYGIENE %s rule=%q path=%q bytes=%d cause=%q", action.Action, action.Rule, action.Path, action.Bytes, action.Cause)
	if reclaimID != "" {
		body += fmt.Sprintf(" reclaim_id=%q", reclaimID)
	}
	return body
}

func hygieneLeasePath(state string) string {
	return filepath.Join(state, "hygiene.lock")
}

func beginHygieneReclaim(report *hygieneReport, action hygieneAction, archive, archiveSHA string) (hygieneJournalRecord, error) {
	if report.DryRun {
		return hygieneJournalRecord{}, errors.New("cannot journal a destructive hygiene action during dry-run")
	}
	if action.Action == "" || action.Rule == "" || action.Path == "" {
		return hygieneJournalRecord{}, errors.New("hygiene reclaim intent requires rule, path, and completion action")
	}
	record := hygieneJournalRecord{Kind: "intent", ID: fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()), Rule: action.Rule, Path: action.Path, Reason: action.Cause, Action: action.Action, Bytes: action.Bytes, Archive: archive, ArchiveSHA: archiveSHA, At: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := appendHygieneJournal(report.eventRoot, record); err != nil {
		return hygieneJournalRecord{}, fmt.Errorf("persist hygiene reclaim intent for %s: %w", action.Path, err)
	}
	return record, nil
}

func completeHygieneReclaim(root string, intent hygieneJournalRecord) error {
	if err := appendHygieneReclaimEvent(root, intent); err != nil {
		return fmt.Errorf("record hygiene reclaim event for %s: %w", intent.Path, err)
	}
	intent.Kind = "complete"
	intent.At = time.Now().UTC().Format(time.RFC3339Nano)
	return appendHygieneJournal(root, intent)
}

func appendHygieneJournal(root string, record hygieneJournalRecord) (returnErr error) {
	if root == "" {
		return errors.New("hygiene journal root is required")
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	events := filepath.Join(root, "logs", "events.log")
	if err := os.MkdirAll(filepath.Dir(events), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(events, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		return errors.Join(err, file.Close())
	}
	defer func() {
		returnErr = errors.Join(returnErr, syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
	}()
	if _, err := fmt.Fprintf(file, "HYGIENE_JOURNAL %s\n", encoded); err != nil {
		return err
	}
	return file.Sync()
}

func reconcileHygieneJournal(root string) error {
	journalPath := filepath.Join(root, "logs", "events.log")
	file, err := os.Open(journalPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read hygiene journal: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_SH); err != nil {
		return errors.Join(err, file.Close())
	}
	data, readErr := io.ReadAll(file)
	closeErr := errors.Join(syscall.Flock(int(file.Fd()), syscall.LOCK_UN), file.Close())
	if err := errors.Join(readErr, closeErr); err != nil {
		return fmt.Errorf("read hygiene journal: %w", err)
	}
	pending := map[string]hygieneJournalRecord{}
	for _, line := range strings.Split(string(data), "\n") {
		payload, ok := strings.CutPrefix(line, "HYGIENE_JOURNAL ")
		if !ok {
			continue
		}
		var record hygieneJournalRecord
		if err := json.Unmarshal([]byte(payload), &record); err != nil {
			return fmt.Errorf("decode hygiene journal record: %w", err)
		}
		switch record.Kind {
		case "intent":
			pending[record.ID] = record
		case "complete", "skip":
			delete(pending, record.ID)
		default:
			return fmt.Errorf("unknown hygiene journal record kind %q", record.Kind)
		}
	}
	for _, record := range pending {
		_, sourceErr := os.Lstat(record.Path)
		if sourceErr == nil {
			record.Kind = "skip"
			record.At = time.Now().UTC().Format(time.RFC3339Nano)
			if err := appendHygieneJournal(root, record); err != nil {
				return fmt.Errorf("record unreconciled hygiene intent for %s: %w", record.Path, err)
			}
			continue
		}
		if !errors.Is(sourceErr, os.ErrNotExist) {
			return fmt.Errorf("inspect source for hygiene intent %s: %w", record.ID, sourceErr)
		}
		if record.Archive != "" {
			hash, err := fileSHA256(record.Archive)
			if err != nil || hash != record.ArchiveSHA {
				return fmt.Errorf("cannot reconcile hygiene intent %s: archived source %s is missing or differs", record.ID, record.Archive)
			}
		}
		if err := completeHygieneReclaim(root, record); err != nil {
			return fmt.Errorf("complete recovered hygiene intent %s: %w", record.ID, err)
		}
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}
