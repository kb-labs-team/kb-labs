//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/kb-runner/internal/proc"
)

type schedulerPolicy struct {
	IntegrationBranch string   `json:"integration_branch"`
	RiskZones         []string `json:"risk_zones"`
}

type proposedCommit struct {
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

var errGemReviewVendorLimit = errors.New("gem review vendor limit")
var errReviewUnusable = errors.New("review report unusable")

func (options schedulerRunOptions) policy(task SchedulerTask) (schedulerPolicy, error) {
	path := filepath.Join(task.RepoRoot, "tools", "kb-runner", "scheduler-policy.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return schedulerPolicy{}, fmt.Errorf("read scheduler policy %s: %w", path, err)
	}
	var policy schedulerPolicy
	if err := json.Unmarshal(data, &policy); err != nil {
		return schedulerPolicy{}, fmt.Errorf("decode scheduler policy %s: %w", path, err)
	}
	if policy.IntegrationBranch == "" || len(policy.RiskZones) == 0 {
		return schedulerPolicy{}, fmt.Errorf("scheduler policy %s requires integration_branch and risk_zones", path)
	}
	return policy, nil
}

func (options schedulerRunOptions) reviewPolicy(task SchedulerTask, stream SchedulerStream) (string, []string, error) {
	if task.Review == "cross" || stream.RejectRounds >= 1 {
		return "cross", normalizeSchedulerReviewers(task), nil
	}
	policy, err := options.policy(task)
	if err != nil {
		return "", nil, err
	}
	changed, err := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "diff", "--name-only", task.Base+"..."+stream.Submission.SHA)
	if err != nil {
		return "", nil, fmt.Errorf("read changed paths for review policy: %w", err)
	}
	for _, name := range strings.Split(changed, "\n") {
		if name == "" {
			continue
		}
		if containsSchedulerPath(policy.RiskZones, name) {
			return "cross", normalizeSchedulerReviewers(task), nil
		}
	}
	return "single", task.Reviewers[:1], nil
}

func normalizeSchedulerReviewers(task SchedulerTask) []string {
	reviewers := append([]string(nil), task.Reviewers...)
	if len(reviewers) < 2 {
		vendor := task.Vendor
		if len(reviewers) == 1 {
			vendor = reviewers[0]
		}
		reviewers = []string{vendor, vendor}
	}
	return reviewers
}

func containsSchedulerPath(zones []string, name string) bool {
	for _, zone := range zones {
		prefix := strings.TrimSuffix(zone, "**")
		if prefix != zone && strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func parseProposedCommits(report []byte) ([]proposedCommit, error) {
	text := string(report)
	start := strings.Index(text, "## Proposed commits\n```json\n")
	if start < 0 {
		return nil, errors.New("no-proposed-commits")
	}
	dataStart := start + len("## Proposed commits\n```json\n")
	end := strings.Index(text[dataStart:], "\n```")
	if end < 0 {
		return nil, errors.New("no-proposed-commits")
	}
	var commits []proposedCommit
	if err := json.Unmarshal([]byte(text[dataStart:dataStart+end]), &commits); err != nil {
		return nil, errors.New("no-proposed-commits")
	}
	if len(commits) != 3 {
		return nil, errors.New("no-proposed-commits")
	}
	for i, expected := range []string{"case", "tests", "code"} {
		if commits[i].Kind != expected || strings.TrimSpace(commits[i].Subject) == "" {
			return nil, errors.New("no-proposed-commits")
		}
	}
	return commits, nil
}

func (options schedulerRunOptions) landAccepted(task SchedulerTask, stream SchedulerStream) (bool, string, error) {
	if isAutoAdvanceTask(task) {
		return options.landAutoAccepted(task, stream)
	}
	gate := schedulerReviewGate(task, stream)
	if !gate.allowsLand() {
		return false, "", fmt.Errorf("land refused for %s: %s; every required reviewer must ACCEPT", task.Stream, gate.refusal())
	}
	if stream.Submission == nil || stream.Submission.TreeSHA == "" || stream.Submission.ExpectedRefSHA == "" {
		return false, "", fmt.Errorf("land refused for %s: the passing remote submission has no verified tree and expected branch commit; next: %s sched ps --state %q", task.Stream, options.root.InvocationCommand(), options.state)
	}
	verifiedTree, err := storedGitObjectID(stream.Submission.TreeSHA)
	if err != nil {
		return false, "", fmt.Errorf("remote submission has invalid verified tree ID: %w", err)
	}
	verifiedReport, err := readVerifiedWorkerReport(task, verifiedTree.String())
	if err != nil {
		return false, "", fmt.Errorf("read worker report from verified tree: %w", err)
	}
	status, _, err := readReportBytes(verifiedReport)
	if err != nil || status != "Status: DONE" {
		stream.Cause = "plan-question"
		if transitionErr := options.store.transition(stream, SchedulerAwaitingOrchestrator, "verified worker report", "inspect the worker report included in the verified tree"); transitionErr != nil {
			return false, "", errors.Join(err, transitionErr)
		}
		return false, "", nil
	}
	commits, err := parseProposedCommits(verifiedReport)
	if err != nil {
		stream.Cause = "no-proposed-commits"
		return false, "", options.store.transition(stream, SchedulerAwaitingOrchestrator, "land proposals", "add a parseable Proposed commits section, then resume")
	}
	nextCommand := fmt.Sprintf("%s land %s --state %q", options.root.InvocationCommand(), task.Stream, options.state)
	object, err := buildLandingObjects(options.store.stateIO, task.RepoRoot, task.Stream, verifiedTree.String(), stream.Submission.ExpectedRefSHA, commits, filepath.Join(options.state, "jobs", task.ID, "tmp"), nextCommand)
	if err != nil {
		return false, "", fmt.Errorf("build verified landing objects for %s: %w; next: %s land %s --state %q", task.Stream, err, options.root.InvocationCommand(), task.Stream, options.state)
	}
	matchesVerifiedContent, err := landingTreesEqualWithoutStreamReports(task.RepoRoot, object.TreeSHA.String(), verifiedTree.String())
	if err != nil {
		return false, "", err
	}
	if !matchesVerifiedContent {
		return false, "", fmt.Errorf("landing tree %s differs from verified tree %s after excluding report artifacts", object.TreeSHA, verifiedTree)
	}
	if err := moveLandingRef(options.store.stateIO, task.RepoRoot, task.Stream, object, stream.Submission.ExpectedRefSHA); err != nil {
		var conflict *landingRefConflict
		if errors.As(err, &conflict) {
			if resubmitErr := options.resubmitLandingRefConflict(task, stream, conflict); resubmitErr != nil {
				return false, "", errors.Join(conflict, resubmitErr)
			}
			return false, "", nil
		}
		return false, "", err
	}
	if err := refreshLandingWorktree(options.store.stateIO, task.RepoRoot, task.Workdir, object.CommitSHA.String()); err != nil {
		return false, "", err
	}
	policy, err := options.policy(task)
	if err != nil {
		return false, "", err
	}
	integration := filepath.Join(task.WorktreeRoot, strings.TrimPrefix(policy.IntegrationBranch, "agent/"))
	if _, err := os.Stat(integration); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(integration), 0o700); err != nil {
			return false, "", err
		}
		if _, err := schedulerCommandOutput("", "git", "-C", task.RepoRoot, "worktree", "add", "-B", policy.IntegrationBranch, integration, task.Base); err != nil {
			return false, "", fmt.Errorf("create integration worktree: %w", err)
		}
	}
	ref := "refs/heads/" + policy.IntegrationBranch
	integrationSHA, err := readGitObjectIDCommand(integration, "-C", integration, "rev-parse", ref)
	if err != nil {
		return false, "", fmt.Errorf("resolve integration branch at landing start: %w", err)
	}
	mergeTreeOutput, mergeErr := schedulerCommandOutput(integration, "git", "-C", integration, "merge-tree", "--write-tree", integrationSHA.String(), object.CommitSHA.String())
	if mergeErr != nil {
		// Keep the existing conflict resolver flow for conflicted trees. The branch
		// remains at integrationSHA because merge-tree did not move any ref.
		_, mergeErr = schedulerCommandOutput(integration, "git", "-C", integration, "merge", "--no-ff", "--no-edit", object.CommitSHA.String())
		if mergeErr == nil {
			return false, "", errors.New("merge-tree reported a conflict but the integration worktree merge completed")
		}
		integrationConflicts, diffErr := schedulerCommandOutput(integration, "git", "-C", integration, "diff", "--name-only", "--diff-filter=U")
		if diffErr != nil {
			return false, "", errors.Join(mergeErr, fmt.Errorf("inspect integration merge conflicts: %w", diffErr))
		}
		if strings.TrimSpace(integrationConflicts) == "" {
			return false, "", mergeErr
		}
		if _, err := schedulerCommandOutput(integration, "git", "-C", integration, "merge", "--abort"); err != nil {
			return false, "", errors.Join(mergeErr, fmt.Errorf("abort integration merge: %w", err))
		}
		if _, err := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "merge", policy.IntegrationBranch); err != nil {
			return false, "", errors.Join(mergeErr, fmt.Errorf("merge integration branch into stream worktree: %w", err))
		}
		unmerged, diffErr := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "diff", "--name-only", "--diff-filter=U")
		if diffErr != nil || strings.TrimSpace(unmerged) == "" {
			return false, "", fmt.Errorf("integration merge conflicted but stream worktree has no unresolved files: %w", mergeErr)
		}
		return false, "", options.queueMergeResolver(task, stream)
	}
	mergeTreeSHA, err := readGitObjectID(strings.SplitN(mergeTreeOutput, "\n", 2)[0])
	if err != nil {
		return false, "", fmt.Errorf("merge-tree returned invalid tree SHA: %w", err)
	}
	mergeSHA, err := createCommitObject(options.store.stateIO, integration, mergeTreeSHA, []gitObjectID{integrationSHA, object.CommitSHA}, "Merge "+object.CommitSHA.String()+" into "+policy.IntegrationBranch)
	if err != nil {
		return false, "", fmt.Errorf("create immutable integration merge commit: %w", err)
	}
	mergeInputTree, err := treeSHAForCommit(task.RepoRoot, object.CommitSHA.String())
	if err != nil {
		return false, "", fmt.Errorf("verify immutable integration merge input: %w", err)
	}
	if mergeInputTree != object.TreeSHA {
		return false, "", fmt.Errorf("integration merge input tree %s differs from sanitized landing tree %s", mergeInputTree, object.TreeSHA)
	}
	mergeCommitTree, err := treeSHAForCommit(task.RepoRoot, mergeSHA.String())
	if err != nil {
		return false, "", fmt.Errorf("verify created integration merge commit: %w", err)
	}
	if mergeCommitTree != mergeTreeSHA {
		return false, "", fmt.Errorf("integration merge commit tree %s differs from merge result %s", mergeCommitTree, mergeTreeSHA)
	}
	if _, err := options.store.stateIO.GitMutation(integration, nil, "update-ref", ref, mergeSHA.String(), integrationSHA.String()); err != nil {
		stream.Cause = "integration-branch-advanced"
		conflict := &integrationRefConflict{Ref: ref, Expected: integrationSHA.String()}
		if transitionErr := options.store.transition(stream, SchedulerReady, "integration branch advanced during landing", "rerun the accepted land against the current integration branch"); transitionErr != nil {
			return false, "", errors.Join(conflict, transitionErr)
		}
		return false, "", conflict
	}
	if _, err := schedulerCommandOutput(integration, "git", "-C", integration, "reset", "--mixed", mergeSHA.String()); err != nil {
		return false, "", fmt.Errorf("refresh integration worktree after compare-and-swap: %w", err)
	}
	if err := options.store.recordIntegrationMerge(SchedulerMergeRecord{CommitSHA: mergeSHA.String(), ParentSHA: integrationSHA.String(), Stream: task.Stream}); err != nil {
		return false, "", fmt.Errorf("record integration merge: %w", err)
	}
	if err := options.submitCandidate(task, stream, mergeSHA.String()); err != nil {
		return false, "", err
	}
	return true, mergeSHA.String(), nil
}

