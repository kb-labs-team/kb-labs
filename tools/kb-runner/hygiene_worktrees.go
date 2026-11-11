//go:build darwin || linux

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

type gitWorktree struct{ Path, Branch string }
type ownedWorktree struct {
	gitWorktree
	ResolvedPath string
}

var regenerableWorktreeComponents = []string{"node_modules", "dist", ".turbo", ".agent-tmp"}

func sweepWorktrees(options hygieneOptions, report *hygieneReport) error {
	root, err := filepath.EvalSymlinks(options.Root)
	if err != nil {
		return fmt.Errorf("resolve orchestration root %s: %w", options.Root, err)
	}
	integration, err := filepath.EvalSymlinks(options.Integration)
	if errors.Is(err, os.ErrNotExist) {
		return appendHygieneAction(report, hygieneAction{Rule: "worktree", Path: options.Integration, Action: "skipped", Cause: "configured integration worktree does not exist"})
	}
	if err != nil {
		return fmt.Errorf("resolve integration worktree %s: %w", options.Integration, err)
	}
	worktrees, err := listGitWorktrees(integration)
	if err != nil {
		return err
	}
	streams, err := newSchedulerStore(options.State).streams()
	if err != nil {
		return err
	}
	streamState := make(map[string]SchedulerStream, len(streams))
	for _, stream := range streams {
		streamState[stream.Stream] = stream
	}
	activeWorktrees, err := schedulerActiveWorktrees(options.State, streamState)
	if err != nil {
		return err
	}
	var candidates []ownedWorktree
	for _, worktree := range worktrees {
		path, err := filepath.EvalSymlinks(worktree.Path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("resolve registered worktree %s: %w", worktree.Path, err)
		}
		if path == integration {
			continue
		}
		if !strings.HasPrefix(worktree.Branch, "agent/") {
			continue
		}
		if !withinRoot(root, path) {
			action := hygieneAction{Rule: "worktree", Path: path, Action: "refused", Cause: "git worktree is outside the orchestration root"}
			if err := appendHygieneAction(report, action); err != nil {
				return err
			}
			continue
		}
		candidates = append(candidates, ownedWorktree{gitWorktree: worktree, ResolvedPath: path})
	}
	for _, candidate := range candidates {
		if options.Context != nil {
			if err := options.Context.Err(); err != nil {
				return err
			}
		}
		snapshot, err := readProcessSnapshot()
		if err != nil {
			return err
		}
		if err := sweepWorktreeCandidate(options, root, integration, candidate, streamState, activeWorktrees, snapshot, report); errors.Is(err, errWorktreeRuleUnsafe) {
			return nil
		} else if err != nil {
			reportHygieneAlert(report, "worktree", candidate.Path, err)
			continue
		}
	}
	return nil
}

var errWorktreeRuleUnsafe = errors.New("worktree liveness is unverified; skip this rule for the current round")

func reportSnapshotObservations(root string, snapshot livenessSnapshot, report *hygieneReport) error {
	if snapshot.UnreadableOther > 0 && !report.foreignUIDAlerted {
		if err := appendHygieneAction(report, hygieneAction{Rule: "worktree", Path: root, Action: "skipped", Cause: fmt.Sprintf("%d foreign-uid process cwd observations were unreadable; those processes cannot own runner worktrees", snapshot.UnreadableOther)}); err != nil {
			return err
		}
		report.foreignUIDAlerted = true
	}
	for _, process := range snapshot.UnreadableOwned {
		cause := process.cwdError
		if cause == "" {
			cause = process.observationError
		}
		if cause == "" {
			cause = "argv was not verified"
		}
		if err := appendHygieneAction(report, hygieneAction{Rule: "worktree", Path: root, Action: "alert", Cause: fmt.Sprintf("same-uid process pid=%d command=%q cwd=%q is unreadable (%s); candidate checks require a verified path or runner lease", process.pid, process.command, process.cwd, cause)}); err != nil {
			return err
		}
	}
	return nil
}