func (options schedulerRunOptions) landAutoAccepted(task SchedulerTask, stream SchedulerStream) (bool, string, error) {
	accepted, reviewErr := persistedAutoReviewsAccepted(task, stream)
	if reviewErr != nil {
		return false, "", reviewErr
	}
	if !accepted {
		return false, "", fmt.Errorf("land refused for %s: all required persisted reviews must accept before landing", task.Stream)
	}
	state, err := resolveRunnerState(options.root, "land", options.state)
	if err != nil {
		return false, "", err
	}
	if err := refuseRunnerStateInTree(task.RepoRoot, state, stream.Advance.TreeHash); err != nil {
		return false, "", err
	}
	ref := "refs/heads/agent/" + task.Stream
	oldSHA, err := readGitObjectIDCommand(task.RepoRoot, "-C", task.RepoRoot, "rev-parse", "--verify", ref)
	if err != nil {
		return false, "", fmt.Errorf("resolve accepted stream ref %s: %w", ref, err)
	}
	actualTree, err := treeSHAForCommit(task.RepoRoot, oldSHA.String())
	if err != nil {
		return false, "", err
	}
	actualMatchesAcceptedContent, err := landingTreesEqualWithoutStreamReports(task.RepoRoot, actualTree.String(), stream.Advance.TreeHash)
	if err != nil {
		return false, "", err
	}
	if !actualMatchesAcceptedContent {
		return false, "", fmt.Errorf("accepted tree %s differs from current stream tree %s", stream.Advance.TreeHash, actualTree)
	}
	if stream.Advance.LandingCommit != "" {
		landingCommit, parseErr := storedGitObjectID(stream.Advance.LandingCommit)
		if parseErr != nil {
			return false, "", fmt.Errorf("persisted landing commit has invalid SHA %q: %w", stream.Advance.LandingCommit, parseErr)
		}
		if oldSHA != landingCommit {
			landedTree, treeErr := treeSHAForCommit(task.RepoRoot, landingCommit.String())
			if treeErr != nil {
				return false, "", treeErr
			}
			landedMatchesAcceptedContent, compareErr := landingTreesEqualWithoutStreamReports(task.RepoRoot, landedTree.String(), stream.Advance.TreeHash)
			if compareErr != nil {
				return false, "", compareErr
			}
			if !landedMatchesAcceptedContent {
				return false, "", fmt.Errorf("persisted landing commit tree %s differs from accepted tree %s", landedTree, stream.Advance.TreeHash)
			}
			if err := moveLandingRef(options.store.stateIO, task.RepoRoot, task.Stream, landingObject{CommitSHA: landingCommit, TreeSHA: landedTree}, oldSHA.String()); err != nil {
				return false, "", err
			}
		}
		if err := refreshLandingWorktree(options.store.stateIO, task.RepoRoot, task.Workdir, landingCommit.String()); err != nil {
			return false, "", err
		}
		return true, landingCommit.String(), nil
	}
	baseSHA, err := readGitObjectIDCommand(task.RepoRoot, "-C", task.RepoRoot, "rev-parse", "--verify", task.Base)
	if err != nil {
		return false, "", fmt.Errorf("resolve commit-only landing base %s: %w", task.Base, err)
	}
	baseTree, err := treeSHAForCommit(task.RepoRoot, baseSHA.String())
	if err != nil {
		return false, "", err
	}
	// Only an identical accepted tree means landing is already complete here.
	// A report-only difference is still a pending commit-only landing: its report
	// supplies the case/tests/code proposals even though report artifacts are
	// excluded from the three landing commits.
	if baseTree.String() == stream.Advance.TreeHash {
		if err := refreshLandingWorktree(options.store.stateIO, task.RepoRoot, task.Workdir, oldSHA.String()); err != nil {
			return false, "", err
		}
		return true, oldSHA.String(), nil
	}
	report, err := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "show", oldSHA.String()+":.agent-report.md")
	if err != nil {
		return false, "", fmt.Errorf("read worker report from accepted tree %s: %w", stream.Advance.TreeHash, err)
	}
	if err := validateAdvanceReport([]byte(report)); err != nil {
		return false, "", err
	}
	commits, err := parseProposedCommits([]byte(report))
	if err != nil {
		return false, "", fmt.Errorf("accepted worker report has no case, tests, code commit proposals: %w", err)
	}
	nextCommand := fmt.Sprintf("%s land %s --state %q", options.root.InvocationCommand(), task.Stream, options.state)
	object, err := buildLandingObjects(options.store.stateIO, task.RepoRoot, task.Stream, stream.Advance.TreeHash, baseSHA.String(), commits, filepath.Join(options.state, "jobs", task.ID, "tmp"), nextCommand)
	if err != nil {
		return false, "", fmt.Errorf("build accepted commit-only landing objects for %s: %w", task.Stream, err)
	}
	matchesAcceptedContent, err := landingTreesEqualWithoutStreamReports(task.RepoRoot, object.TreeSHA.String(), stream.Advance.TreeHash)
	if err != nil {
		return false, "", err
	}
	if !matchesAcceptedContent {
		return false, "", fmt.Errorf("commit-only landing tree %s differs from accepted tree %s after excluding report artifacts", object.TreeSHA, stream.Advance.TreeHash)
	}
	current, err := options.store.stream(task.Stream)
	if err != nil {
		return false, "", err
	}
	if current.Advance == nil || (current.Advance.State != AdvanceReviewing && current.Advance.State != AdvanceAccepted) || current.Advance.LastVerdict != "ACCEPT" {
		return false, "", fmt.Errorf("review acceptance changed while preparing landing for %s", task.Stream)
	}
	current.Advance.LandingCommit = object.CommitSHA.String()
	current.Advance.LandingExpectedRef = oldSHA.String()
	if err := options.store.commitAutoTransition([]SchedulerStream{current}); err != nil {
		return false, "", fmt.Errorf("persist accepted landing commit before ref update: %w", err)
	}
	if err := moveLandingRef(options.store.stateIO, task.RepoRoot, task.Stream, object, oldSHA.String()); err != nil {
		return false, "", err
	}
	if err := refreshLandingWorktree(options.store.stateIO, task.RepoRoot, task.Workdir, object.CommitSHA.String()); err != nil {
		return false, "", err
	}
	return true, object.CommitSHA.String(), nil
}

func persistedAutoReviewsAccepted(task SchedulerTask, stream SchedulerStream) (bool, error) {
	if stream.Advance == nil || (stream.Advance.State != AdvanceReviewing && stream.Advance.State != AdvanceAccepted) || stream.Advance.LastVerdict != "ACCEPT" {
		return false, nil
	}
	if stream.ReviewResults == nil {
		return false, nil
	}
	primary := ReviewStandard
	if stream.Advance.Round > 0 {
		primary = ReviewDelta
	}
	if stream.ReviewResults[string(primary)] != "ACCEPT" {
		return false, nil
	}
	if !stream.Advance.HighRisk {
		return true, nil
	}
	if stream.Advance.Round == 0 {
		adversarialPrompt := filepath.Join(task.RepoRoot, "prompts", task.Stream+"-review-adv.md")
		if _, err := os.Stat(adversarialPrompt); err == nil {
			if stream.ReviewResults[string(ReviewAdversarial)] != "ACCEPT" {
				return false, nil
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return false, fmt.Errorf("inspect required adversarial review prompt %s: %w", adversarialPrompt, err)
		}
	}
	return stream.ReviewResults[string(ReviewFinal)] == "ACCEPT", nil
}

func refuseRunnerStateInTree(repoRoot, statePath, tree string) error {
	root, err := filepath.Abs(repoRoot)
	if err != nil {
		return err
	}
	state, err := filepath.Abs(statePath)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(root, state)
	if err != nil {
		return fmt.Errorf("resolve runner state against landing tree: %w", err)
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return fmt.Errorf("land refused: runner state %s is inside repository %s", state, root)
	}
	entries, err := schedulerCommandOutput(repoRoot, "git", "-C", repoRoot, "ls-tree", "-r", "--name-only", tree)
	if err != nil {
		return fmt.Errorf("inspect accepted tree for runner state: %w", err)
	}
	for _, entry := range strings.Split(entries, "\n") {
		if entry == relative || strings.HasPrefix(entry, relative+"/") {
			return fmt.Errorf("land refused: accepted tree contains runner state path %s", entry)
		}
	}
	return nil
}

func (options schedulerRunOptions) resubmitLandingRefConflict(task SchedulerTask, stream SchedulerStream, conflict *landingRefConflict) error {
	current, err := storedGitObjectID(conflict.Current)
	if err != nil {
		return fmt.Errorf("landing ref conflict returned invalid current commit %q: %w", conflict.Current, err)
	}
	tree, err := treeSHAForCommit(task.RepoRoot, current.String())
	if err != nil {
		return fmt.Errorf("resolve amended landing ref tree: %w", err)
	}
	ref, err := pushVerificationCommit(task.RepoRoot, verificationPush{kind: verificationPushWorker, stream: task.Stream, sha: conflict.Current})
	if err != nil {
		return fmt.Errorf("submit amended immutable commit for fresh verification: %w", err)
	}
	stream.Submission = &SchedulerSubmission{SHA: conflict.Current, TreeSHA: tree.String(), ExpectedRefSHA: conflict.Current, Ref: ref, DeadlineAt: time.Now().UTC().Add(schedulerRemoteLimit)}
	stream.ReviewGeneration++
	stream.ReviewResults = nil
	stream.ReviewRunIDs = nil
	stream.Cause = "tree-changed-after-verify"
	return options.store.transition(stream, SchedulerAwaitingRemote, "landing ref compare-and-swap refused: "+conflict.Error(), "wait for fresh remote verification and review")
}

func (options schedulerRunOptions) submitCandidate(task SchedulerTask, stream SchedulerStream, sha string) error {
	objectID, err := storedGitObjectID(sha)
	if err != nil {
		return fmt.Errorf("integration candidate returned invalid immutable merge SHA %q: %w", sha, err)
	}
	treeSHA, err := treeSHAForCommit(task.RepoRoot, objectID.String())
	if err != nil {
		return err
	}
	ref, err := pushVerificationCommit(task.RepoRoot, verificationPush{kind: verificationPushCandidate, stream: task.Stream, sha: objectID.String()})
	if err != nil {
		return fmt.Errorf("push integration candidate: %w", err)
	}
	stream.Submission = &SchedulerSubmission{SHA: objectID.String(), TreeSHA: treeSHA.String(), Ref: ref, Purpose: "candidate", DeadlineAt: time.Now().UTC().Add(schedulerRemoteLimit)}
	stream.Cause = ""
	return options.store.transition(stream, SchedulerAwaitingRemote, "candidate verification "+ref, "wait for the shared remote watcher")
}

func (options schedulerRunOptions) queueMergeResolver(task SchedulerTask, stream SchedulerStream) error {
	stream.Cause = "integration merge conflict"
	stream.WaitingFor = "merge resolver"
	stream.NextStep = "run the READY merge task"
	if err := options.store.writeStreamObserved(stream); err != nil {
		return err
	}
	mergeTask := SchedulerTask{ID: task.Stream + "-merge", Stream: task.Stream + "-merge", PromptTemplate: runnerMergeTemplate, Workdir: task.Workdir, WorktreeRoot: task.WorktreeRoot, RepoRoot: task.RepoRoot, Base: task.Base, Priority: task.Priority, DependsOn: []string{task.ID}, Vendor: task.Vendor, Effort: task.Effort, Role: schedulerMergeRole}
	runID, err := proc.AllocateRunID()
	if err != nil {
		return fmt.Errorf("allocate merge resolver run identity: %w", err)
	}
	if _, err := options.store.addWithSnapshotsAndRunID(mergeTask, runID, nil); err != nil {
		return fmt.Errorf("queue merge resolver: %w", err)
	}
	return nil
}

type schedulerWorkerResult struct {
	task   SchedulerTask
	jobID  string
	err    error
	output string
}

type schedulerRunOptions struct {
	store *schedulerStore
	schedulerRunOptionsConfig
}

type schedulerRunOptionsConfig struct {
	root        runnerRoot
	state       string
	lifecycle   context.Context
	slots       int
	selected    map[string]bool
	clock       schedulerClock
	maintenance *hygieneSupervisor
	supervisor  schedulerJobSupervisor
}

func newSchedulerRunOptions(store *schedulerStore, config schedulerRunOptionsConfig) schedulerRunOptions {
	return schedulerRunOptions{store: store, schedulerRunOptionsConfig: config}
}

const schedulerAdmissionWaitBound = 10 * time.Minute

type schedulerAdmissionTimeoutError struct {
	RunID      string
	WaitReason string
	Bound      time.Duration
	Next       string
}

func (err schedulerAdmissionTimeoutError) Error() string {
	return fmt.Sprintf("process admission for run %s did not clear within %s (last reason: %s); next: %s", err.RunID, err.Bound, err.WaitReason, err.Next)
}

type schedulerStartResult struct {
	run schedulerJobRun
	err error
}

type schedulerAdmissionBoundRun struct {
	schedulerJobRun
	cancel context.CancelFunc
}

func (run schedulerAdmissionBoundRun) Wait() error {
	defer run.cancel()
	return run.schedulerJobRun.Wait()
}

func (options schedulerRunOptions) startSupervisedJob(parent context.Context, streamName string, config proc.Config, waitBound time.Duration) (schedulerJobRun, error) {
	if config.RunID == "" {
		return nil, errors.New("scheduler process admission requires its journaled run ID")
	}
	if waitBound <= 0 {
		return nil, errors.New("scheduler process admission requires a positive wait bound")
	}
	stream, err := options.store.stream(streamName)
	if err != nil {
		return nil, fmt.Errorf("read stream before process admission: %w", err)
	}
	startCtx, cancel := context.WithTimeout(parent, waitBound)
	started := make(chan schedulerStartResult, 1)
	go func() {
		run, startErr := options.jobSupervisor().Start(startCtx, config)
		started <- schedulerStartResult{run: run, err: startErr}
	}()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	lastReason := "admission record not yet available"
	projected := false
	for {
		select {
		case result := <-started:
			if result.err != nil && errors.Is(startCtx.Err(), context.DeadlineExceeded) && parent.Err() == nil {
				cancel()
				next := options.root.InvocationCommand() + " sched ps --state " + shellQuote(options.state) + " --json"
				return nil, schedulerAdmissionTimeoutError{RunID: config.RunID, WaitReason: lastReason, Bound: waitBound, Next: next}
			}
			if projected {
				if err := options.store.setAdmissionProjection(streamName, config.RunID, stream.WaitingFor, stream.NextStep); err != nil {
					cancel()
					return nil, errors.Join(result.err, fmt.Errorf("clear process admission projection: %w", err))
				}
			}
			if result.err != nil {
				cancel()
				return nil, result.err
			}
			return schedulerAdmissionBoundRun{schedulerJobRun: result.run, cancel: cancel}, nil
		case <-ticker.C:
			record, exists, readErr := options.jobSupervisor().RunByID(config.StateDir, config.RunID)
			if readErr != nil {
				cancel()
				result := <-started
				return nil, errors.Join(result.err, fmt.Errorf("inspect process admission for run %s: %w", config.RunID, readErr))
			}
			if !exists || (record.Status != proc.StatusQueued && record.Status != proc.StatusBlocked) {
				continue
			}
			lastReason = record.WaitReason
			if lastReason == "" {
				lastReason = string(record.Status)
			}
			if err := options.store.setAdmissionProjection(streamName, config.RunID, "admission "+lastReason, "wait for process admission"); err != nil {
				cancel()
				result := <-started
				return nil, errors.Join(result.err, fmt.Errorf("project process admission for run %s: %w", config.RunID, err))
			}
			projected = true
		case <-startCtx.Done():
			cancel()
			result := <-started
			if parent.Err() != nil {
				if projected {
					if err := options.store.setAdmissionProjection(streamName, config.RunID, stream.WaitingFor, stream.NextStep); err != nil {
						return nil, errors.Join(result.err, parent.Err(), err)
					}
				}
				return nil, parent.Err()
			}
			next := options.root.InvocationCommand() + " sched ps --state " + shellQuote(options.state) + " --json"
			return nil, schedulerAdmissionTimeoutError{RunID: config.RunID, WaitReason: lastReason, Bound: waitBound, Next: next}
		}
	}
}

type schedulerRunUnknownError struct {
	RunID string
	Cause error
}

func (err schedulerRunUnknownError) Error() string {
	return fmt.Sprintf("scheduler run %s state is unknown: %v", err.RunID, err.Cause)
}

func (err schedulerRunUnknownError) Unwrap() error { return err.Cause }

func (options schedulerRunOptions) jobSupervisor() schedulerJobSupervisor {
	if options.supervisor != nil {
		return options.supervisor
	}
	return options.root.jobSupervisor()
}

func (root runnerRoot) jobSupervisor() schedulerJobSupervisor {
	if root.supervisor != nil {
		return root.supervisor
	}
	return clikitSchedulerSupervisor{}
}

type hygieneSupervisor struct {
	mu sync.Mutex
	wg sync.WaitGroup
}

func (supervisor *hygieneSupervisor) Start(work func()) {
	supervisor.mu.Lock()
	supervisor.wg.Add(1)
	supervisor.mu.Unlock()
	go func() {
		defer supervisor.wg.Done()
		work()
	}()
}

func (supervisor *hygieneSupervisor) Wait() {
	supervisor.wg.Wait()
}

type schedulerTicker interface {
	C() <-chan time.Time
	Stop()
}

type schedulerClock interface {
	Now() time.Time
	NewTicker(time.Duration) schedulerTicker
}

type wallSchedulerClock struct{}
type wallSchedulerTicker struct{ ticker *time.Ticker }

func (wallSchedulerClock) Now() time.Time { return time.Now() }
func (wallSchedulerClock) NewTicker(d time.Duration) schedulerTicker {
	return wallSchedulerTicker{time.NewTicker(d)}
}
func (ticker wallSchedulerTicker) C() <-chan time.Time { return ticker.ticker.C }
func (ticker wallSchedulerTicker) Stop()               { ticker.ticker.Stop() }

func runScheduler(ctx context.Context, root runnerRoot, state string, slots int, once bool) (code int, runErr error) {
	return runSchedulerUsingStore(ctx, root, state, slots, once, filesystemRunnerStateStore{})
}

func runSchedulerUsingStore(ctx context.Context, root runnerRoot, state string, slots int, once bool, stateIO runnerStateStore) (code int, runErr error) {
	return runSchedulerUsingDependencies(ctx, root, state, slots, once, stateIO, clikitSchedulerSupervisor{})
}

func runSchedulerUsingDependencies(ctx context.Context, root runnerRoot, state string, slots int, once bool, stateIO runnerStateStore, supervisor schedulerJobSupervisor) (code int, runErr error) {
	ctx, cancelLifecycle := schedulerLifecycleContext(ctx)
	defer cancelLifecycle()

	resolvedState, err := resolveRunnerState(root, "sched run", state)
	if err != nil {
		return 2, fmt.Errorf("kb-runner scheduler state is invalid: %w; next: %s sched run --help", err, root.InvocationCommand())
	}
	state = resolvedState
	store := newSchedulerStoreWithStateIO(state, stateIO)
	lease, err := store.acquireRunLease()
	if err != nil {
		if errors.Is(err, errSchedulerAlreadyRunning) {
			return 2, schedulerAlreadyRunningDiagnostic(root, state)
		}
		return 1, fmt.Errorf("acquire scheduler run lease: %w; next: %s sched ps --state %q", err, root.InvocationCommand(), state)
	}
	defer func() {
		runErr = errors.Join(runErr, releaseRunLease(lease))
	}()
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: root, state: state, lifecycle: ctx, supervisor: supervisor, slots: slots})
	return options.run(ctx, once)
}

func schedulerLifecycleContext(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
}

func schedulerAlreadyRunningDiagnostic(root runnerRoot, state string) error {
	command := root.InvocationCommand() + " sched run --state " + shellQuote(state)
	diagnostic, err := diag.FromCatalog("KB_RUNNER_SCHEDULER_ALREADY_RUNNING", map[string]string{"nextCommand": command}, diag.WithBinary(root.InvocationCommand()))
	if err != nil {
		return fmt.Errorf("scheduler lease diagnostic is missing from the platform catalog: %w", err)
	}
	return diagnostic
}

func (options schedulerRunOptions) run(ctx context.Context, once bool) (int, error) {
	if err := options.store.replayAutoTransitions(); err != nil {
		return 1, fmt.Errorf("replay auto-advance transactions: %w", err)
	}
	if err := options.store.replayHandoff(); err != nil {
		return 1, err
	}
	if err := options.recoverAutoStreams(); err != nil {
		return 1, fmt.Errorf("recover persisted auto-advance streams: %w", err)
	}
	maintenanceCtx, cancelMaintenance := context.WithCancel(ctx)
	supervisor := &hygieneSupervisor{}
	options.maintenance = supervisor
	defer func() { cancelMaintenance(); supervisor.Wait() }()
	options.startHygieneSweep(maintenanceCtx, false)
	clock := options.clock
	if clock == nil {
		clock = wallSchedulerClock{}
	}
	lastHygiene := clock.Now()
	diskWasLow := false
	results := make(chan schedulerWorkerResult, options.slots)
	active := 0
	visited := map[string]bool{}
	watchDone := false
	ticker := clock.NewTicker(schedulerRemoteWait)
	defer ticker.Stop()
	for {
		started, err := options.dispatch(ctx, results, options.slots-active, visited)
		if err != nil {
			return 1, err
		}
		active += started
		if once && active == 0 && watchDone {
			return 0, nil
		}
		if once && active == 0 && !watchDone {
			if err := options.watchRemote(ctx); err != nil {
				return 1, err
			}
			watchDone = true
			continue
		}
		if !once && active == 0 && !watchDone {
			if err := options.watchRemote(ctx); err != nil {
				return 1, err
			}
			watchDone = true
			continue
		}
		select {
		case <-ctx.Done():
			drainSchedulerWorkerResults(results, active)
			return 1, ctx.Err()
		case result := <-results:
			active--
			if err := options.finishWorker(result); err != nil {
				return 1, err
			}
			if once {
				visited[result.task.ID] = true
			}
		case <-ticker.C():
			if err := options.watchRemote(ctx); err != nil {
				return 1, err
			}
			low, err := options.orchestrationDiskLow()
			if err != nil {
				return 1, err
			}
			if low && !diskWasLow || clock.Now().Sub(lastHygiene) >= time.Hour {
				options.startHygieneSweep(maintenanceCtx, false)
				lastHygiene = clock.Now()
			}
			if low && !diskWasLow {
				if err := options.emitAutoStreamCondition("disk", "orchestration filesystem is below the configured free-space floor"); err != nil {
					return 1, err
				}
			}
			diskWasLow = low
			watchDone = true
		}
		if once && watchDone && active == 0 {
			// A pass may have queued a review task. The next dispatch loop starts it,
			// while the visited set prevents a rejected worker from looping here.
			if tasks, err := options.readyTasks(visited); err == nil && len(tasks) == 0 {
				return 0, nil
			} else if err != nil {
				return 1, err
			}
		}
	}
}

func drainSchedulerWorkerResults(results <-chan schedulerWorkerResult, active int) {
	for range active {
		<-results
	}
}

func (options schedulerRunOptions) dispatch(ctx context.Context, results chan<- schedulerWorkerResult, capacity int, visited map[string]bool) (int, error) {
	if capacity <= 0 {
		return 0, nil
	}
	tasks, err := options.readyTasks(visited)
	if err != nil {
		return 0, err
	}
	started := 0
	for _, task := range tasks {
		if len(options.selected) > 0 && !options.selected[task.ID] {
			continue
		}
		if started >= capacity {
			break
		}
		stream, err := options.store.stream(task.Stream)
		if err != nil {
			return started, err
		}
		if err := options.ensureWorktree(task); err != nil {
			stream.Cause = err.Error()
			transitionErr := options.store.transition(stream, SchedulerFailed, "worktree setup", "inspect the task's worktree and base branch")
			return started, errors.Join(fmt.Errorf("scheduler worktree for %s: %w", task.Stream, err), transitionErr)
		}
		if stream.ThreadID != "" && task.Role == schedulerWorkerRole {
			if _, _, err := snapshotWorktree(options.store.stateIO, task.Workdir, task.Stream); err != nil {
				return started, fmt.Errorf("snapshot before resuming %s: %w", task.Stream, err)
			}
		}
		if task.Role == schedulerWorkerRole && isAutoAdvanceTask(task) {
			if err := options.store.writeAtomic(workerReportPath(task), []byte("Status: RUNNING\n")); err != nil {
				return started, fmt.Errorf("reset worker result before dispatch: %w", err)
			}
		}
		jobID, err := schedulerJobID(task.Stream)
		if err != nil {
			return started, err
		}
		replacementRunID := ""
		if stream.State == SchedulerReady && stream.RunID != "" {
			runRecord, exists, recordErr := options.jobSupervisor().RunByID(options.state, stream.RunID)
			if recordErr != nil {
				if handled, escalationErr := options.escalateUnknownRunRecord(task.Stream, recordErr); handled {
					if escalationErr != nil {
						return started, escalationErr
					}
					continue
				}
				return started, fmt.Errorf("inspect READY task run %s before dispatch: %w", stream.RunID, recordErr)
			}
			if exists && runRecord.Status.Terminal() {
				replacementRunID, err = proc.AllocateRunID()
				if err != nil {
					return started, fmt.Errorf("allocate replacement run identity for READY task %s: %w", task.ID, err)
				}
			}
		}
		stream, claimed, err := options.store.claimForDispatch(task.Stream, task.ID, jobID, replacementRunID)
		if err != nil {
			return started, err
		}
		if !claimed {
			continue
		}
		jobID = stream.JobID
		if task.Role == schedulerReviewRole || task.Role == schedulerMergeRole {
			parentStream := stream
			if len(task.DependsOn) == 1 {
				parentTask, parentErr := options.store.task(task.DependsOn[0])
				if parentErr != nil {
					return started, fmt.Errorf("resolve parent task for prompt %s: %w", task.ID, parentErr)
				}
				parentStream, parentErr = options.store.stream(parentTask.Stream)
				if parentErr != nil {
					return started, fmt.Errorf("resolve parent stream for prompt %s: %w", task.ID, parentErr)
				}
			}
			if _, err := options.persistReviewPrompt(task, stream, parentStream); err != nil {
				stream.Cause = err.Error()
				transitionErr := options.store.transition(stream, SchedulerFailed, "review prompt", "inspect the persisted template path")
				return started, errors.Join(err, transitionErr)
			}
		}
		if task.Role == schedulerWorkerRole && isAutoAdvanceTask(task) {
			current, err := options.store.stream(task.Stream)
			if err != nil {
				return started, err
			}
			if current.Advance == nil || current.Advance.State == AdvanceRework {
				if err := options.store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
					return started, err
				}
			}
		}
		started++
		go func(task SchedulerTask, jobID, runID, threadID string) {
			var output []byte
			var err error
			if task.Role == schedulerReviewRole && task.Vendor == "gem" {
				output, err = options.runGemReview(ctx, task, runID)
			} else {
				if task.Role == schedulerWorkerRole {
					task.Prompt, err = prepareRoundPrompt(task, options.state, options.store.stateIO)
					if err != nil {
						results <- schedulerWorkerResult{task: task, jobID: jobID, err: err}
						return
					}
				}
				output, err = options.runSchedulerAgent(ctx, task, jobID, runID, threadID)
			}
			results <- schedulerWorkerResult{task: task, jobID: jobID, err: err, output: string(output)}
		}(task, jobID, stream.RunID, stream.ThreadID)
		if visited != nil {
			visited[task.ID] = true
		}
	}
	return started, nil
}