func sweepWorktreeCandidate(options hygieneOptions, root, integration string, candidate ownedWorktree, states map[string]SchedulerStream, active []string, snapshot livenessSnapshot, report *hygieneReport) (returnErr error) {
	path, branch := candidate.ResolvedPath, candidate.Branch
	streamName := strings.TrimPrefix(branch, "agent/")
	leasePath := worktreeLeasePath(root, path)
	lease, acquired, err := tryExclusiveWorktreeLease(leasePath)
	if err != nil {
		return err
	}
	if !acquired {
		return appendHygieneAction(report, hygieneAction{Rule: "worktree", Path: path, Action: "skipped", Cause: "owned worktree has an active runner lease"})
	}
	defer func() { returnErr = errors.Join(returnErr, lease.Close()) }()
	if err := reportSnapshotObservations(root, snapshot, report); err != nil {
		return err
	}
	processes := append(snapshot.Processes, snapshot.UnreadableOwned...)
	live, err := streamIsLive(streamName, path, states, active, processes)
	if err != nil {
		return err
	}
	if live {
		return nil
	}
	merged, err := worktreeMerged(integration, branch)
	if err != nil {
		return err
	}
	clean, err := worktreeClean(path)
	if err != nil {
		return err
	}
	if merged && clean {
		bytes, err := treeBytes(path)
		if err != nil {
			return err
		}
		if options.DryRun {
			report.Actions = append(report.Actions, hygieneAction{Rule: "worktree", Path: path, Action: "would-remove", Bytes: bytes, Cause: "merged, clean, not live"})
			return nil
		}
		preserved, err := archiveWorktreeReport(root, path, streamName)
		if err != nil {
			return err
		}
		archivePath := filepath.Join(root, "reports", "abandoned", streamName, "agent-report.md")
		archiveHash := ""
		if _, err := os.Stat(archivePath); err == nil {
			archiveHash, err = fileSHA256(archivePath)
			if err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if preserved >= bytes {
			bytes = 0
		} else {
			bytes -= preserved
		}
		action := hygieneAction{Rule: "worktree", Path: path, Action: "removed", Bytes: bytes, Cause: "merged, clean, not live"}
		intent, err := beginHygieneReclaim(report, action, archivePathIfPresent(archivePath, archiveHash), archiveHash)
		if err != nil {
			return err
		}
		if err := removeWorktree(integration, path); err != nil {
			return err
		}
		if err := completeHygieneReclaim(report.eventRoot, intent); err != nil {
			return err
		}
		recordHygieneReclaimResult(report, intent)
		return nil
	}
	stream, hasState := states[streamName]
	retired := hasState && (stream.State == SchedulerDone || stream.State == SchedulerFailed)
	old := !hasState && options.Now.Sub(worktreeCreatedAt(path)) > options.RetireAge
	if clean || !retired && !old {
		return nil
	}
	if options.DryRun {
		bytes, err := treeBytes(path)
		if err != nil {
			return err
		}
		report.Actions = append(report.Actions, hygieneAction{Rule: "worktree", Path: path, Action: "would-archive-and-remove", Bytes: bytes, Cause: "finished or abandoned stream"})
		return nil
	}
	_, err = archiveAndRemoveWorktree(report, integration, path, streamName)
	if err != nil {
		return err
	}
	return nil
}

func archivePathIfPresent(path, hash string) string {
	if hash == "" {
		return ""
	}
	return path
}

func listGitWorktrees(integration string) ([]gitWorktree, error) {
	output, err := exec.Command("git", "-C", integration, "worktree", "list", "--porcelain").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("list Git worktrees from integration tree: %w: %s", err, output)
	}
	var worktrees []gitWorktree
	for _, block := range strings.Split(strings.TrimSpace(string(output)), "\n\n") {
		var worktree gitWorktree
		for _, line := range strings.Split(block, "\n") {
			if path, ok := strings.CutPrefix(line, "worktree "); ok {
				worktree.Path = path
			}
			if branch, ok := strings.CutPrefix(line, "branch "); ok {
				worktree.Branch = strings.TrimPrefix(branch, "refs/heads/")
			}
		}
		if worktree.Path != "" {
			worktree.Path, err = filepath.Abs(worktree.Path)
			if err != nil {
				return nil, err
			}
			worktrees = append(worktrees, worktree)
		}
	}
	return worktrees, nil
}