func (options schedulerRunOptions) runSchedulerAgent(ctx context.Context, task SchedulerTask, jobID, runID, threadID string) ([]byte, error) {
	stdoutPath, stderrPath := schedulerAgentLogPaths(options.state, jobID)
	if err := os.MkdirAll(filepath.Dir(stdoutPath), 0o700); err != nil {
		return nil, fmt.Errorf("create scheduler agent logs directory: %w", err)
	}
	agentArgs, err := schedulerAgentArgs(task, options.state, jobID, runID, options.slots, threadID)
	if err != nil {
		return nil, err
	}
	args := append([]string{options.root.Invocation()}, agentArgs...)
	run, err := options.startSupervisedJob(ctx, task.Stream, proc.Config{
		StateDir: options.state, Tag: runID, RunID: runID, Stall: defaultAgentStall,
		StdoutPath: stdoutPath, StderrPath: stderrPath, Dir: task.RepoRoot, Command: args,
	}, schedulerAdmissionWaitBound)
	if err != nil {
		return nil, fmt.Errorf("start supervised scheduler agent %s: %w", jobID, err)
	}
	runErr := run.Wait()
	stdout, stdoutErr := options.jobSupervisor().ReadOutput(stdoutPath)
	stderr, stderrErr := options.jobSupervisor().ReadOutput(stderrPath)
	output := append(stdout, stderr...)
	if stdoutErr != nil || stderrErr != nil {
		return output, errors.Join(runErr, fmt.Errorf("read scheduler agent output: %w", errors.Join(stdoutErr, stderrErr)))
	}
	if runErr != nil {
		return output, fmt.Errorf("scheduler agent %s exited: %w; runner stderr: %s", jobID, runErr, strings.TrimSpace(string(stderr)))
	}
	return output, nil
}

func schedulerAgentLogPaths(state, jobID string) (string, string) {
	jobsDir := filepath.Join(state, "jobs")
	return filepath.Join(jobsDir, jobID+".launcher.stdout.log"), filepath.Join(jobsDir, jobID+".launcher.stderr.log")
}

func schedulerRunOutputPaths(state, runID string) (string, string) {
	jobsDir := filepath.Join(state, "jobs")
	return filepath.Join(jobsDir, runID+".stdout.log"), filepath.Join(jobsDir, runID+".stderr.log")
}

func reviewRunReportPath(state, runID string) (string, error) {
	if err := validateSchedulerKey(runID, "review run ID"); err != nil {
		return "", err
	}
	return filepath.Join(state, "jobs", runID+".review.md"), nil
}

func readReviewRunOutput(supervisor schedulerJobSupervisor, state, runID string) (string, []byte, error) {
	path, err := reviewRunReportPath(state, runID)
	if err != nil {
		return "", nil, err
	}
	data, err := supervisor.ReadOutput(path)
	if err != nil {
		return path, nil, fmt.Errorf("read review run output: %w", err)
	}
	return path, data, nil
}

func reviewArchivePath(task SchedulerTask, runID string) (string, error) {
	if err := validateSchedulerKey(runID, "review run ID"); err != nil {
		return "", err
	}
	if task.Stream == "" || task.Workdir == "" {
		return "", errors.New("review archive requires the worker stream and workdir")
	}
	return filepath.Join(task.Workdir, "reports", task.Stream+".review."+runID+".md"), nil
}

func archiveReviewRunOutput(options schedulerRunOptions, task SchedulerTask, runID string) (string, []byte, error) {
	_, report, err := reviewOutputForRunID(options, runID)
	if err != nil {
		return "", nil, err
	}
	path, err := reviewArchivePath(task, runID)
	if err != nil {
		return "", nil, err
	}
	if err := options.store.writeAtomic(path, report); err != nil {
		return "", nil, fmt.Errorf("archive review run %s at %s: %w", runID, path, err)
	}
	return path, report, nil
}

func readCompletedReviewRunOutput(supervisor schedulerJobSupervisor, state, runID string) (string, []byte, error) {
	record, exists, err := supervisor.RunByID(state, runID)
	if err != nil {
		return "", nil, fmt.Errorf("inspect review run %s: %w", runID, err)
	}
	if !exists {
		return "", nil, fmt.Errorf("review run %s has no durable process record", runID)
	}
	if !record.Status.Terminal() {
		return "", nil, fmt.Errorf("review run %s is still %s", runID, record.Status)
	}
	if record.Status != proc.StatusCompleted {
		return "", nil, fmt.Errorf("review run %s finished with %s: %s", runID, record.Status, record.Error)
	}
	path, data, err := readReviewRunOutput(supervisor, state, runID)
	if err != nil {
		return "", nil, fmt.Errorf("read completed review run %s output: %w", runID, err)
	}
	return path, data, nil
}

func reviewOutputForRunID(options schedulerRunOptions, runID string) (string, []byte, error) {
	store, state := options.store, options.state
	streams, err := store.streams()
	if err != nil {
		return "", nil, err
	}
	var match *SchedulerStream
	for index := range streams {
		if streams[index].RunID != runID {
			continue
		}
		if match != nil {
			return "", nil, fmt.Errorf("review run ID %s is journaled by multiple streams", runID)
		}
		match = &streams[index]
	}
	if match == nil {
		return "", nil, fmt.Errorf("review run ID %s is not present in the scheduler journal", runID)
	}
	task, err := store.task(match.TaskID)
	if err != nil {
		return "", nil, fmt.Errorf("resolve task for journaled review run %s: %w", runID, err)
	}
	if task.Role != schedulerReviewRole {
		return "", nil, fmt.Errorf("journaled run %s belongs to %s task %s, not a review", runID, task.Role, task.ID)
	}
	return readCompletedReviewRunOutput(options.jobSupervisor(), state, runID)
}

func (options schedulerRunOptions) runGemReview(ctx context.Context, task SchedulerTask, runID string) ([]byte, error) {
	if spec, exists := vendorRegistry[task.Vendor]; !exists || !spec.review {
		return nil, fmt.Errorf("vendor %s is not registered as a review CLI", task.Vendor)
	}
	if len(task.DependsOn) != 1 {
		return nil, fmt.Errorf("gem review task %s must depend on one worker", task.ID)
	}
	worker, err := options.store.task(task.DependsOn[0])
	if err != nil {
		return nil, err
	}
	input, err := buildGemReviewInput(task, worker)
	if err != nil {
		return nil, err
	}
	inputPath := filepath.Join(options.state, "sched", "prompts", task.ID+".gem-input.md")
	if err := options.store.writeAtomic(inputPath, input); err != nil {
		return nil, fmt.Errorf("persist gem review input: %w", err)
	}
	stdoutPath, stderrPath := schedulerRunOutputPaths(options.state, runID)
	stdoutPath, err = reviewRunReportPath(options.state, runID)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(stdoutPath), 0o700); err != nil {
		return nil, fmt.Errorf("create gem review logs directory: %w", err)
	}
	gem, err := vendorBinary(vendorRegistry["gem"])
	if err != nil {
		return nil, err
	}
	record, exists, err := options.jobSupervisor().RunByID(options.state, runID)
	if err != nil {
		return nil, fmt.Errorf("inspect gem review run %s: %w", runID, err)
	}
	if exists && !record.Status.Terminal() {
		record, err = options.jobSupervisor().WaitTag(ctx, options.state, runID)
		if err != nil {
			return nil, fmt.Errorf("wait for gem review run %s: %w", runID, err)
		}
		exists = true
	}
	if !exists {
		run, startErr := options.startSupervisedJob(ctx, task.Stream, proc.Config{
			StateDir: options.state, Tag: runID, RunID: runID, Stall: defaultAgentStall,
			StdoutPath: stdoutPath, StderrPath: stderrPath, StdinPath: inputPath,
			SlotGroup: "agent-scheduler", Slots: options.slots, Dir: task.RepoRoot,
			Command: []string{gem, "-m", task.Model, "-v", "--max-tokens", "8000", "-s", "Review KB Labs changes. Use the supplied rules. Return the complete review report with the first Verdict: line exactly Verdict: ACCEPT or Verdict: REJECT."},
		}, schedulerAdmissionWaitBound)
		if startErr != nil {
			return nil, fmt.Errorf("start supervised gem review run %s: %w", runID, startErr)
		}
		err = run.Wait()
		var readErr error
		record, exists, readErr = options.jobSupervisor().RunByID(options.state, runID)
		if readErr != nil {
			return nil, fmt.Errorf("read gem review run %s after exit: %w", runID, readErr)
		}
		if !exists {
			return nil, fmt.Errorf("gem review run %s exited without a durable run record", runID)
		}
	}
	if record.Status != proc.StatusCompleted {
		output, readErr := options.jobSupervisor().ReadOutput(stdoutPath)
		if readErr != nil {
			return output, errors.Join(fmt.Errorf("gem review run %s finished with %s: %s", runID, record.Status, record.Error), readErr)
		}
		stderr, stderrErr := options.jobSupervisor().ReadOutput(stderrPath)
		if stderrErr != nil {
			return output, errors.Join(fmt.Errorf("gem review run %s finished with %s: %s", runID, record.Status, record.Error), fmt.Errorf("read gem review stderr: %w", stderrErr))
		}
		if gemVendorLimitOutput(output) || gemVendorLimitOutput(stderr) {
			return append(output, stderr...), errGemReviewVendorLimit
		}
		return output, fmt.Errorf("gem review run %s finished with %s: %s; stderr: %s", runID, record.Status, record.Error, strings.TrimSpace(string(stderr)))
	}
	output, err := options.jobSupervisor().ReadOutput(stdoutPath)
	if err != nil {
		return nil, fmt.Errorf("read completed gem review run %s output: %w", runID, err)
	}
	if gemVendorLimitOutput(output) {
		return output, errGemReviewVendorLimit
	}
	if err := validateAutoReviewReport(output); err != nil {
		return output, fmt.Errorf("gem review returned unusable report: %w: %w", errReviewUnusable, err)
	}
	return output, nil
}

func schedulerGemReviewTag(task SchedulerTask) string { return "gem-review-" + task.ID }

var gemCaseReference = regexp.MustCompile(`(?:S|PC)-[0-9]{3}`)

func gemVendorLimitOutput(output []byte) bool {
	text := strings.ToLower(string(output))
	return strings.Contains(text, "429") || strings.Contains(text, "quota") || strings.Contains(text, "location not supported")
}

func firstGemVerdict(data []byte) (string, bool) {
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Verdict:") {
			value := strings.TrimSpace(strings.TrimPrefix(line, "Verdict:"))
			return value, value == "ACCEPT" || value == "REJECT"
		}
	}
	return "", false
}

func buildGemReviewInput(task, worker SchedulerTask) ([]byte, error) {
	const changedFilesBudget = 220 * 1024
	const totalBudget = 500 * 1024
	reportPath := filepath.Join(worker.Workdir, ".agent-report.md")
	if worker.Vendor == "zcode" {
		reportPath = schedulerMessagePath(worker)
	}
	report, err := readCappedFile(reportPath, 48*1024)
	if err != nil {
		return nil, fmt.Errorf("read worker report for gem review: %w", err)
	}
	diff, err := schedulerCommandOutputCapped(worker.Workdir, 180*1024, "git", "-C", worker.Workdir, "diff", "--binary", worker.Base, "--")
	if err != nil {
		return nil, fmt.Errorf("read gem review stream diff: %w", err)
	}
	changed, err := schedulerCommandOutputCapped(worker.Workdir, 16*1024, "git", "-C", worker.Workdir, "diff", "--name-only", "-z", worker.Base, "--")
	if err != nil {
		return nil, fmt.Errorf("list gem review changed files: %w", err)
	}
	untracked, err := schedulerCommandOutputCapped(worker.Workdir, 16*1024, "git", "-C", worker.Workdir, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, fmt.Errorf("list gem review untracked files: %w", err)
	}
	paths := map[string]bool{}
	for _, path := range strings.Split(changed+"\x00"+untracked, "\x00") {
		if path != "" {
			paths[filepath.Clean(path)] = true
		}
	}
	ordered := make([]string, 0, len(paths))
	for path := range paths {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	var files strings.Builder
	used := 0
	for _, path := range ordered {
		if used >= changedFilesBudget {
			fmt.Fprintf(&files, "\n## %s\n\n(omitted: changed-file review size cap)\n", path)
			continue
		}
		limit := int64(32 * 1024)
		if remaining := changedFilesBudget - used; remaining < int(limit) {
			limit = int64(remaining)
		}
		content, readErr := readCappedFile(filepath.Join(worker.Workdir, path), limit)
		if errors.Is(readErr, os.ErrNotExist) {
			fmt.Fprintf(&files, "\n## %s\n\n(file deleted in stream diff)\n", path)
			continue
		}
		if readErr != nil {
			return nil, fmt.Errorf("read changed file %s for gem review: %w", path, readErr)
		}
		if used+len(content) > changedFilesBudget {
			fmt.Fprintf(&files, "\n## %s\n\n(omitted: changed-file review size cap)\n", path)
			continue
		}
		used += len(content)
		fmt.Fprintf(&files, "\n## %s\n\n```\n%s\n```\n", path, content)
	}
	refs := map[string]bool{}
	for _, text := range []string{task.ReviewerFocus, worker.Prompt, string(report), diff, strings.Join(ordered, "\n")} {
		for _, ref := range gemCaseReference.FindAllString(text, -1) {
			refs[ref] = true
		}
	}
	refNames := make([]string, 0, len(refs))
	for ref := range refs {
		refNames = append(refNames, ref)
	}
	sort.Strings(refNames)
	var cases strings.Builder
	caseBytes := 0
	for _, ref := range refNames {
		matches, globErr := filepath.Glob(filepath.Join(worker.RepoRoot, "docs", "qa", "scenarios", ref+"*.md"))
		if globErr != nil {
			return nil, fmt.Errorf("resolve referenced case %s for gem review: %w", ref, globErr)
		}
		for _, path := range matches {
			if caseBytes >= 96*1024 {
				fmt.Fprintf(&cases, "\n## %s\n\n(omitted: referenced-case review size cap)\n", filepath.Base(path))
				continue
			}
			limit := int64(48 * 1024)
			if remaining := 96*1024 - caseBytes; remaining < int(limit) {
				limit = int64(remaining)
			}
			content, readErr := readCappedFile(path, limit)
			if readErr != nil {
				return nil, fmt.Errorf("read referenced case %s for gem review: %w", path, readErr)
			}
			caseBytes += len(content)
			fmt.Fprintf(&cases, "\n## %s\n\n%s\n", filepath.Base(path), content)
		}
	}
	rules, err := readCappedFile(filepath.Join(worker.WorktreeRoot, "prompts", "00-rules.md"), 32*1024)
	if err != nil {
		return nil, fmt.Errorf("read review rules: %w", err)
	}
	taskPrompt, err := readCappedFile(worker.Prompt, 48*1024)
	if err != nil {
		return nil, fmt.Errorf("read stream task prompt for gem review: %w", err)
	}
	input := strings.Join([]string{"# Task prompt\n\n" + task.ReviewerFocus + "\n\n" + string(taskPrompt), "# Agent report\n\n" + string(report), "# Stream diff\n\n" + diff, "# Changed file contents\n" + files.String(), "# Referenced product cases\n" + cases.String(), "# Review rules\n\n" + string(rules)}, "\n\n")
	if len(input) > totalBudget {
		return nil, fmt.Errorf("gem review context is %d bytes, above the %d-byte limit; reduce the changed diff and retry", len(input), totalBudget)
	}
	return []byte(input), nil
}

func schedulerAgentArgs(task SchedulerTask, state, jobID, runID string, slots int, threadID string) ([]string, error) {
	prompt := task.Prompt
	if task.Role == schedulerReviewRole || task.Role == schedulerMergeRole {
		prompt = filepath.Join(state, "sched", "prompts", task.ID+".md")
	}
	args := []string{"agent", "start", "--state", state, "--stream", task.Stream, "--vendor", task.Vendor, "--effort", task.Effort, "--workdir", task.Workdir, "--prompt-file", prompt, "--slot-group", "agent-scheduler", "--slots", fmt.Sprint(slots), "--job-id", jobID}
	if task.Model != "" {
		args = append(args, "--model", task.Model)
	}
	if task.Role == schedulerReviewRole {
		message, err := reviewRunReportPath(state, runID)
		if err != nil {
			return nil, err
		}
		args = append(args, "--message", message)
	} else if task.Vendor == "zcode" && task.Role == schedulerWorkerRole {
		message := schedulerMessagePath(task)
		args = append(args, "--message", message)
	}
	if threadID != "" {
		args = append(args, "--session", threadID)
	}
	return args, nil
}

func (options schedulerRunOptions) readyTasks(visited map[string]bool) ([]SchedulerTask, error) {
	tasks, err := options.store.tasks()
	if err != nil {
		return nil, err
	}
	ready := make([]SchedulerTask, 0, len(tasks))
	for _, task := range tasks {
		if visited[task.ID] {
			continue
		}
		stream, err := options.store.stream(task.Stream)
		if err != nil {
			return nil, err
		}
		if stream.State != SchedulerReady && stream.State != SchedulerRunning {
			continue
		}
		if stream.State == SchedulerRunning && task.Role == schedulerWorkerRole && isAutoAdvanceTask(task) && stream.Advance != nil && stream.Advance.State != AdvanceWorking {
			continue
		}
		blocked, reason, err := options.dependencyWait(task)
		if err != nil {
			return nil, err
		}
		if blocked {
			stream.WaitingFor = reason
			stream.NextStep = "wait for dependency completion"
			if err := options.store.writeStreamObserved(stream); err != nil {
				return nil, err
			}
			continue
		}
		ready = append(ready, task)
	}
	return ready, nil
}

func (options schedulerRunOptions) dependencyWait(task SchedulerTask) (bool, string, error) {
	for _, dependencyID := range task.DependsOn {
		dependency, err := options.store.task(dependencyID)
		if err != nil {
			return false, "", fmt.Errorf("read dependency task %s for %s: %w", dependencyID, task.ID, err)
		}
		stream, err := options.store.stream(dependency.Stream)
		if err != nil {
			return false, "", err
		}
		if task.Role == schedulerReviewRole || task.Role == schedulerMergeRole {
			if stream.State == SchedulerAwaitingReview {
				continue
			}
			return true, dependency.Stream + " (" + string(stream.State) + ")", nil
		}
		if stream.State != SchedulerDone {
			return true, dependency.Stream + " (" + string(stream.State) + ")", nil
		}
	}
	return false, "", nil
}

func (s *schedulerStore) writeStreamObserved(stream SchedulerStream) error {
	return s.withLock(func() error {
		stream.ChangedAt = time.Now().UTC()
		return s.commitAutoTransitionLocked([]SchedulerStream{stream}, map[string]any{"kind": "scheduler.waiting", "stream": stream.Stream, "waiting_for": stream.WaitingFor, "next_step": stream.NextStep, "time": stream.ChangedAt})
	})
}

func (options schedulerRunOptions) ensureWorktree(task SchedulerTask) error {
	return ensureGitWorktree(task.RepoRoot, task.Workdir, task.Stream, task.Base)
}

func (options schedulerRunOptions) finishWorker(result schedulerWorkerResult) error {
	stream, err := options.store.stream(result.task.Stream)
	if err != nil {
		return fmt.Errorf("read scheduler stream %s before consuming job result for task %s: %w", result.task.Stream, result.task.ID, err)
	}
	if result.err != nil {
		if result.task.Role == schedulerWorkerRole && isAutoAdvanceTask(result.task) {
			var admissionTimeout schedulerAdmissionTimeoutError
			if errors.As(result.err, &admissionTimeout) {
				return options.escalateAutoStream(result.task.Stream, "admission-timeout", result.err.Error())
			}
			job, jobErr := newJobStore(options.state).Get(result.jobID)
			if jobErr != nil {
				return fmt.Errorf("failed auto-advance worker %s has no durable job record: %w", result.task.Stream, jobErr)
			}
			if job.Final != nil && job.Final.Reason == ReasonStall {
				if err := options.store.appendOrchestratorEvent(streamAdvanceEvent{Kind: "orchestrator.event", Status: "stall", Stream: result.task.Stream, State: string(stream.Advance.State), Round: stream.Advance.Round, Reason: string(job.Final.Reason)}); err != nil {
					return err
				}
				return options.escalateAutoStream(result.task.Stream, "worker-stalled", "worker job exceeded its no-activity deadline")
			}
		}
		if result.task.Role == schedulerReviewRole && result.task.ReviewerKind != "" {
			queued, fallbackErr := options.fallbackAutoReview(result.task, result.jobID, result.err, result.output)
			if fallbackErr != nil {
				return fallbackErr
			}
			if queued {
				return nil
			}
			if len(result.task.DependsOn) != 1 {
				return fmt.Errorf("auto review task %s must depend on exactly one worker", result.task.ID)
			}
			worker, err := options.store.task(result.task.DependsOn[0])
			if err != nil {
				return fmt.Errorf("resolve worker task for unavailable review %s: %w", result.task.ID, err)
			}
			return options.escalateAutoStream(worker.Stream, "review-unavailable", "review vendor failed without a typed quota or rate-limit reason")
		}
		if result.task.Role == schedulerReviewRole && result.task.Vendor == "zcode" {
			return options.skipUnavailableZCode(result.task, result.err)
		}
		stream.Cause = fmt.Sprintf("agent command failed: %s", strings.TrimSpace(result.err.Error()))
		if err := options.store.transition(stream, SchedulerFailed, "agent process", "inspect the stream report and runner job record"); err != nil {
			return errors.Join(fmt.Errorf("%s", stream.Cause), err)
		}
		return nil
	}
	if result.task.Role == schedulerReviewRole && result.task.Vendor == "gem" {
		return options.finishReview(result.task, stream)
	}
	job, err := newJobStore(options.state).Get(result.jobID)
	if err != nil {
		return fmt.Errorf("agent %s completed but its durable job record is unavailable: %w; output=%s", result.task.Stream, err, strings.TrimSpace(result.output))
	}
	stream.ThreadID = job.SessionID
	if result.task.Role == schedulerReviewRole {
		return options.finishReview(result.task, stream)
	}
	if result.task.Role == schedulerMergeRole {
		return options.finishMerge(result.task, stream)
	}
	reportPath := filepath.Join(result.task.Workdir, ".agent-report.md")
	if result.task.Vendor == "zcode" {
		reportPath = schedulerMessagePath(result.task)
	}
	report, reportBody, err := readReport(reportPath)
	if err != nil {
		stream.Cause = "plan-question"
		return options.store.transition(stream, SchedulerAwaitingOrchestrator, "worker report", "inspect .agent-report.md in the persisted workdir")
	}
	if report == "Status: PARTIAL" || strings.Contains(string(reportBody), "PLAN-QUESTION") {
		if isAutoAdvanceTask(result.task) {
			return options.finishAutoWorker(result.task, stream, report, reportBody)
		}
		stream.Cause = "plan-question"
		return options.store.transition(stream, SchedulerAwaitingOrchestrator, "orchestrator decision", "resolve the worker report before resuming")
	}
	if isAutoAdvanceTask(result.task) {
		return options.finishAutoWorker(result.task, stream, report, reportBody)
	}
	if report != "Status: DONE" {
		stream.Cause = "plan-question"
		return options.store.transition(stream, SchedulerAwaitingOrchestrator, "worker report", "correct .agent-report.md or decide the stream outcome")
	}
	submission, err := options.submit(result.task, stream)
	if err != nil {
		stream.Cause = "outage-after-retries"
		return options.store.transition(stream, SchedulerAwaitingOrchestrator, "remote submission", "inspect backup remote and retry after correcting the cause")
	}
	stream.Submission = &submission
	stream.Cause = ""
	return options.store.transition(stream, SchedulerAwaitingRemote, "GitHub Actions "+submission.Ref, "wait for the shared remote watcher")
}

func (options schedulerRunOptions) queueSkippedReviewFallback(worker SchedulerTask, stream SchedulerStream, reviewerKey, skippedVendor string) (bool, error) {
	tasks, err := options.store.tasks()
	if err != nil {
		return false, err
	}
	for _, slot := range schedulerReviewerSlots(worker) {
		if slot.Vendor == skippedVendor {
			continue
		}
		fallbackID := worker.Stream + "-review-fallback-" + slot.Vendor + "-" + reviewerKey
		alreadyQueued := false
		for _, existing := range tasks {
			if existing.Role != schedulerReviewRole || existing.ReviewerKey != reviewerKey || existing.Vendor != slot.Vendor || len(existing.DependsOn) != 1 || existing.DependsOn[0] != worker.ID {
				continue
			}
			state, err := options.store.stream(existing.Stream)
			if err != nil {
				return false, err
			}
			if state.State == SchedulerReady || state.State == SchedulerRunning {
				return true, nil
			}
			alreadyQueued = true
		}
		if alreadyQueued {
			continue
		}
		fallback := SchedulerTask{ID: fallbackID, Stream: fallbackID, PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Priority: worker.Priority, DependsOn: []string{worker.ID}, Vendor: slot.Vendor, Effort: worker.Effort, Role: schedulerReviewRole, ReviewerKey: reviewerKey, ReviewerFocus: "independent adversarial review: find a concrete failure scenario in the changed behavior"}
		runID, err := proc.AllocateRunID()
		if err != nil {
			return false, fmt.Errorf("allocate fallback reviewer run identity: %w", err)
		}
		if _, err := options.store.addWithSnapshotsAndRunID(fallback, runID, []SchedulerStream{stream}); err != nil {
			return false, fmt.Errorf("queue independent %s reviewer for %s: %w", slot.Vendor, reviewerKey, err)
		}
		return true, nil
	}
	return false, nil
}

func (options schedulerRunOptions) skipUnavailableZCode(task SchedulerTask, cause error) error {
	reviewStream, err := options.store.stream(task.Stream)
	if err != nil {
		return err
	}
	reviewStream.Cause = "ZCode unavailable: " + cause.Error()
	reviewStream.WaitingFor = reviewStream.Cause
	if err := options.store.transition(reviewStream, SchedulerDone, reviewStream.WaitingFor, "skip unavailable ZCode reviewer"); err != nil {
		return err
	}
	if len(task.DependsOn) != 1 {
		return fmt.Errorf("ZCode review task %s must depend on one worker", task.ID)
	}
	worker, err := options.store.task(task.DependsOn[0])
	if err != nil {
		return err
	}
	stream, err := options.store.stream(worker.Stream)
	if err != nil {
		return err
	}
	if stream.ReviewResults == nil {
		stream.ReviewResults = map[string]string{}
	}
	stream.ReviewResults[task.ReviewerKey] = "SKIP"
	worker, err = options.store.task(stream.TaskID)
	if err != nil {
		return err
	}
	mode, reviewers, err := options.reviewPolicy(worker, stream)
	if err != nil {
		return err
	}
	if mode == "cross" && len(stream.ReviewResults) < len(reviewers) {
		return options.store.writeStreamObserved(stream)
	}
	return options.resolveReviewOutcome(worker, stream)
}

func readReport(path string) (string, []byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	return readReportBytes(data)
}

func readReportBytes(data []byte) (string, []byte, error) {
	line, _, _ := strings.Cut(string(data), "\n")
	first := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
	return first, data, nil
}

func workerReportPath(task SchedulerTask) string {
	if task.Vendor == "zcode" {
		return schedulerMessagePath(task)
	}
	return filepath.Join(task.Workdir, ".agent-report.md")
}

func (options schedulerRunOptions) finishReview(task SchedulerTask, reviewStream SchedulerStream) error {
	if task.ReviewerKind != "" {
		return options.finishAutoReview(task, reviewStream)
	}
	_, report, err := readCompletedReviewRunOutput(options.jobSupervisor(), options.state, reviewStream.RunID)
	if err != nil {
		return err
	}
	verdict, err := resolveReviewVerdict(report)
	if err != nil {
		reviewStream.Cause = "review-missing"
		return options.store.transition(reviewStream, SchedulerAwaitingOrchestrator, "private review verdict", "inspect this review task's durable run output")
	}
	if len(task.DependsOn) != 1 {
		return fmt.Errorf("review task %s must depend on exactly one worker task", task.ID)
	}
	workerTask, err := options.store.task(task.DependsOn[0])
	if err != nil {
		return err
	}
	workerStream, err := options.store.stream(workerTask.Stream)
	if err != nil {
		return err
	}
	if err := options.store.transition(reviewStream, SchedulerDone, "", "review verdict recorded"); err != nil {
		return err
	}
	if workerStream.ReviewResults == nil {
		workerStream.ReviewResults = map[string]string{}
	}
	key := task.ReviewerKey
	if key == "" {
		key = task.Vendor
	}
	workerStream.ReviewResults[key] = verdict
	workerStream.ReviewRunIDs = append(workerStream.ReviewRunIDs, reviewStream.RunID)
	workerTask, err = options.store.task(workerStream.TaskID)
	if err != nil {
		return err
	}
	mode, reviewers, err := options.reviewPolicy(workerTask, workerStream)
	if err != nil {
		return err
	}
	if mode == "cross" && len(workerStream.ReviewResults) < len(reviewers) {
		return options.store.writeStreamObserved(workerStream)
	}
	return options.resolveReviewOutcome(workerTask, workerStream)
}

func (options schedulerRunOptions) resolveReviewOutcome(workerTask SchedulerTask, workerStream SchedulerStream) error {
	gate := schedulerReviewGate(workerTask, workerStream)
	if len(gate.Accepted) > 0 && len(gate.Rejected) > 0 {
		workerStream.Cause = "review-disagreement"
		return options.store.transition(workerStream, SchedulerAwaitingOrchestrator, strings.Join(workerStream.ReviewRunIDs, ","), "decide the review disagreement")
	}
	if len(gate.Skipped) > 0 {
		for _, slot := range gate.Skipped {
			queued, err := options.queueSkippedReviewFallback(workerTask, workerStream, slot.Key, slot.Vendor)
			if err != nil {
				return err
			}
			if queued {
				return nil
			}
		}
		workerStream.Cause = "review-unavailable"
		return options.store.transition(workerStream, SchedulerAwaitingOrchestrator, gate.refusal(), "choose an available configured reviewer")
	}
	if len(gate.Missing) > 0 {
		workerStream.Cause = "review-missing"
		return options.store.transition(workerStream, SchedulerAwaitingOrchestrator, strings.Join(gate.Missing, ", "), "inspect missing required review verdicts")
	}
	if gate.allowsLand() {
		_, _, err := options.landAccepted(workerTask, workerStream)
		return err
	}
	if len(gate.Rejected) > 0 {
		workerStream.RejectRounds++
		if workerStream.RejectRounds >= 3 {
			workerStream.Cause = "third-reject"
			return options.store.transition(workerStream, SchedulerAwaitingOrchestrator, strings.Join(workerStream.ReviewRunIDs, ","), "decide after three rejected review rounds")
		}
		if _, err := carryWorkerSessionFromJob(options.state, &workerStream); err != nil {
			return err
		}
	}
	var reports []string
	for _, runID := range workerStream.ReviewRunIDs {
		reportPath, report, err := archiveReviewRunOutput(options, workerTask, runID)
		if err != nil {
			return fmt.Errorf("read review run %s for rework prompt: %w", runID, err)
		}
		if len(report) == 0 {
			return fmt.Errorf("review run %s produced an empty report at %s", runID, reportPath)
		}
		reports = append(reports, reportPath)
	}
	prompt := filepath.Join(options.state, "sched", "prompts", workerTask.ID+"-resume.md")
	promptBody := fmt.Sprintf("The review rejected stream %s. Read the archived review outputs at %s, address their findings, and update .agent-report.md.\n", workerTask.Stream, strings.Join(reports, ", "))
	if err := options.store.writeAtomic(prompt, []byte(promptBody)); err != nil {
		return fmt.Errorf("write review resume prompt: %w", err)
	}
	workerTask.Prompt = prompt
	workerStream.Cause = "review rejected; resume from run IDs " + strings.Join(workerStream.ReviewRunIDs, ", ")
	workerStream.ReviewResults = nil
	workerStream.ReviewRunIDs = nil
	if _, err := carryWorkerSessionFromJob(options.state, &workerStream); err != nil {
		return err
	}
	workerStream.RunID = ""
	workerStream, transitionEvent, err := schedulerTransitionSnapshot(workerStream, SchedulerReady, "", "resume the original agent thread")
	if err != nil {
		return err
	}
	return options.store.commitAutoTransitionWithTasks([]SchedulerStream{workerStream}, []SchedulerTask{workerTask}, transitionEvent)
}

type reviewReportArtifact struct {
	Path     string
	Contents []byte
}

func archiveReviewReports(stateIO runnerStateStore, workdir, stream string, reports []reviewReportArtifact) ([]string, error) {
	if len(reports) == 0 {
		return nil, nil
	}
	archive := filepath.Join(workdir, "reviews", "archive", stream+"-"+time.Now().UTC().Format("20060102T150405.000000000Z")+".md")
	var paths []string
	for _, report := range reports {
		archived := strings.TrimSuffix(archive, ".md") + "-" + filepath.Base(report.Path)
		if err := stateIO.AtomicWrite(archived, report.Contents); err != nil {
			return nil, fmt.Errorf("archive report %s: %w", report.Path, err)
		}
		paths = append(paths, archived)
	}
	return paths, nil
}

func (options schedulerRunOptions) finishMerge(task SchedulerTask, mergeStream SchedulerStream) error {
	status, _, err := readReport(filepath.Join(task.Workdir, ".agent-report.md"))
	if err != nil || status != "Status: DONE" {
		mergeStream.Cause = "plan-question"
		return options.store.transition(mergeStream, SchedulerAwaitingOrchestrator, "merge resolver report", "inspect .agent-report.md in the merge worktree")
	}
	if len(task.DependsOn) != 1 {
		return fmt.Errorf("merge task %s must depend on exactly one worker task", task.ID)
	}
	worker, err := options.store.task(task.DependsOn[0])
	if err != nil {
		return err
	}
	workerState, err := options.store.stream(worker.Stream)
	if err != nil {
		return err
	}
	if _, err := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "add", "-A"); err != nil {
		return fmt.Errorf("stage merge resolver files: %w", err)
	}
	workerHead, err := readGitObjectIDCommand(task.Workdir, "-C", task.Workdir, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return fmt.Errorf("capture worker commit before merge resolution: %w", err)
	}
	integrationSHA, err := readGitObjectIDCommand(task.Workdir, "-C", task.Workdir, "rev-parse", "--verify", "MERGE_HEAD")
	if err != nil {
		return fmt.Errorf("capture integration commit before merge resolution: %w", err)
	}
	nextCommand := fmt.Sprintf("%s sched run --state %q", options.root.InvocationCommand(), options.state)
	if err := excludeLandingReportsFromIndex(options.store.stateIO, task.Workdir, workerHead.String(), nextCommand); err != nil {
		return fmt.Errorf("exclude merge-resolution report files: %w", err)
	}
	resolvedTree, err := readGitObjectIDCommand(task.Workdir, "-C", task.Workdir, "write-tree")
	if err != nil {
		return fmt.Errorf("write merge-resolution tree: %w", err)
	}
	resolvedSHA, err := createCommitObject(options.store.stateIO, task.RepoRoot, resolvedTree, []gitObjectID{workerHead, integrationSHA}, "merge: resolve integration conflicts")
	if err != nil {
		return fmt.Errorf("create merge-resolution commit object: %w", err)
	}
	if err := compareAndSwapLandingRef(options.store.stateIO, task.RepoRoot, "refs/heads/agent/"+worker.Stream, resolvedSHA, workerHead); err != nil {
		var conflict *landingRefConflict
		if errors.As(err, &conflict) {
			return conflict
		}
		return fmt.Errorf("publish merge-resolution commit with worker-ref compare-and-swap: %w", err)
	}
	if _, err := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "reset", "--mixed", resolvedSHA.String()); err != nil {
		return fmt.Errorf("refresh merge-resolution worktree before report snapshot: %w", err)
	}
	verifiedSHA, _, err := snapshotWorktree(options.store.stateIO, task.Workdir, worker.Stream)
	if err != nil {
		return fmt.Errorf("snapshot merge-resolution worktree: %w", err)
	}
	submission, err := options.submitWorkerCommit(worker, verifiedSHA, resolvedSHA)
	if err != nil {
		return fmt.Errorf("submit immutable merge-resolution commit for remote verification: %w", err)
	}
	workerState.Submission = &submission
	workerState.ReviewResults = nil
	workerState.ReviewRunIDs = nil
	workerState.ReviewGeneration++
	workerState.Cause = ""
	if err := options.store.transition(workerState, SchedulerAwaitingRemote, "merge-resolution verification", "wait for remote verification of the resolved worker commit"); err != nil {
		return err
	}
	mergeStream.Cause = ""
	return options.store.transition(mergeStream, SchedulerDone, "", "resolved commit submitted for worker verification")
}