type processInfo struct {
	pid              int
	uid              uint32
	identity         string
	command          string
	argv             string
	cwd              string
	cwdError         string
	unverified       bool
	observationError string
}

type livenessSnapshot struct {
	Processes       []processInfo
	UnreadableOwned []processInfo
	UnreadableOther int
}

func readProcessSnapshot() (livenessSnapshot, error) {
	entries, err := proc.ProcessInventory()
	if err != nil {
		return livenessSnapshot{}, fmt.Errorf("inspect processes for live worktrees: %w", err)
	}
	return processSnapshotFromEntries(entries, uint32(os.Getuid())), nil
}

func processSnapshotFromEntries(entries []proc.ProcessInventoryEntry, currentUID uint32) livenessSnapshot {
	snapshot := livenessSnapshot{Processes: []processInfo{}, UnreadableOwned: []processInfo{}}
	for _, entry := range entries {
		process := processInfo{
			pid: entry.PID, uid: entry.UID, identity: entry.Identity, command: entry.Command,
			argv: strings.Join(entry.Argv, "\x00"), cwd: entry.CWD, cwdError: entry.CwdError,
			unverified: entry.Unverified, observationError: entry.ObservationError,
		}
		if entry.UID != currentUID {
			if entry.CwdError != "" || entry.ObservationError != "" {
				snapshot.UnreadableOther++
			}
			continue
		}
		if entry.Unverified || entry.ObservationError != "" || entry.CwdError != "" {
			if process.command == "" {
				process.command = strings.Join(entry.Argv, " ")
			}
			snapshot.UnreadableOwned = append(snapshot.UnreadableOwned, process)
			continue
		}
		snapshot.Processes = append(snapshot.Processes, process)
	}
	return snapshot
}

func schedulerActiveWorktrees(state string, streams map[string]SchedulerStream) ([]string, error) {
	var active []string
	store := newSchedulerStore(state)
	tasks, err := store.tasks()
	if err != nil {
		return nil, err
	}
	for _, task := range tasks {
		stream, exists := streams[task.Stream]
		if exists && (stream.State == SchedulerReady || stream.State == SchedulerRunning) {
			active = append(active, task.Workdir)
		}
	}
	for _, runnerState := range ownedRunnerStates(filepath.Dir(filepath.Dir(state)), state) {
		jobs, err := newJobStore(runnerState).List()
		if err != nil {
			return nil, fmt.Errorf("read active runner jobs in %s: %w", runnerState, err)
		}
		for _, job := range jobs {
			if job.State == JobQueued || job.State == JobRunning || job.State == JobQuotaWait || job.State == JobPaused {
				for _, task := range tasks {
					if task.Stream == job.Stream {
						active = append(active, task.Workdir)
					}
				}
			}
		}
	}
	return active, nil
}

func streamIsLive(stream, path string, states map[string]SchedulerStream, activeWorktrees []string, processes []processInfo) (bool, error) {
	if state, exists := states[stream]; exists {
		if state.State == SchedulerReady || state.State == SchedulerRunning {
			return true, nil
		}
		if state.Advance != nil && state.Advance.State != AdvanceAccepted && state.Advance.State != AdvanceEscalated {
			return true, nil
		}
	}
	for _, active := range activeWorktrees {
		if active == path || withinRoot(path, active) {
			return true, nil
		}
	}
	for _, process := range processes {
		if process.unverified || process.observationError != "" {
			continue
		}
		if process.cwd == path || withinRoot(path, process.cwd) {
			return true, nil
		}
		for _, arg := range strings.Split(process.argv, "\x00") {
			candidate := arg
			// On Linux, unreadable same-UID cwd indicates a non-dumpable process; ordinary human shells remain observable. Dirty candidates are archived before removal, and clean candidates have already been merged into Git.
			if process.cwdError != "" && !filepath.IsAbs(candidate) {
				continue
			}
			if !filepath.IsAbs(candidate) {
				candidate = filepath.Join(process.cwd, candidate)
			}
			candidate, err := filepath.Abs(candidate)
			if err == nil && (candidate == path || withinRoot(path, candidate)) {
				return true, nil
			}
		}
	}
	return false, nil
}