func schedulerJobID(stream string) (string, error) {
	var random [6]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("create scheduler job ID: %w", err)
	}
	return stream + "-" + time.Now().UTC().Format("20060102T150405") + "-" + hex.EncodeToString(random[:]), nil
}

func (options schedulerRunOptions) submit(task SchedulerTask, stream SchedulerStream) (SchedulerSubmission, error) {
	if stream.Submission != nil && stream.Submission.RunID != "" {
		repo, err := options.githubRepo(task.RepoRoot)
		if err != nil {
			return SchedulerSubmission{}, err
		}
		if _, err := schedulerCommandOutput("", "gh", "run", "cancel", stream.Submission.RunID, "--repo", repo); err != nil {
			return SchedulerSubmission{}, fmt.Errorf("cancel superseded verification run %s: %w", stream.Submission.RunID, err)
		}
	}
	branchRef := "refs/heads/agent/" + task.Stream
	expectedRefSHA, err := readGitObjectIDCommand(task.RepoRoot, "-C", task.RepoRoot, "rev-parse", "--verify", branchRef)
	if err != nil {
		return SchedulerSubmission{}, fmt.Errorf("resolve worker branch before verification: %w", err)
	}
	headSHA, err := readGitObjectIDCommand(task.Workdir, "-C", task.Workdir, "rev-parse", "HEAD")
	if err != nil {
		return SchedulerSubmission{}, fmt.Errorf("resolve worker HEAD before verification: %w", err)
	}
	if headSHA != expectedRefSHA {
		return SchedulerSubmission{}, fmt.Errorf("worker HEAD %s does not match expected branch %s at %s", headSHA, branchRef, expectedRefSHA)
	}
	sha, _, err := snapshotWorktree(options.store.stateIO, task.Workdir, task.Stream)
	if err != nil {
		return SchedulerSubmission{}, fmt.Errorf("snapshot worktree: %w", err)
	}
	return options.submitWorkerCommit(task, sha, expectedRefSHA)
}

func (options schedulerRunOptions) submitWorkerCommit(task SchedulerTask, sha, expectedRefSHA gitObjectID) (SchedulerSubmission, error) {
	treeSHA, err := treeSHAForCommit(task.RepoRoot, sha.String())
	if err != nil {
		return SchedulerSubmission{}, err
	}
	ref, err := pushVerificationCommit(task.RepoRoot, verificationPush{kind: verificationPushWorker, stream: task.Stream, sha: sha.String()})
	if err != nil {
		return SchedulerSubmission{}, err
	}
	return SchedulerSubmission{SHA: sha.String(), TreeSHA: treeSHA.String(), ExpectedRefSHA: expectedRefSHA.String(), Ref: ref, DeadlineAt: time.Now().UTC().Add(schedulerRemoteLimit)}, nil
}

func (options schedulerRunOptions) githubRepo(repoRoot string) (string, error) {
	remote, err := schedulerCommandOutput(repoRoot, "git", "-C", repoRoot, "remote", "get-url", "backup")
	if err != nil {
		return "", fmt.Errorf("read backup remote: %w", err)
	}
	core, err := schedulerFileURL(filepath.Join(repoRoot, "scripts", "ci", "remote-verdict.mjs"))
	if err != nil {
		return "", fmt.Errorf("resolve remote verdict module: %w", err)
	}
	code := "const { repositoryFromRemote } = await import(process.argv[1]); process.stdout.write(repositoryFromRemote(process.argv[2]));"
	return schedulerCommandOutput(repoRoot, "node", "--input-type=module", "-e", code, core, remote)
}