func worktreeMerged(integration, branch string) (bool, error) {
	cmd := exec.Command("git", "-C", integration, "merge-base", "--is-ancestor", branch, "HEAD")
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("git merge-base: %w", err)
}

func worktreeClean(path string) (bool, error) {
	args := []string{"-C", path, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", "."}
	args = append(args, regenerablePathspecExclusions()...)
	cmd := exec.Command("git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("inspect Git worktree %s: %w: %s", path, err, output)
	}
	return len(bytes.TrimSpace(output)) == 0, nil
}

func regenerablePathspecExclusions() []string {
	exclusions := make([]string, 0, len(regenerableWorktreeComponents))
	for _, component := range regenerableWorktreeComponents {
		exclusions = append(exclusions, ":(exclude,glob)**/"+component+"/**")
	}
	return exclusions
}

func worktreeCreatedAt(path string) time.Time {
	info, err := os.Stat(filepath.Join(path, ".git"))
	if err != nil {
		return time.Now()
	}
	return info.ModTime()
}

func archiveAbandoned(root, path, stream string) (reclaimed uint64, returnErr error) {
	originalBytes, err := treeBytes(path)
	if err != nil {
		return 0, err
	}
	destination := filepath.Join(root, "reports", "abandoned", stream)
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return 0, err
	}
	if err := os.Mkdir(destination, 0o700); err != nil {
		return 0, fmt.Errorf("create abandoned archive directory %s: %w", destination, err)
	}
	archiveComplete := false
	defer func() {
		if !archiveComplete {
			returnErr = errors.Join(returnErr, os.RemoveAll(destination))
		}
	}()
	head, err := exec.Command("git", "-C", path, "rev-parse", "HEAD").Output()
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(destination, "head"), head, 0o600); err != nil {
		return 0, err
	}
	if err := copyAgentReport(path, destination); err != nil {
		return 0, err
	}
	diffArgs := []string{"-C", path, "diff", "HEAD", "--", "."}
	diffArgs = append(diffArgs, regenerablePathspecExclusions()...)
	diff, err := exec.Command("git", diffArgs...).Output()
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(destination, "tracked.diff"), diff, 0o600); err != nil {
		return 0, err
	}
	listArgs := []string{"-C", path, "status", "--porcelain", "--ignored", "--untracked-files=all", "-z"}
	listed, err := exec.Command("git", listArgs...).Output()
	if err != nil {
		return 0, err
	}
	var filtered []string
	for _, entry := range bytes.Split(listed, []byte{0}) {
		if len(entry) < 4 {
			continue
		}
		status, item := string(entry[:2]), string(entry[3:])
		if (status != "??" && status != "!!") || isRegenerableWorktreePath(item) {
			continue
		}
		filtered = append(filtered, item)
	}
	sort.Strings(filtered)
	listing := strings.Join(filtered, "\n")
	if listing != "" {
		listing += "\n"
	}
	if err := os.WriteFile(filepath.Join(destination, "untracked.list"), []byte(listing), 0o600); err != nil {
		return 0, err
	}
	archive := filepath.Join(destination, "untracked.tgz")
	if err := archiveGitPaths(path, archive, filtered); err != nil {
		return 0, err
	}
	if output, err := exec.Command("tar", "-tzf", archive).CombinedOutput(); err != nil {
		return 0, fmt.Errorf("verify abandoned archive: %w: %s", err, output)
	}
	archiveBytes, err := treeBytes(destination)
	if err != nil {
		return 0, err
	}
	if archiveBytes >= originalBytes {
		archiveComplete = true
		return 0, nil
	}
	archiveComplete = true
	return originalBytes - archiveBytes, nil
}