func schedulerCommandOutput(dir, name string, args ...string) (string, error) {
	command := exec.Command(name, args...)
	if dir != "" {
		command.Dir = dir
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s: %s: %w", name, strings.Join(args, " "), strings.TrimSpace(string(output)), err)
	}
	return strings.TrimSpace(string(output)), nil
}

type cappedOutputBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (buffer *cappedOutputBuffer) Write(data []byte) (int, error) {
	remaining := buffer.limit - buffer.Len()
	if remaining > 0 {
		if remaining > len(data) {
			remaining = len(data)
		}
		buffer.Buffer.Write(data[:remaining])
	}
	if remaining < len(data) {
		buffer.truncated = true
	}
	return len(data), nil
}

func schedulerCommandOutputCapped(dir string, limit int, name string, args ...string) (string, error) {
	command := exec.Command(name, args...)
	if dir != "" {
		command.Dir = dir
	}
	stdout := &cappedOutputBuffer{limit: limit}
	stderr := &cappedOutputBuffer{limit: 8 * 1024}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Run(); err != nil {
		return "", fmt.Errorf("%s %s: %s: %w", name, strings.Join(args, " "), strings.TrimSpace(stderr.String()), err)
	}
	output := stdout.String()
	if stdout.truncated {
		output += "\n[truncated at source size cap]\n"
	}
	return strings.TrimSpace(output), nil
}

func (options schedulerRunOptions) watchRemote(ctx context.Context) error {
	streams, err := options.store.streams()
	if err != nil {
		return err
	}
	var pending []SchedulerStream
	for _, stream := range streams {
		if stream.State == SchedulerAwaitingRemote && stream.Submission != nil {
			pending = append(pending, stream)
		}
	}
	integrationState, err := options.store.integration()
	if err != nil {
		return err
	}
	if len(pending) == 0 && integrationState.Bisect == nil {
		return nil
	}
	if len(pending) == 0 {
		return errors.New("active candidate bisect has no awaiting-remote candidate stream")
	}
	repoRoot, err := options.store.repositoryRoot()
	if err != nil {
		return err
	}
	repo, err := options.githubRepo(repoRoot)
	if err != nil {
		return options.remoteWatchFailure(pending, err)
	}
	listJSON, err := schedulerCommandOutput("", "gh", "run", "list", "--repo", repo, "--json", "databaseId,headBranch,headSha,status,conclusion,event,path", "--limit", "1000")
	if err != nil {
		return options.remoteWatchFailure(pending, fmt.Errorf("list remote runs: %w", err))
	}
	var runs []schedulerGitHubRun
	if err := json.Unmarshal([]byte(listJSON), &runs); err != nil {
		return fmt.Errorf("decode `gh run list` output: %w", err)
	}
	for _, stream := range pending {
		task, err := options.store.task(stream.TaskID)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if integrationState.Bisect != nil && integrationState.Bisect.CandidateTaskID == stream.TaskID && integrationState.Bisect.CandidateSHA == stream.Submission.SHA {
			continue
		}
		if time.Now().UTC().After(stream.Submission.DeadlineAt) {
			if err := options.writeTerminalVerdict(stream, task, "timeout", "remote verification deadline expired"); err != nil {
				return err
			}
			stream.Cause = "outage-after-retries"
			if err := options.store.transition(stream, SchedulerAwaitingOrchestrator, "remote deadline", "inspect the persisted timeout verdict and decide next action"); err != nil {
				return err
			}
			continue
		}
		run, found := selectSchedulerRun(runs, *stream.Submission)
		if !found {
			continue
		}
		previousStatus, previousConclusion := stream.Submission.Status, stream.Submission.Conclusion
		stream.Submission.RunID = fmt.Sprint(run.DatabaseID)
		stream.Submission.Status, stream.Submission.Conclusion = run.Status, run.Conclusion
		if previousStatus == run.Status && previousConclusion == run.Conclusion {
			if err := options.store.writeStreamObserved(stream); err != nil {
				return err
			}
			continue
		}
		if run.Status != "completed" {
			if err := options.store.writeStreamObserved(stream); err != nil {
				return err
			}
			continue
		}
		if _, err := schedulerCommandOutput("", "gh", "run", "view", fmt.Sprint(run.DatabaseID), "--repo", repo, "--json", "status,conclusion,jobs"); err != nil {
			if err := options.handleOutage(stream, task, err); err != nil {
				return err
			}
			continue
		}
		verdict, err := options.downloadAndValidateVerdict(repo, run, stream.Submission.SHA, repoRoot)
		if err != nil {
			if err := options.handleOutage(stream, task, err); err != nil {
				return err
			}
			continue
		}
		verdictStatus, _ := verdict["status"].(string)
		if run.Conclusion != "success" && verdictStatus == "pass" {
			verdictStatus = "fail"
		}
		if verdictStatus == "outage" {
			if err := options.handleOutage(stream, task, errors.New(verdictCause(verdict))); err != nil {
				return err
			}
			continue
		}
		if err := options.persistVerdict(stream, task, verdict); err != nil {
			return err
		}
		switch verdictStatus {
		case "pass":
			if stream.Submission.Purpose == "candidate" {
				if err := options.store.markIntegrationGreen(stream.Submission.SHA); err != nil {
					return err
				}
				stream.Cause = ""
				if err := options.store.transition(stream, SchedulerDone, "", "integration candidate passed; dependencies may dispatch"); err != nil {
					return err
				}
				options.startHygieneSweep(ctx, true)
			} else if err := options.queueReview(task, stream); err != nil {
				return err
			}
		case "fail":
			if stream.Submission.Purpose == "candidate" {
				if err := options.startCandidateBisect(task, stream, verdict, repo); err != nil {
					return err
				}
			} else if err := options.resumeAfterRemoteFailure(task, stream, verdict); err != nil {
				return err
			}
		case "timeout":
			stream.Cause = "outage-after-retries"
			if err := options.store.transition(stream, SchedulerAwaitingOrchestrator, "remote timeout", "inspect the persisted timeout verdict"); err != nil {
				return err
			}
		default:
			return fmt.Errorf("remote verifier returned unsupported status %q", verdictStatus)
		}
	}
	return options.watchCandidateBisect(ctx, runs, repo)
}

func (options schedulerRunOptions) startCandidateBisect(task SchedulerTask, stream SchedulerStream, verdict map[string]any, repo string) error {
	state, err := options.store.integration()
	if err != nil {
		return err
	}
	if state.Bisect != nil {
		if state.Bisect.CandidateSHA == stream.Submission.SHA {
			return nil
		}
		return errors.New("another candidate bisect is already active")
	}
	start := 0
	if state.LastGreenSHA != "" {
		for start < len(state.Merges) && state.Merges[start].ParentSHA != state.LastGreenSHA {
			start++
		}
	}
	if start >= len(state.Merges) {
		return fmt.Errorf("candidate %s has no recorded integration prefixes since green SHA %s", stream.Submission.SHA, state.LastGreenSHA)
	}
	var failures []string
	if jobs, ok := verdict["jobs"].([]any); ok {
		for _, item := range jobs {
			job, ok := item.(map[string]any)
			if !ok {
				continue
			}
			values, _ := job["failures"].([]any)
			for _, value := range values {
				if name, ok := value.(string); ok && name != "" {
					failures = append(failures, name)
				}
			}
		}
	}
	if len(failures) == 0 {
		return errors.New("candidate verdict failed without named failing tests")
	}
	bisect := &SchedulerBisect{CandidateStream: stream.Stream, CandidateTaskID: task.ID, CandidateSHA: stream.Submission.SHA, CandidateFails: failures}
	for _, merge := range state.Merges[start:] {
		ref, _, err := (verificationPush{kind: verificationPushBisect, stream: merge.Stream, sha: merge.CommitSHA}).ref()
		if err != nil {
			return err
		}
		prefix := SchedulerBisectPrefix{MergeSHA: merge.CommitSHA, Stream: merge.Stream, SHA: merge.CommitSHA, Ref: ref, DeadlineAt: time.Now().UTC().Add(schedulerRemoteLimit)}
		bisect.Prefixes = append(bisect.Prefixes, prefix)
	}
	state.Bisect = bisect
	if err := options.store.writeIntegration(state); err != nil {
		return err
	}
	for index := range state.Bisect.Prefixes {
		prefix := &state.Bisect.Prefixes[index]
		if _, err := pushVerificationCommit(task.RepoRoot, verificationPush{kind: verificationPushBisect, stream: prefix.Stream, sha: prefix.SHA}); err != nil {
			return fmt.Errorf("submit integration prefix %s: %w", prefix.Ref, err)
		}
	}
	return options.store.appendEvent(map[string]any{"kind": "scheduler.bisect.submitted", "stream": stream.Stream, "task_id": task.ID, "candidate_sha": bisect.CandidateSHA, "prefixes": bisect.Prefixes, "time": time.Now().UTC()})
}

func (options schedulerRunOptions) watchCandidateBisect(ctx context.Context, runs []schedulerGitHubRun, repo string) error {
	state, err := options.store.integration()
	if err != nil || state.Bisect == nil {
		return err
	}
	for index := range state.Bisect.Prefixes {
		prefix := &state.Bisect.Prefixes[index]
		if prefix.Status == "pass" || prefix.Status == "fail" || prefix.Status == "outage" {
			continue
		}
		task, err := options.store.task(state.Bisect.CandidateTaskID)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if time.Now().UTC().After(prefix.DeadlineAt) {
			prefix.Status = "outage"
			prefix.Conclusion = "deadline expired"
			if err := options.store.writeIntegration(state); err != nil {
				return err
			}
			continue
		}
		run, found := selectSchedulerRun(runs, SchedulerSubmission{SHA: prefix.SHA, Ref: prefix.Ref})
		if !found {
			if _, err := pushVerificationCommit(task.RepoRoot, verificationPush{kind: verificationPushBisect, stream: prefix.Stream, sha: prefix.SHA}); err != nil {
				return fmt.Errorf("resubmit integration prefix %s: %w", prefix.Ref, err)
			}
			continue
		}
		prefix.RunID = fmt.Sprint(run.DatabaseID)
		prefix.Conclusion = run.Conclusion
		if run.Status != "completed" {
			prefix.Status = "pending"
			if err := options.store.writeIntegration(state); err != nil {
				return err
			}
			continue
		}
		if _, err := schedulerCommandOutput("", "gh", "run", "view", prefix.RunID, "--repo", repo, "--json", "status,conclusion,jobs"); err != nil {
			if retryErr := options.retryBisectPrefix(prefix, repo, err); retryErr != nil {
				return retryErr
			}
			if err := options.store.writeIntegration(state); err != nil {
				return err
			}
			continue
		}
		verdict, err := options.downloadAndValidateVerdict(repo, run, prefix.SHA, task.RepoRoot)
		if err != nil {
			if retryErr := options.retryBisectPrefix(prefix, repo, err); retryErr != nil {
				return retryErr
			}
		} else {
			prefix.Status, _ = verdict["status"].(string)
			prefix.Failures = schedulerVerdictFailures(verdict)
			if run.Conclusion != "success" && prefix.Status == "pass" {
				prefix.Status = "fail"
			}
			if prefix.Status == "outage" {
				if retryErr := options.retryBisectPrefix(prefix, repo, errors.New(verdictCause(verdict))); retryErr != nil {
					return retryErr
				}
			} else if prefix.Status != "pass" && prefix.Status != "fail" && prefix.Status != "pending" {
				return fmt.Errorf("prefix verifier returned unsupported status %q for %s", prefix.Status, prefix.Ref)
			}
		}
		if err := options.store.writeIntegration(state); err != nil {
			return err
		}
	}
	for _, prefix := range state.Bisect.Prefixes {
		if prefix.Status == "" || prefix.Status == "pending" {
			return nil
		}
	}
	for _, prefix := range state.Bisect.Prefixes {
		if prefix.Status == "outage" {
			stream, err := options.store.stream(state.Bisect.CandidateStream)
			if err != nil {
				return err
			}
			state.LastBisect, state.Bisect = state.Bisect, nil
			if err := options.store.writeIntegration(state); err != nil {
				return err
			}
			stream.Cause = "outage-after-retries"
			return options.store.transition(stream, SchedulerAwaitingOrchestrator, "candidate prefix outage", "kb-runner sched ps --json")
		}
	}
	var guilty *SchedulerBisectPrefix
	for index := range state.Bisect.Prefixes {
		if state.Bisect.Prefixes[index].Status == "fail" {
			guilty = &state.Bisect.Prefixes[index]
			break
		}
	}
	if len(state.Bisect.Prefixes) == 0 {
		return errors.New("candidate has no integration prefixes to verify")
	}
	last := state.Bisect.Prefixes[len(state.Bisect.Prefixes)-1]
	task, err := options.store.task(state.Bisect.CandidateTaskID)
	if err != nil {
		return err
	}
	stream, err := options.store.stream(state.Bisect.CandidateStream)
	if err != nil {
		return err
	}
	if last.Status == "pass" {
		state.LastBisect, state.Bisect = state.Bisect, nil
		if err := options.store.writeIntegration(state); err != nil {
			return err
		}
		stream.Cause = "bisect-inconclusive"
		return options.store.transition(stream, SchedulerAwaitingOrchestrator, "candidate and final prefix disagree", "kb-runner sched ps --json")
	}
	if guilty == nil {
		return errors.New("candidate failed but no integration prefix failed")
	}
	policy, err := options.policy(task)
	if err != nil {
		return err
	}
	integration := filepath.Join(task.WorktreeRoot, strings.TrimPrefix(policy.IntegrationBranch, "agent/"))
	if _, err := schedulerCommandOutput(integration, "git", "-C", integration, "revert", "-m", "1", "--no-edit", guilty.MergeSHA); err != nil {
		return fmt.Errorf("revert guilty integration merge %s: %w", guilty.MergeSHA, err)
	}
	head, err := schedulerCommandOutput(integration, "git", "-C", integration, "rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("resolve integration revert HEAD: %w", err)
	}
	failures := append([]string(nil), state.Bisect.CandidateFails...)
	state.LastBisect, state.Bisect = state.Bisect, nil
	state.LastGreenSHA = head
	state.Merges = nil
	if err := options.store.writeIntegration(state); err != nil {
		return err
	}
	stream.Cause = "candidate failures: " + strings.Join(failures, ", ")
	return options.store.transition(stream, SchedulerReady, "guilty integration merge reverted", "kb-runner sched run")
}

func (options schedulerRunOptions) retryBisectPrefix(prefix *SchedulerBisectPrefix, repo string, cause error) error {
	if prefix.Attempts >= schedulerOutageLimit || prefix.RunID == "" {
		prefix.Status = "outage"
		prefix.Conclusion = cause.Error()
		return nil
	}
	if _, err := schedulerCommandOutput("", "gh", "run", "rerun", prefix.RunID, "--repo", repo); err != nil {
		return fmt.Errorf("rerun unavailable candidate prefix %s: %w", prefix.Ref, errors.Join(cause, err))
	}
	prefix.Attempts++
	prefix.Status = "pending"
	prefix.Conclusion = cause.Error()
	return nil
}

func schedulerVerdictFailures(verdict map[string]any) []string {
	var failures []string
	if jobs, ok := verdict["jobs"].([]any); ok {
		for _, item := range jobs {
			job, ok := item.(map[string]any)
			if !ok {
				continue
			}
			values, _ := job["failures"].([]any)
			for _, value := range values {
				if name, ok := value.(string); ok && name != "" {
					failures = append(failures, name)
				}
			}
		}
	}
	return failures
}

type schedulerGitHubRun struct {
	DatabaseID   int64  `json:"databaseId"`
	HeadBranch   string `json:"headBranch"`
	HeadSHA      string `json:"headSha"`
	Status       string `json:"status"`
	Conclusion   string `json:"conclusion"`
	Event        string `json:"event"`
	WorkflowPath string `json:"path"`
}

func selectSchedulerRun(runs []schedulerGitHubRun, submission SchedulerSubmission) (schedulerGitHubRun, bool) {
	for _, run := range runs {
		if run.Event == "push" && run.WorkflowPath == ".github/workflows/remote-verify.yml" && run.HeadBranch == submission.Ref && run.HeadSHA == submission.SHA {
			return run, true
		}
	}
	return schedulerGitHubRun{}, false
}

func (options schedulerRunOptions) downloadAndValidateVerdict(repo string, run schedulerGitHubRun, sha, repoRoot string) (result map[string]any, returnErr error) {
	artifacts, err := os.MkdirTemp("", "kb-scheduler-verdict-")
	if err != nil {
		return nil, fmt.Errorf("create verdict download directory: %w", err)
	}
	defer func() {
		if cleanupErr := os.RemoveAll(artifacts); cleanupErr != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove remote verdict download directory: %w", cleanupErr))
		}
	}()
	if _, err := schedulerCommandOutput("", "gh", "run", "download", fmt.Sprint(run.DatabaseID), "--repo", repo, "--name", "remote-verdict", "--dir", artifacts); err != nil {
		return nil, fmt.Errorf("download remote verdict: %w", err)
	}
	verdictPath := filepath.Join(artifacts, "verdict.json")
	module, err := schedulerFileURL(filepath.Join(repoRoot, "scripts", "ci", "remote-verdict.mjs"))
	if err != nil {
		return nil, fmt.Errorf("resolve remote verdict module: %w", err)
	}
	code := "import { readFileSync } from 'node:fs'; const { parseVerdict } = await import(process.argv[1]); const value = JSON.parse(readFileSync(process.argv[2], 'utf8')); process.stdout.write(JSON.stringify(parseVerdict(value, process.argv[3])));"
	validated, err := schedulerCommandOutput(repoRoot, "node", "--input-type=module", "-e", code, module, verdictPath, sha)
	if err != nil {
		return nil, fmt.Errorf("validate verdict against remote-verify-core: %w", err)
	}
	var verdict map[string]any
	if err := json.Unmarshal([]byte(validated), &verdict); err != nil {
		return nil, fmt.Errorf("read validated remote verdict: %w", err)
	}
	return verdict, nil
}

func verdictCause(verdict map[string]any) string {
	if diagnostics, ok := verdict["diagnostics"].([]any); ok {
		var messages []string
		for _, value := range diagnostics {
			if message, ok := value.(string); ok && message != "" {
				messages = append(messages, message)
			}
		}
		return strings.Join(messages, "\n")
	}
	return "remote verification did not pass"
}

func (options schedulerRunOptions) writeTerminalVerdict(stream SchedulerStream, task SchedulerTask, status, message string) error {
	module, err := schedulerFileURL(filepath.Join(task.RepoRoot, "scripts", "ci", "remote-verdict.mjs"))
	if err != nil {
		return fmt.Errorf("resolve remote verdict module: %w", err)
	}
	code := "const { terminalVerdict } = await import(process.argv[1]); process.stdout.write(JSON.stringify(terminalVerdict(process.argv[2], process.argv[3], process.argv[4])));"
	body, err := schedulerCommandOutput(task.RepoRoot, "node", "--input-type=module", "-e", code, module, stream.Submission.SHA, status, message)
	if err != nil {
		return fmt.Errorf("create remote terminal verdict: %w", err)
	}
	return options.writeVerdictFile(task, stream, []byte(body+"\n"))
}

func (options schedulerRunOptions) persistVerdict(stream SchedulerStream, task SchedulerTask, verdict map[string]any) error {
	data, err := json.MarshalIndent(verdict, "", "  ")
	if err != nil {
		return err
	}
	return options.writeVerdictFile(task, stream, append(data, '\n'))
}

func (options schedulerRunOptions) writeVerdictFile(task SchedulerTask, stream SchedulerStream, data []byte) error {
	name := task.Stream + ".remote." + stream.Submission.SHA[:7] + ".json"
	path := filepath.Join(filepath.Dir(task.RepoRoot), "reports", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create scheduler report directory: %w", err)
	}
	if err := options.store.writeAtomic(path, data); err != nil {
		return fmt.Errorf("persist remote verdict %s: %w", path, err)
	}
	return nil
}

func (options schedulerRunOptions) handleOutage(stream SchedulerStream, task SchedulerTask, cause error) error {
	if stream.Submission.Attempts < schedulerOutageLimit && stream.Submission.RunID != "" {
		repo, err := options.githubRepo(task.RepoRoot)
		if err != nil {
			return err
		}
		if _, err := schedulerCommandOutput("", "gh", "run", "rerun", stream.Submission.RunID, "--repo", repo); err == nil {
			stream.Submission.Attempts++
			stream.Submission.Status = "queued"
			stream.Submission.Conclusion = ""
			stream.Cause = cause.Error()
			return options.store.writeStreamObserved(stream)
		} else {
			cause = errors.Join(cause, fmt.Errorf("request remote rerun: %w", err))
		}
	}
	stream.Cause = "outage-after-retries"
	if err := options.writeTerminalVerdict(stream, task, "outage", stream.Cause); err != nil {
		return err
	}
	return options.store.transition(stream, SchedulerAwaitingOrchestrator, "remote outage", "inspect the persisted outage verdict and decide next action")
}

func (options schedulerRunOptions) remoteWatchFailure(streams []SchedulerStream, cause error) error {
	for _, stream := range streams {
		stream.Submission.Attempts++
		stream.Cause = "outage-after-retries"
		if stream.Submission.Attempts > schedulerOutageLimit {
			task, err := options.store.task(stream.TaskID)
			if err != nil {
				return err
			}
			if err := options.writeTerminalVerdict(stream, task, "outage", stream.Cause); err != nil {
				return err
			}
			if err := options.store.transition(stream, SchedulerAwaitingOrchestrator, "remote outage", "inspect the persisted outage verdict and decide next action"); err != nil {
				return err
			}
			continue
		}
		if err := options.store.writeStreamObserved(stream); err != nil {
			return err
		}
	}
	return nil
}

func (options schedulerRunOptions) queueReview(workerTask SchedulerTask, workerStream SchedulerStream) error {
	mode, reviewers, err := options.reviewPolicy(workerTask, workerStream)
	if err != nil {
		return err
	}
	workerTask.Review, workerTask.Reviewers = mode, append([]string(nil), reviewers...)
	if err := options.store.updateTask(workerTask); err != nil {
		return fmt.Errorf("persist effective review policy: %w", err)
	}
	workerStream.Cause = ""
	if err := options.store.transition(workerStream, SchedulerAwaitingReview, "review task", "run the READY review task"); err != nil {
		return err
	}
	for i, vendor := range reviewers {
		key := vendor
		streamName := workerTask.Stream + "-review"
		if workerStream.ReviewGeneration > 0 {
			streamName += fmt.Sprintf("-v%d", workerStream.ReviewGeneration)
		}
		if workerStream.RejectRounds > 0 {
			streamName += fmt.Sprintf("-r%d", workerStream.RejectRounds+1)
		}
		focus := "independent review"
		if len(reviewers) > 1 {
			key = fmt.Sprintf("%s-%d", vendor, i+1)
			streamName += fmt.Sprintf("-%d", i+1)
			if vendor == "codex" && i == 1 {
				focus = "adversarial: find a concrete failure scenario in the changed behavior"
			}
		}
		reviewTask := SchedulerTask{ID: streamName, Stream: streamName, PromptTemplate: runnerReviewTemplate, Workdir: workerTask.Workdir, WorktreeRoot: workerTask.WorktreeRoot, RepoRoot: workerTask.RepoRoot, Base: workerTask.Base, Priority: workerTask.Priority, DependsOn: []string{workerTask.ID}, Vendor: vendor, Effort: workerTask.Effort, Role: schedulerReviewRole, ReviewerKey: key, ReviewerFocus: focus}
		runID, err := proc.AllocateRunID()
		if err != nil {
			return fmt.Errorf("allocate %s review run identity: %w", vendor, err)
		}
		if _, err := options.store.addWithSnapshotsAndRunID(reviewTask, runID, nil); err != nil && !strings.Contains(err.Error(), "already exists") {
			return fmt.Errorf("queue review task %s: %w", reviewTask.ID, err)
		}
	}
	return nil
}

func (options schedulerRunOptions) resumeAfterRemoteFailure(task SchedulerTask, stream SchedulerStream, verdict map[string]any) error {
	prompt := filepath.Join(options.state, "sched", "prompts", task.ID+"-remote-resume.md")
	var details []string
	if jobs, ok := verdict["jobs"].([]any); ok {
		for _, item := range jobs {
			job, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, _ := job["name"].(string)
			for _, failure := range anyStrings(job["failures"]) {
				details = append(details, fmt.Sprintf("%s: %s", name, failure))
			}
			if logTail, _ := job["logTail"].(string); logTail != "" {
				details = append(details, name+" log: "+logTail)
			}
		}
	}
	if cause := verdictCause(verdict); cause != "" {
		details = append(details, cause)
	}
	body := fmt.Sprintf("Remote verification failed for stream %s. Resume the existing agent thread, inspect the failing tests below, fix the failures, and update .agent-report.md.\n\n%s\n", task.Stream, strings.Join(details, "\n"))
	if err := options.store.writeAtomic(prompt, []byte(body)); err != nil {
		return fmt.Errorf("write remote failure resume prompt: %w", err)
	}
	task.Prompt = prompt
	if err := options.store.updateTask(task); err != nil {
		return err
	}
	stream.Cause = strings.Join(details, "\n")
	return options.store.transition(stream, SchedulerReady, "", "resume the original agent thread with the remote failures")
}

func anyStrings(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func renderReviewPromptContent(task SchedulerTask, reviewStream, parentStream SchedulerStream, state string) ([]byte, error) {
	data, err := readRunnerTemplate(task.PromptTemplate)
	if err != nil {
		return nil, fmt.Errorf("read review prompt template: %w", err)
	}
	streamName := parentStream.Stream
	if streamName == "" {
		streamName = task.Stream
	}
	content := strings.ReplaceAll(string(data), "{stream}", streamName)
	if task.Role == schedulerReviewRole {
		reportPath, pathErr := reviewRunReportPath(state, reviewStream.RunID)
		if pathErr != nil {
			return nil, pathErr
		}
		content = strings.ReplaceAll(content, "{review-report}", filepath.Base(reportPath))
	}
	if task.ReviewerFocus != "" {
		content += "\nReviewer focus: " + task.ReviewerFocus + "\n"
	}
	return []byte(content), nil
}

func (options schedulerRunOptions) persistReviewPrompt(task SchedulerTask, reviewStream, parentStream SchedulerStream) (string, error) {
	content, err := renderReviewPromptContent(task, reviewStream, parentStream, options.state)
	if err != nil {
		return "", fmt.Errorf("render review prompt: %w", err)
	}
	path := filepath.Join(options.state, "sched", "prompts", task.ID+".md")
	if err := options.store.writeAtomic(path, content); err != nil {
		return "", fmt.Errorf("render review prompt: %w", err)
	}
	return path, nil
}

func schedulerFileURL(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return (&url.URL{Scheme: "file", Path: absolute}).String(), nil
}