func archiveAndRemoveWorktree(report *hygieneReport, integration, path, stream string) (uint64, error) {
	root := report.eventRoot
	bytes, err := archiveAbandoned(root, path, stream)
	if err != nil {
		return 0, err
	}
	archive := filepath.Join(root, "reports", "abandoned", stream, "untracked.tgz")
	archiveHash, err := fileSHA256(archive)
	if err != nil {
		return 0, fmt.Errorf("hash abandoned archive before removal: %w", err)
	}
	action := hygieneAction{Rule: "worktree", Path: path, Action: "archived-and-removed", Bytes: bytes, Cause: "finished or abandoned stream"}
	intent, err := beginHygieneReclaim(report, action, archive, archiveHash)
	if err != nil {
		return 0, err
	}
	if err := removeWorktree(integration, path); err != nil {
		return 0, err
	}
	if err := completeHygieneReclaim(root, intent); err != nil {
		return 0, err
	}
	recordHygieneReclaimResult(report, intent)
	return bytes, nil
}

func isRegenerableWorktreePath(path string) bool {
	for _, component := range strings.Split(filepath.ToSlash(path), "/") {
		for _, regenerable := range regenerableWorktreeComponents {
			if component == regenerable {
				return true
			}
		}
	}
	return false
}

func copyAgentReport(worktree, destination string) error {
	source := filepath.Join(worktree, ".agent-report.md")
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("agent report %s is not a regular file", source)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("read agent report before worktree removal: %w", err)
	}
	if err := os.WriteFile(filepath.Join(destination, "agent-report.md"), data, info.Mode().Perm()); err != nil {
		return fmt.Errorf("preserve agent report before worktree removal: %w", err)
	}
	return nil
}

func archiveWorktreeReport(root, worktree, stream string) (uint64, error) {
	source := filepath.Join(worktree, ".agent-report.md")
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	destination := filepath.Join(root, "reports", "abandoned", stream)
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return 0, err
	}
	if err := os.Mkdir(destination, 0o700); err != nil {
		return 0, fmt.Errorf("create report archive for clean worktree: %w", err)
	}
	if err := copyAgentReport(worktree, destination); err != nil {
		return 0, errors.Join(err, os.RemoveAll(destination))
	}
	return uint64(info.Size()), nil
}

func archiveGitPaths(root, destination string, paths []string) error {
	file, err := os.Create(destination)
	if err != nil {
		return err
	}
	compressor := gzip.NewWriter(file)
	writer := tar.NewWriter(compressor)
	var archiveErr error
	for _, name := range paths {
		path := filepath.Join(root, filepath.FromSlash(name))
		info, err := os.Lstat(path)
		if err != nil {
			archiveErr = err
			break
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				archiveErr = err
				break
			}
		}
		if info.IsDir() {
			continue
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			archiveErr = err
			break
		}
		header.Name = filepath.ToSlash(name)
		if err := writer.WriteHeader(header); err != nil {
			archiveErr = err
			break
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		input, err := os.Open(path)
		if err != nil {
			archiveErr = err
			break
		}
		_, copyErr := io.Copy(writer, input)
		closeErr := input.Close()
		if archiveErr = errors.Join(copyErr, closeErr); archiveErr != nil {
			break
		}
	}
	closeErr := errors.Join(writer.Close(), compressor.Close(), file.Close())
	if archiveErr != nil {
		return errors.Join(archiveErr, os.Remove(destination))
	}
	if closeErr != nil {
		return errors.Join(closeErr, os.Remove(destination))
	}
	return nil
}

func removeWorktree(integration, path string) error {
	output, err := exec.Command("git", "-C", integration, "worktree", "remove", "--force", "--force", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("remove owned worktree %s: %w: %s", path, err, output)
	}
	output, err = exec.Command("git", "-C", integration, "worktree", "prune").CombinedOutput()
	if err != nil {
		return fmt.Errorf("prune removed worktree metadata: %w: %s", err, output)
	}
	return nil
}

func withinRoot(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

var _ = tar.TypeReg
