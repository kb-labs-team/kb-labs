//go:build darwin || linux

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/kb-runner/internal/proc"
)

type StreamAdvanceState string

const (
	AdvanceWorking   StreamAdvanceState = "working"
	AdvanceVerifying StreamAdvanceState = "verifying"
	AdvanceReviewing StreamAdvanceState = "reviewing"
	AdvanceAccepted  StreamAdvanceState = "accepted"
	AdvanceRework    StreamAdvanceState = "rework"
	AdvanceEscalated StreamAdvanceState = "escalated"
)

type StreamAdvance struct {
	State              StreamAdvanceState `json:"state"`
	Round              int                `json:"round"`
	LastVerdict        string             `json:"last_verdict,omitempty"`
	TreeHash           string             `json:"tree_hash,omitempty"`
	Reason             string             `json:"reason,omitempty"`
	PartialResumes     int                `json:"partial_resumes,omitempty"`
	HighRisk           bool               `json:"high_risk,omitempty"`
	PreviousTreeHash   string             `json:"previous_tree_hash,omitempty"`
	PreviousFindings   string             `json:"previous_findings,omitempty"`
	LastReviewVerdict  string             `json:"last_review_verdict,omitempty"`
	LandingCommit      string             `json:"landing_commit,omitempty"`
	LandingExpectedRef string             `json:"landing_expected_ref,omitempty"`
	RunID              string             `json:"run_id,omitempty"`
}

type ReviewRole string

const (
	ReviewStandard    ReviewRole = "standard"
	ReviewDelta       ReviewRole = "delta"
	ReviewAdversarial ReviewRole = "adversarial"
	ReviewFinal       ReviewRole = "final-adversarial"
)

type ReviewRoute struct {
	Vendor        string
	Model         string
	Fallback      string
	FallbackModel string
}

var reviewRoleRoutes = map[ReviewRole]ReviewRoute{
	ReviewStandard:    {Vendor: "zcode", Model: "GLM-5.3-flash", Fallback: "gem", FallbackModel: "claude-sonnet-4-6"},
	ReviewDelta:       {Vendor: "gem", Model: "claude-sonnet-4-6", Fallback: "zcode", FallbackModel: "GLM-5.3-flash"},
	ReviewAdversarial: {Vendor: "gem", Model: "claude-opus-4-6-thinking", Fallback: "zcode", FallbackModel: "GLM-5.3-flash"},
	ReviewFinal:       {Vendor: "codex", Fallback: "zcode", FallbackModel: "GLM-5.3"},
}

func reviewRouteForRole(role ReviewRole, highRisk bool) (ReviewRoute, error) {
	if (role == ReviewAdversarial || role == ReviewFinal) && !highRisk {
		return ReviewRoute{}, nil
	}
	route, exists := reviewRoleRoutes[role]
	if !exists {
		return ReviewRoute{}, fmt.Errorf("unknown review role %q", role)
	}
	if role == ReviewStandard && highRisk {
		route.Model = "GLM-5.3"
	}
	return route, nil
}

func validateAdvanceReport(report []byte) error {
	lines := strings.Split(string(report), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "Status: DONE" {
		return errors.New("worker report must start with Status: DONE")
	}
	sections := make(map[string]bool)
	designTable := false
	inDesignGate := false
	for index, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "## ") {
			section := strings.TrimPrefix(line, "## ")
			sections[section] = true
			inDesignGate = section == "Design gate"
		}
		if inDesignGate && strings.HasPrefix(line, "| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |") && index+1 < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[index+1]), "|---") {
			designTable = true
		}
	}
	if !sections["Design gate"] || !designTable {
		return errors.New("worker report is missing the required design table under ## Design gate")
	}
	for _, section := range []string{"Verification", "Open issues", "Unrequested behaviour changes", "Debt self-scan", "Self-review"} {
		if !sections[section] {
			return fmt.Errorf("worker report is missing required section ## %s", section)
		}
	}
	return nil
}

func promptEffort(prompt []byte) (string, bool, error) {
	lines := strings.Split(strings.ReplaceAll(string(prompt), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", false, nil
	}
	frontmatter := true
	effort := ""
	for _, raw := range lines[1:] {
		line := strings.TrimSpace(raw)
		if line == "---" {
			frontmatter = false
			break
		}
		key, value, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(key) != "effort" {
			continue
		}
		if effort != "" {
			return "", false, errors.New("prompt frontmatter declares effort more than once")
		}
		effort = strings.TrimSpace(value)
	}
	if frontmatter {
		return "", false, errors.New("prompt frontmatter is missing its closing delimiter")
	}
	if effort == "" {
		return "", false, nil
	}
	if effort != "high" && effort != "medium" {
		return "", false, fmt.Errorf("prompt frontmatter effort must be high or medium, got %q", effort)
	}
	return effort, true, nil
}

func deltaReviewFocus(previousTree, previousFindings, diff string) string {
	return "delta review from previously reviewed tree " + previousTree + ". Verify only these prior findings and that this diff does not regress them.\n\nPrevious findings:\n" + previousFindings + "\nDiff from previous reviewed tree to current HEAD:\n" + diff
}

func requireGreenOutsideResult(tree string, result verifyOutsideResult) error {
	if tree == "" {
		return errors.New("outside-suite result has no verified tree identity")
	}
	if len(result.Modules) == 0 {
		return errors.New("no outside-suite results are recorded")
	}
	for _, module := range result.Modules {
		if module.ExitCode != 0 || len(module.FailedTests) > 0 {
			failed := make([]string, 0, len(module.FailedTests))
			for _, test := range module.FailedTests {
				failed = append(failed, test.Package+":"+test.Test)
			}
			return fmt.Errorf("outside suite %s failed; log: %s; failed tests: %s", module.Module, module.Log, strings.Join(failed, ", "))
		}
	}
	return nil
}

func isAutoAdvanceTask(task SchedulerTask) bool { return len(task.OutsideSuites) > 0 }

func (options schedulerRunOptions) verifyAdvanceSuites(task SchedulerTask) (verifyOutsideResult, error) {
	commit, _, err := snapshotWorktree(options.store.stateIO, task.Workdir, task.Stream)
	if err != nil {
		return verifyOutsideResult{}, fmt.Errorf("snapshot worktree before outside suites: %w", err)
	}
	tree, err := treeSHAForCommit(task.Workdir, commit.String())
	if err != nil {
		return verifyOutsideResult{}, err
	}
	stream, err := options.store.stream(task.Stream)
	if err != nil {
		return verifyOutsideResult{}, err
	}
	if stream.Advance != nil && stream.Advance.Round > 0 && stream.Advance.TreeHash != "" && stream.Advance.TreeHash != tree.String() {
		stream.Advance.PreviousTreeHash = stream.Advance.TreeHash
		if err := options.store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
			return verifyOutsideResult{}, err
		}
	}
	runID := ""
	if stream.Advance != nil && stream.Advance.State == AdvanceVerifying {
		runID = stream.Advance.RunID
	}
	if runID == "" {
		runID, err = proc.AllocateRunID()
		if err != nil {
			return verifyOutsideResult{}, fmt.Errorf("allocate outside verification run identity: %w", err)
		}
	}
	if err := options.store.advanceWithRunID(task.Stream, AdvanceVerifying, "", "", tree.String(), runID); err != nil {
		return verifyOutsideResult{}, err
	}
	stream, err = options.store.stream(task.Stream)
	if err != nil {
		return verifyOutsideResult{}, err
	}
	tag := stream.Advance.RunID
	outputDir := filepath.Join(options.state, "jobs")
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return verifyOutsideResult{}, fmt.Errorf("create outside-suite state directory: %w", err)
	}
	stdoutPath, stderrPath := schedulerRunOutputPaths(options.state, tag)
	runRecord, exists, err := options.jobSupervisor().RunByID(options.state, tag)
	if err != nil {
		return verifyOutsideResult{}, fmt.Errorf("inspect outside-suite run %s: %w", tag, err)
	}
	if exists && !runRecord.Status.Terminal() {
		runRecord, err = options.jobSupervisor().WaitTag(options.lifecycle, options.state, tag)
		if err != nil {
			return verifyOutsideResult{}, fmt.Errorf("wait for outside-suite run %s: %w", tag, err)
		}
		exists = true
	}
	if !exists {
		args := []string{"verify", "outside", task.Workdir}
		args = append(args, task.OutsideSuites...)
		args = append(args, "--json")
		run, startErr := options.startSupervisedJob(options.lifecycle, task.Stream, proc.Config{
			StateDir: options.state, Tag: tag, RunID: tag, Stall: 30 * time.Minute,
			StdoutPath: stdoutPath, StderrPath: stderrPath,
			SlotGroup: "heavy-go-test", Slots: 1, CostKey: "heavy-go-test", CostClass: proc.CostHeavy,
			Dir: task.RepoRoot, Command: append([]string{options.root.Invocation()}, args...),
		}, schedulerAdmissionWaitBound)
		if startErr != nil {
			return verifyOutsideResult{}, fmt.Errorf("start outside-suite run %s: %w", tag, startErr)
		}
		if err := run.Wait(); err != nil {
			return verifyOutsideResult{}, fmt.Errorf("outside suites failed: %w; JSONL: %s; stderr: %s", err, stdoutPath, stderrPath)
		}
		runRecord, exists, err = options.jobSupervisor().RunByID(options.state, tag)
		if err != nil {
			return verifyOutsideResult{}, fmt.Errorf("read outside-suite run %s after completion: %w", tag, err)
		}
		if !exists {
			return verifyOutsideResult{}, fmt.Errorf("outside-suite run %s completed without a durable run record", tag)
		}
	}
	if runRecord.Status != proc.StatusCompleted {
		return verifyOutsideResult{}, fmt.Errorf("outside-suite run %s finished with %s: %s", tag, runRecord.Status, runRecord.Error)
	}
	data, err := options.jobSupervisor().ReadOutput(stdoutPath)
	if err != nil {
		return verifyOutsideResult{}, fmt.Errorf("read outside-suite result: %w; JSONL: %s", err, stdoutPath)
	}
	var result verifyOutsideResult
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&result); err != nil {
		return verifyOutsideResult{}, fmt.Errorf("decode outside-suite result: %w; JSONL: %s", err, stdoutPath)
	}
	commitAfter, _, err := snapshotWorktree(options.store.stateIO, task.Workdir, task.Stream)
	if err != nil {
		return result, err
	}
	treeAfter, err := treeSHAForCommit(task.Workdir, commitAfter.String())
	if err != nil {
		return result, err
	}
	if treeAfter != tree {
		return result, fmt.Errorf("outside suites tested tree %s but worktree is now %s; JSONL: %s", tree, treeAfter, stdoutPath)
	}
	if err := requireGreenOutsideResult(tree.String(), result); err != nil {
		return result, fmt.Errorf("%w; JSONL: %s", err, stdoutPath)
	}
	return result, nil
}

func (options schedulerRunOptions) finishAutoWorker(task SchedulerTask, stream SchedulerStream, status string, report []byte) error {
	if status == "Status: PARTIAL" {
		stream, err := options.store.stream(task.Stream)
		if err != nil {
			return err
		}
		if stream.Advance == nil || stream.Advance.State != AdvanceWorking {
			return fmt.Errorf("stream %s has no active working advancement state", task.Stream)
		}
		if stream.Advance.PartialResumes >= 1 {
			stream.Advance.PartialResumes++
			stream.Advance, err = nextAdvanceSnapshot(stream, AdvanceEscalated, "worker reported PARTIAL twice", "", "")
			if err != nil {
				return err
			}
			stream.Cause = "partial-twice"
			stream, transitionEvent, err := schedulerTransitionSnapshot(stream, SchedulerAwaitingOrchestrator, stream.Advance.Reason, "inspect the persisted stream report and runner event log")
			if err != nil {
				return err
			}
			event := streamAdvanceEvent{Kind: "orchestrator.event", Status: "escalated", Stream: stream.Stream, State: string(stream.Advance.State), Round: stream.Advance.Round, Reason: stream.Advance.Reason, LastVerdict: stream.Advance.LastVerdict}
			return options.store.commitAutoTransition([]SchedulerStream{stream}, event, transitionEvent)
		}
		prompt := filepath.Join(options.state, "sched", "prompts", task.ID+"-partial-resume.md")
		if err := options.store.writeAtomic(prompt, []byte("PARTIAL is not a stopping point; finish to DONE per the task prompt\n")); err != nil {
			return fmt.Errorf("write partial continuation prompt: %w", err)
		}
		task.Prompt = prompt
		stream.Cause = ""
		stream.Advance.PartialResumes++
		if _, err := carryWorkerSessionFromJob(options.state, &stream); err != nil {
			return err
		}
		stream.RunID = ""
		stream, event, err := schedulerTransitionSnapshot(stream, SchedulerReady, "partial worker report", "resume the same worker session with the continuation prompt")
		if err != nil {
			return err
		}
		return options.store.commitAutoTransitionWithTasks([]SchedulerStream{stream}, []SchedulerTask{task}, event)
	}
	if status == "Status: BLOCKED" || strings.Contains(string(report), "PLAN-QUESTION") {
		return options.escalateAutoStream(task.Stream, "blocked", strings.TrimSpace(string(report)))
	}
	if status != "Status: DONE" {
		return options.escalateAutoStream(task.Stream, "invalid-worker-status", "worker report must start with Status: DONE, PARTIAL, or BLOCKED")
	}
	if err := validateAdvanceReport(report); err != nil {
		return options.queueAutoRework(task, "pre-review report gate failed: "+err.Error())
	}
	_, err := options.verifyAdvanceSuites(task)
	if err != nil {
		var admissionTimeout schedulerAdmissionTimeoutError
		if errors.As(err, &admissionTimeout) {
			return options.escalateAutoStream(task.Stream, "admission-timeout", err.Error())
		}
		return options.queueAutoRework(task, err.Error())
	}
	highRisk, err := options.isHighRisk(task)
	if err != nil {
		return fmt.Errorf("resolve review risk policy: %w", err)
	}
	stream.Advance.HighRisk = highRisk
	role := ReviewStandard
	if stream.Advance.Round > 0 {
		role = ReviewDelta
	}
	return options.queueAutoReview(task, role)
}

func (options schedulerRunOptions) isHighRisk(task SchedulerTask) (bool, error) {
	policy, err := options.policy(task)
	if err != nil {
		return false, err
	}
	changed, err := schedulerCommandOutput(task.Workdir, "git", "-C", task.Workdir, "diff", "--name-only", task.Base)
	if err != nil {
		return false, fmt.Errorf("read changed paths for auto review policy: %w", err)
	}
	for _, name := range strings.Split(changed, "\n") {
		if name != "" && containsSchedulerPath(policy.RiskZones, name) {
			return true, nil
		}
	}
	return false, nil
}

func (options schedulerRunOptions) escalateAutoStream(streamName, cause, reason string) error {
	stream, err := options.store.stream(streamName)
	if err != nil {
		return err
	}
	advance, err := nextAdvanceSnapshot(stream, AdvanceEscalated, reason, "", "")
	if err != nil {
		return err
	}
	stream.Advance = advance
	stream.Cause = cause
	stream, transitionEvent, err := schedulerTransitionSnapshot(stream, SchedulerAwaitingOrchestrator, reason, "inspect the persisted stream report and runner event log")
	if err != nil {
		return err
	}
	event := streamAdvanceEvent{Kind: "orchestrator.event", Status: "escalated", Stream: stream.Stream, State: string(advance.State), Round: advance.Round, Reason: reason, LastVerdict: advance.LastVerdict}
	return options.store.commitAutoTransition([]SchedulerStream{stream}, event, transitionEvent)
}

func (options schedulerRunOptions) queueAutoRework(task SchedulerTask, reason string) error {
	stream, err := options.store.stream(task.Stream)
	if err != nil {
		return err
	}
	return options.queueAutoReworkSnapshots(task, reason, stream, nil)
}

func (options schedulerRunOptions) queueAutoReworkSnapshots(task SchedulerTask, reason string, stream SchedulerStream, related []SchedulerStream) error {
	advance, err := nextAdvanceSnapshot(stream, AdvanceRework, reason, "REJECT", "")
	if err != nil {
		return err
	}
	stream.Advance = advance
	if stream.Advance.State == AdvanceEscalated {
		stream.Cause = "auto-rework-limit"
		stream, transitionEvent, err := schedulerTransitionSnapshot(stream, SchedulerAwaitingOrchestrator, stream.Advance.Reason, "inspect the archived reviews and decide the stream outcome")
		if err != nil {
			return err
		}
		event := streamAdvanceEvent{Kind: "orchestrator.event", Status: "escalated", Stream: stream.Stream, State: string(stream.Advance.State), Round: stream.Advance.Round, Reason: stream.Advance.Reason, LastVerdict: stream.Advance.LastVerdict}
		streams := append([]SchedulerStream{stream}, related...)
		return options.store.commitAutoTransition(streams, event, transitionEvent)
	}
	if _, err := carryWorkerSessionFromJob(options.state, &stream); err != nil {
		return err
	}
	prompt := filepath.Join(options.state, "sched", "prompts", task.ID+fmt.Sprintf("-auto-rework-r%d.md", stream.Advance.Round))
	body := fmt.Sprintf("Automatic verification requested rework for stream %s. Fix the named failures and update .agent-report.md.\n\n%s\n", task.Stream, reason)
	if len(stream.ReviewRunIDs) > 0 {
		var previousFindings []string
		for _, runID := range stream.ReviewRunIDs {
			archivePath, data, readErr := archiveReviewRunOutput(options, task, runID)
			if readErr != nil {
				return fmt.Errorf("read review run %s for rework: %w", runID, readErr)
			}
			defects, extractErr := reviewDefectSection(data)
			if extractErr != nil {
				return fmt.Errorf("extract review defects from run %s: %w", runID, extractErr)
			}
			body += "\nArchived review: " + archivePath + "\n"
			body += "\n" + defects
			previousFindings = append(previousFindings, defects)
		}
		body += "\nupdate .agent-report.md\n"
		stream.Advance.PreviousFindings = strings.Join(previousFindings, "\n\n")
	}
	if stream.Advance.TreeHash != "" {
		stream.Advance.PreviousTreeHash = stream.Advance.TreeHash
	}
	if err := options.store.writeAtomic(prompt, []byte(body)); err != nil {
		return fmt.Errorf("write automatic rework prompt: %w", err)
	}
	task.Prompt = prompt
	stream.Cause = ""
	stream.RunID = ""
	stream.ReviewResults = nil
	stream.ReviewRunIDs = nil
	stream, transitionEvent, err := schedulerTransitionSnapshot(stream, SchedulerReady, "automatic rework", "resume the original worker session")
	if err != nil {
		return err
	}
	streams := append([]SchedulerStream{stream}, related...)
	return options.store.commitAutoTransitionWithTasks(streams, []SchedulerTask{task}, transitionEvent)
}

func reviewDefectSection(report []byte) (string, error) {
	text := string(report)
	lines := strings.SplitAfter(text, "\n")
	offset := 0
	start, end := -1, len(text)
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if start >= 0 && strings.HasPrefix(trimmed, "## ") {
			end = offset
			break
		}
		if trimmed == "## Defects" || trimmed == "## Findings" {
			start = offset
		}
		offset += len(line)
	}
	if start < 0 {
		return "", errors.New("review report has no ## Defects or ## Findings section")
	}
	return text[start:end], nil
}

func (options schedulerRunOptions) queueAutoReview(worker SchedulerTask, role ReviewRole) error {
	stream, err := options.store.stream(worker.Stream)
	if err != nil {
		return err
	}
	if stream.Advance == nil {
		return fmt.Errorf("auto review for %s has no persisted advancement state", worker.Stream)
	}
	route, err := reviewRouteForRole(role, stream.Advance.HighRisk)
	if err != nil {
		return err
	}
	if route.Vendor == "" {
		return fmt.Errorf("review role %s is not enabled for this stream", role)
	}
	vendor, registered := vendorRegistry[route.Vendor]
	if !registered || (!vendor.agent && !vendor.review) {
		return fmt.Errorf("vendor %s is not registered for review", route.Vendor)
	}
	if route.Vendor == "codex" && role == ReviewFinal && !stream.Advance.HighRisk {
		return errors.New("final adversarial review requires a high-risk stream")
	}
	streamName := fmt.Sprintf("%s-review-%s-r%d", worker.Stream, role, stream.Advance.Round+1)
	if existing, lookupErr := options.store.task(streamName); lookupErr == nil {
		if existing.ReviewerKind != role || existing.ReviewTreeHash != stream.Advance.TreeHash || existing.Role != schedulerReviewRole || existing.DependsOn == nil || len(existing.DependsOn) != 1 || existing.DependsOn[0] != worker.ID {
			return fmt.Errorf("persisted review task %s conflicts with the requested %s review", streamName, role)
		}
		reviewState, err := options.store.stream(existing.Stream)
		if err != nil {
			return err
		}
		if reviewState.State == SchedulerRunning && reviewState.RunID == "" {
			return fmt.Errorf("running review task %s has no persisted run identity", streamName)
		}
		var snapshots []SchedulerStream
		var events []any
		workerChanged := false
		if stream.Advance == nil {
			return fmt.Errorf("persisted review task %s has no worker advancement state", streamName)
		}
		if stream.Advance.State != AdvanceReviewing {
			stream.Advance, err = nextAdvanceSnapshot(stream, AdvanceReviewing, "", "", stream.Advance.TreeHash)
			if err != nil {
				return fmt.Errorf("journal worker Reviewing state before reusing review task %s: %w", streamName, err)
			}
			events = append(events, streamAdvanceEvent{Kind: "scheduler.advance", Status: "progress", Stream: stream.Stream, State: string(AdvanceReviewing), Round: stream.Advance.Round})
			workerChanged = true
		}
		if stream.State != SchedulerAwaitingReview {
			var event map[string]any
			stream, event, err = schedulerTransitionSnapshot(stream, SchedulerAwaitingReview, "review task", "run the READY review task")
			if err != nil {
				return err
			}
			events = append(events, event)
			workerChanged = true
		}
		if workerChanged {
			snapshots = append(snapshots, stream)
		}
		if reviewState.State == SchedulerRunning {
			var event map[string]any
			reviewState, event, err = schedulerTransitionSnapshot(reviewState, SchedulerReady, "recover interrupted review", "resume the same reviewer session")
			if err != nil {
				return err
			}
			snapshots = append(snapshots, reviewState)
			events = append(events, event)
		}
		if reviewState.State == SchedulerReady && reviewState.RunID == "" {
			reviewState.RunID, err = proc.AllocateRunID()
			if err != nil {
				return fmt.Errorf("allocate persisted review task %s run identity: %w", streamName, err)
			}
			snapshots = append(snapshots, reviewState)
		}
		if len(snapshots) > 0 {
			return options.store.commitAutoTransition(snapshots, events...)
		}
		return nil
	} else if !errors.Is(lookupErr, os.ErrNotExist) {
		return fmt.Errorf("inspect persisted review task %s: %w", streamName, lookupErr)
	}
	focus := "review the exact verified tree " + stream.Advance.TreeHash + "; report a Verdict: ACCEPT or Verdict: REJECT and include a ## Defects section"
	if role == ReviewDelta {
		if stream.Advance.PreviousTreeHash == "" {
			return fmt.Errorf("delta review for %s has no previously reviewed tree", worker.Stream)
		}
		diff, err := schedulerCommandOutput(worker.Workdir, "git", "-C", worker.Workdir, "diff", stream.Advance.PreviousTreeHash, "HEAD")
		if err != nil {
			return fmt.Errorf("read delta review diff from %s to HEAD: %w", stream.Advance.PreviousTreeHash, err)
		}
		focus = deltaReviewFocus(stream.Advance.PreviousTreeHash, stream.Advance.PreviousFindings, diff)
	}
	if role == ReviewAdversarial || role == ReviewFinal {
		focus = "adversarial review of exact verified tree " + stream.Advance.TreeHash + "; report a Verdict: ACCEPT or Verdict: REJECT and include a ## Defects section"
		if role == ReviewAdversarial {
			promptPath := filepath.Join(worker.RepoRoot, "prompts", worker.Stream+"-review-adv.md")
			prompt, readErr := readCappedFile(promptPath, 64*1024)
			if readErr != nil {
				return fmt.Errorf("read adversarial review prompt %s: %w", promptPath, readErr)
			}
			focus += "\n\nConfigured adversarial review prompt:\n\n" + string(prompt)
		}
	}
	review := SchedulerTask{ID: streamName, Stream: streamName, PromptTemplate: runnerReviewTemplate, Workdir: worker.Workdir, WorktreeRoot: worker.WorktreeRoot, RepoRoot: worker.RepoRoot, Base: worker.Base, Priority: worker.Priority, DependsOn: []string{worker.ID}, Vendor: route.Vendor, Model: route.Model, Effort: worker.Effort, Role: schedulerReviewRole, ReviewerKey: string(role), ReviewerKind: role, ReviewTreeHash: stream.Advance.TreeHash, ReviewerFocus: focus}
	runID, err := proc.AllocateRunID()
	if err != nil {
		return fmt.Errorf("allocate %s review run identity: %w", role, err)
	}
	workerReviewState := stream
	var workerEvent any
	if workerReviewState.State != SchedulerAwaitingReview {
		workerReviewState, workerEvent, err = schedulerTransitionSnapshot(workerReviewState, SchedulerAwaitingReview, "review task", "run the READY review task")
		if err != nil {
			return err
		}
	}
	if workerReviewState.Advance.State != AdvanceReviewing {
		workerReviewState.Advance, err = nextAdvanceSnapshot(workerReviewState, AdvanceReviewing, "", "", workerReviewState.Advance.TreeHash)
		if err != nil {
			return err
		}
	}
	var events []any
	if workerEvent != nil {
		events = append(events, workerEvent)
	}
	if _, err := options.store.addWithSnapshotsAndRunID(review, runID, []SchedulerStream{workerReviewState}, events...); err != nil {
		return fmt.Errorf("queue %s review for %s: %w", role, worker.Stream, err)
	}
	return nil
}

func (options schedulerRunOptions) fallbackAutoReview(task SchedulerTask, jobID string, runErr error, output string) (bool, error) {
	if len(task.DependsOn) != 1 {
		return false, fmt.Errorf("auto review task %s must depend on exactly one worker", task.ID)
	}
	reason := ""
	if errors.Is(runErr, errGemReviewVendorLimit) || gemVendorLimitOutput([]byte(output)) {
		reason = "gem-vendor-limit"
	} else if errors.Is(runErr, errReviewUnusable) {
		reason = "review-unusable"
	} else if task.Vendor == "gem" {
		return false, nil
	} else {
		job, err := newJobStore(options.state).Get(jobID)
		if err != nil {
			return false, fmt.Errorf("read failed review job %s for vendor-limit routing: %w", jobID, err)
		}
		if job.Final == nil || (job.Final.Reason != ReasonRateLimited && job.Final.Reason != ReasonQuota) {
			return false, nil
		}
		reason = string(job.Final.Reason)
	}
	worker, err := options.store.task(task.DependsOn[0])
	if err != nil {
		return false, err
	}
	streamForRoute, err := options.store.stream(worker.Stream)
	if err != nil {
		return false, fmt.Errorf("read worker stream %s before routing fallback review: %w", worker.Stream, err)
	}
	if streamForRoute.Advance == nil {
		return false, fmt.Errorf("auto review stream %s has no persisted advancement state", worker.Stream)
	}
	route, err := reviewRouteForRole(task.ReviewerKind, streamForRoute.Advance.HighRisk)
	if err != nil {
		return false, err
	}
	if route.Fallback == "" || task.Vendor == route.Fallback {
		return false, nil
	}
	stream := streamForRoute
	route.Vendor = route.Fallback
	fallback := task
	fallback.ID = worker.Stream + "-review-fallback-" + string(task.ReviewerKind) + fmt.Sprintf("-r%d", stream.Advance.Round+1)
	fallback.Stream = fallback.ID
	fallback.Vendor = route.Vendor
	fallback.Model = route.FallbackModel
	fallback.ReviewerKey = string(task.ReviewerKind)
	runID, err := proc.AllocateRunID()
	if err != nil {
		return false, fmt.Errorf("allocate fallback review run identity: %w", err)
	}
	reviewStream, err := options.store.stream(task.Stream)
	if err != nil {
		return false, err
	}
	reviewStream.Cause = reason
	waiting, next := "vendor limit", "run the queued fallback review task"
	if reason == "review-unusable" {
		waiting, next = "unusable review report", "run the queued fallback review task"
	}
	reviewStream, reviewEvent, err := schedulerTransitionSnapshot(reviewStream, SchedulerDone, waiting, next)
	if err != nil {
		return false, err
	}
	events := []any{reviewEvent}
	if reason != "review-unusable" {
		events = append(events, streamAdvanceEvent{Kind: "orchestrator.event", Status: "vendor-limit", Stream: worker.Stream, State: string(stream.Advance.State), Round: stream.Advance.Round, Reason: reason})
	}
	if _, err := options.store.addWithSnapshotsAndRunID(fallback, runID, []SchedulerStream{stream, reviewStream}, events...); err != nil {
		return false, fmt.Errorf("queue %s fallback reviewer: %w", task.ReviewerKind, err)
	}
	return true, nil
}

func (options schedulerRunOptions) emitAutoStreamCondition(status, reason string) error {
	streams, err := options.store.streams()
	if err != nil {
		return err
	}
	for _, stream := range streams {
		if stream.Advance == nil || stream.Advance.State == AdvanceAccepted || stream.Advance.State == AdvanceEscalated {
			continue
		}
		if err := options.store.appendOrchestratorEvent(streamAdvanceEvent{Kind: "orchestrator.event", Status: status, Stream: stream.Stream, State: string(stream.Advance.State), Round: stream.Advance.Round, Reason: reason}); err != nil {
			return err
		}
	}
	return nil
}

func (options schedulerRunOptions) finishAutoReview(task SchedulerTask, reviewStream SchedulerStream) error {
	if len(task.DependsOn) != 1 {
		return fmt.Errorf("auto review task %s must depend on exactly one worker", task.ID)
	}
	worker, err := options.store.task(task.DependsOn[0])
	if err != nil {
		return err
	}
	stream, err := options.store.stream(worker.Stream)
	if err != nil {
		return err
	}
	if stream.Advance == nil || stream.Advance.State != AdvanceReviewing || stream.Advance.TreeHash == "" {
		return fmt.Errorf("auto review task %s has no persisted reviewing tree", task.ID)
	}
	_, report, err := readCompletedReviewRunOutput(options.jobSupervisor(), options.state, reviewStream.RunID)
	if err != nil {
		return err
	}
	verdict, err := resolveReviewVerdict(report)
	if err != nil {
		return options.escalateAutoReview(worker, stream, reviewStream, "review report has no valid verdict")
	}
	if stream.ReviewResults == nil {
		stream.ReviewResults = map[string]string{}
	}
	stream.ReviewResults[string(task.ReviewerKind)] = verdict
	if err := validateAutoReviewReport(report); err != nil {
		queued, fallbackErr := options.fallbackAutoReview(task, "", fmt.Errorf("%w: %w", errReviewUnusable, err), string(report))
		if fallbackErr != nil {
			return fallbackErr
		}
		if queued {
			return nil
		}
		return options.escalateAutoStream(worker.Stream, "review-unavailable", "review report was unusable: "+err.Error())
	}
	stream.ReviewRunIDs = append(stream.ReviewRunIDs, reviewStream.RunID)
	stream.Advance.LastVerdict = verdict
	stream.Advance.LastReviewVerdict = verdict
	reviewStream.State = SchedulerDone
	reviewStream.WaitingFor = ""
	reviewStream.NextStep = "review verdict recorded"
	reviewStream.Cause = ""
	if verdict == "REJECT" {
		return options.queueAutoReworkSnapshots(worker, "review rejected verified tree "+stream.Advance.TreeHash, stream, []SchedulerStream{reviewStream})
	}
	if err := options.store.commitAutoTransition([]SchedulerStream{reviewStream, stream}); err != nil {
		return err
	}
	return options.continueAutoReview(worker, stream, task.ReviewerKind)
}

func (options schedulerRunOptions) escalateAutoReview(worker SchedulerTask, parent, child SchedulerStream, reason string) error {
	advance, err := nextAdvanceSnapshot(parent, AdvanceEscalated, reason, "", "")
	if err != nil {
		return err
	}
	parent.Advance = advance
	parent.Cause = "review-missing"
	parent, parentTransition, err := schedulerTransitionSnapshot(parent, SchedulerAwaitingOrchestrator, reason, "inspect the persisted review report and runner event log")
	if err != nil {
		return err
	}
	child.Cause = "review-missing"
	var transitions []any
	if child.State != SchedulerAwaitingOrchestrator {
		var childTransition map[string]any
		child, childTransition, err = schedulerTransitionSnapshot(child, SchedulerAwaitingOrchestrator, "private review verdict", "inspect the review task report and persisted job record")
		if err != nil {
			return err
		}
		transitions = append(transitions, childTransition)
	}
	event := streamAdvanceEvent{Kind: "orchestrator.event", Status: "escalated", Stream: worker.Stream, State: string(AdvanceEscalated), Round: advance.Round, Reason: reason, LastVerdict: advance.LastVerdict}
	transitions = append([]any{event, parentTransition}, transitions...)
	return options.store.commitAutoTransition([]SchedulerStream{parent, child}, transitions...)
}

func validateAutoReviewReport(report []byte) error {
	if _, ok := firstGemVerdict(report); !ok {
		return errors.New("report has no valid first Verdict: ACCEPT or Verdict: REJECT line")
	}
	sections := map[string]bool{}
	sectionContent := map[string]bool{}
	current := ""
	for _, raw := range strings.Split(strings.ReplaceAll(string(report), "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "## ") {
			current = strings.TrimPrefix(line, "## ")
			sections[current] = true
			continue
		}
		if current != "" && line != "" {
			sectionContent[current] = true
		}
	}
	if !sections["Defects"] && !sections["Findings"] {
		return errors.New("report is missing ## Defects or ## Findings")
	}
	if !sections["Verification"] {
		return errors.New("report is missing ## Verification")
	}
	if (!sectionContent["Defects"] && !sectionContent["Findings"]) || !sectionContent["Verification"] {
		return errors.New("report is truncated before findings and verification are complete")
	}
	return nil
}

func readCappedFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	closeErr := file.Close()
	if err := errors.Join(err, closeErr); err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return append(data[:limit], []byte("\n[truncated at source size cap]\n")...), nil
	}
	return data, nil
}

func (options schedulerRunOptions) continueAutoReview(worker SchedulerTask, stream SchedulerStream, role ReviewRole) error {
	if !stream.Advance.HighRisk {
		if role != ReviewStandard && role != ReviewDelta {
			return fmt.Errorf("unexpected review role %s for low-risk stream", role)
		}
		return options.acceptAutoStream(worker, stream)
	}
	switch role {
	case ReviewStandard:
		if _, err := os.Stat(filepath.Join(worker.RepoRoot, "prompts", worker.Stream+"-review-adv.md")); err == nil {
			return options.queueAutoReview(worker, ReviewAdversarial)
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect adversarial review prompt: %w", err)
		}
		return options.queueAutoReview(worker, ReviewFinal)
	case ReviewDelta, ReviewAdversarial:
		return options.queueAutoReview(worker, ReviewFinal)
	case ReviewFinal:
		return options.acceptAutoStream(worker, stream)
	default:
		return fmt.Errorf("unexpected auto review role %s", role)
	}
}

func (options schedulerRunOptions) recoverAutoStreams() error {
	streams, err := options.store.streams()
	if err != nil {
		return err
	}
recoveryStream:
	for _, stream := range streams {
		if stream.Advance == nil {
			continue
		}
		// Accepted plus DONE is the journal's landing target. Do not feed that
		// already-recovered state back through the transition table.
		if stream.State == SchedulerDone && stream.Advance.State == AdvanceAccepted {
			continue
		}
		worker, err := options.store.task(stream.TaskID)
		if err != nil {
			return err
		}
		if !isAutoAdvanceTask(worker) {
			continue
		}
		switch stream.Advance.State {
		case AdvanceWorking:
			if stream.State == SchedulerRunning {
				path := workerReportPath(worker)
				status, report, reportErr := readReport(path)
				if reportErr == nil && status != "Status: RUNNING" {
					if err := options.finishAutoWorker(worker, stream, status, report); err != nil {
						return err
					}
				} else if reportErr != nil && !errors.Is(reportErr, os.ErrNotExist) {
					return fmt.Errorf("recover worker result for %s: read report %s: %w", worker.Stream, path, reportErr)
				} else {
					runRecord, exists, recordErr := options.jobSupervisor().RunByID(options.state, stream.RunID)
					if recordErr != nil {
						if handled, escalationErr := options.escalateUnknownRunRecord(worker.Stream, recordErr); handled {
							if escalationErr != nil {
								return escalationErr
							}
							continue recoveryStream
						}
						return fmt.Errorf("inspect worker run record %s for %s: %w", stream.RunID, worker.Stream, recordErr)
					}
					if !exists && stream.JobID != "" && stream.RunID != "" {
						// Keep the durable claim. Dispatch will retry Start with its
						// journaled job and run IDs after this recovery pass.
						continue
					}
					if exists && runRecord.Status.Terminal() {
						runID, allocateErr := proc.AllocateRunID()
						if allocateErr != nil {
							return fmt.Errorf("allocate replacement worker run identity for %s: %w", worker.Stream, allocateErr)
						}
						stream.RunID = runID
						var transitionEvent map[string]any
						stream, transitionEvent, err = schedulerTransitionSnapshot(stream, SchedulerReady, "worker process ended before report", "resume the same worker task")
						if err != nil {
							return err
						}
						if err := options.store.commitAutoTransition([]SchedulerStream{stream}, transitionEvent); err != nil {
							return fmt.Errorf("journal replacement worker run for %s: %w", worker.Stream, err)
						}
						continue recoveryStream
					}
					live, err := options.autoTaskIsLive(worker, stream.JobID)
					if err != nil {
						return fmt.Errorf("recover worker process for %s: %w; next: %s sched ps --state %s --json", worker.Stream, err, options.root.InvocationCommand(), shellQuote(options.state))
					}
					if !live {
						if err := options.store.transition(stream, SchedulerReady, "recover orphaned worker", "resume the same worker task"); err != nil {
							return err
						}
					}
				}
			}
			// Keep the durable running claim when the report is only the marker
			// written before launch. Dispatch reuses the claim under the new lease.
		case AdvanceVerifying:
			var verificationRun proc.RunInfo
			var verificationExists bool
			if stream.Advance.RunID != "" {
				var inspectErr error
				verificationRun, verificationExists, inspectErr = options.jobSupervisor().RunByID(options.state, stream.Advance.RunID)
				if inspectErr != nil {
					if handled, escalationErr := options.escalateUnknownRunRecord(worker.Stream, inspectErr); handled {
						if escalationErr != nil {
							return escalationErr
						}
						continue recoveryStream
					}
					return fmt.Errorf("inspect outside verification run %s: %w", stream.Advance.RunID, inspectErr)
				}
				if verificationExists && verificationRun.Status == proc.StatusLost {
					runID, allocateErr := proc.AllocateRunID()
					if allocateErr != nil {
						return fmt.Errorf("allocate replacement verification run identity for %s: %w", worker.Stream, allocateErr)
					}
					if err := options.store.advanceWithRunID(worker.Stream, AdvanceVerifying, stream.Advance.Reason, "", stream.Advance.TreeHash, runID); err != nil {
						return fmt.Errorf("journal replacement verification run for %s: %w", worker.Stream, err)
					}
					continue recoveryStream
				}
			}
			path := filepath.Join(worker.Workdir, ".agent-report.md")
			if worker.Vendor == "zcode" {
				path = schedulerMessagePath(worker)
			}
			status, report, err := readReport(path)
			if err != nil {
				return fmt.Errorf("recover verification for %s: read worker report %s: %w", worker.Stream, path, err)
			}
			if err := options.finishAutoWorker(worker, stream, status, report); err != nil {
				return err
			}
		case AdvanceReviewing:
			if stream.Advance.LandingCommit != "" {
				landed, _, landErr := options.landAccepted(worker, stream)
				if landErr != nil {
					return options.escalateAutoStream(worker.Stream, "landing-refused", "commit-only landing could not be completed: "+landErr.Error())
				}
				if !landed {
					return options.escalateAutoStream(worker.Stream, "landing-refused", "commit-only landing did not complete")
				}
				if err := options.store.advance(worker.Stream, AdvanceAccepted, "all required reviews accepted", "ACCEPT", stream.Advance.TreeHash); err != nil {
					return err
				}
				fresh, err := options.store.stream(worker.Stream)
				if err != nil {
					return err
				}
				if err := options.store.transition(fresh, SchedulerDone, "accepted", "commit-only landing completed"); err != nil {
					return err
				}
				continue
			}
			role := ReviewRole("")
			for _, candidate := range []ReviewRole{ReviewStandard, ReviewDelta, ReviewAdversarial, ReviewFinal} {
				if stream.ReviewResults[string(candidate)] != "" {
					role = candidate
				}
			}
			if role != "" && stream.ReviewResults[string(role)] == "ACCEPT" {
				if err := options.continueAutoReview(worker, stream, role); err != nil {
					return err
				}
				continue
			}
			if role != "" && stream.ReviewResults[string(role)] == "REJECT" {
				if err := options.queueAutoRework(worker, "review rejected verified tree "+stream.Advance.TreeHash); err != nil {
					return err
				}
				continue
			}
			tasks, err := options.store.tasks()
			if err != nil {
				return err
			}
			pending := false
			for _, candidate := range tasks {
				if candidate.Role != schedulerReviewRole || candidate.ReviewerKind == "" || len(candidate.DependsOn) != 1 || candidate.DependsOn[0] != worker.ID {
					continue
				}
				review, err := options.store.stream(candidate.Stream)
				if err != nil {
					return err
				}
				if review.State == SchedulerRunning {
					if runRecord, exists, err := options.jobSupervisor().RunByID(options.state, review.RunID); err != nil {
						if handled, escalationErr := options.escalateUnknownRunRecord(worker.Stream, err); handled {
							if escalationErr != nil {
								return escalationErr
							}
							continue recoveryStream
						}
						return fmt.Errorf("inspect reviewer run %s for task %s: %w", review.RunID, candidate.ID, err)
					} else if exists && runRecord.Status.Terminal() {
						if runRecord.Status == proc.StatusLost {
							runID, allocateErr := proc.AllocateRunID()
							if allocateErr != nil {
								return fmt.Errorf("allocate replacement review run identity for %s: %w", candidate.ID, allocateErr)
							}
							review.RunID = runID
							review.WaitingFor = "review process lost"
							review.NextStep = "retry the same review task"
							review.ChangedAt = nowSchedulerUTC()
							if err := options.store.commitAutoTransition([]SchedulerStream{review}); err != nil {
								return fmt.Errorf("journal replacement review run for %s: %w", candidate.ID, err)
							}
							pending = true
							continue
						}
						if runRecord.Status != proc.StatusCompleted {
							_, stderrPath := schedulerRunOutputPaths(options.state, review.RunID)
							stderr, readErr := options.jobSupervisor().ReadOutput(stderrPath)
							if readErr != nil {
								return fmt.Errorf("read failed reviewer run %s stderr before recovery: %w", review.RunID, readErr)
							}
							queued, fallbackErr := options.fallbackAutoReview(candidate, review.JobID, fmt.Errorf("review run %s finished with %s: %s", review.RunID, runRecord.Status, runRecord.Error), string(stderr))
							if fallbackErr != nil {
								return fallbackErr
							}
							if !queued {
								return fmt.Errorf("review run %s for task %s finished with %s: %s", review.RunID, candidate.ID, runRecord.Status, runRecord.Error)
							}
							pending = true
							continue
						}
						if err := options.finishAutoReview(candidate, review); err != nil {
							return err
						}
						pending = true
						continue
					} else if !exists && review.JobID != "" && review.RunID != "" {
						// Start has not published the atomic process-owner record.
						// Preserve the claim for dispatch with the same identity.
						pending = true
						continue
					}
					live, err := options.autoTaskIsLive(candidate, review.JobID)
					if err != nil {
						return fmt.Errorf("recover reviewer process for %s: %w; next: %s sched ps --state %s --json", candidate.ID, err, options.root.InvocationCommand(), shellQuote(options.state))
					}
					if !live {
						if err := options.store.transition(review, SchedulerReady, "recover orphaned review", "resume the same review task"); err != nil {
							return err
						}
					}
					pending = true
				} else if review.State == SchedulerReady {
					pending = true
				} else if review.State == SchedulerAwaitingOrchestrator && review.Cause == "review-missing" {
					return options.escalateAutoReview(worker, stream, review, "review report has no valid verdict")
				}
			}
			if !pending {
				next := ReviewStandard
				if stream.Advance.Round > 0 {
					next = ReviewDelta
				}
				if stream.Advance.HighRisk && stream.ReviewResults[string(ReviewStandard)] == "ACCEPT" {
					if _, err := os.Stat(filepath.Join(worker.RepoRoot, "prompts", worker.Stream+"-review-adv.md")); err == nil && stream.ReviewResults[string(ReviewAdversarial)] == "" {
						next = ReviewAdversarial
					} else if err != nil && !errors.Is(err, os.ErrNotExist) {
						return fmt.Errorf("inspect adversarial review prompt during recovery: %w", err)
					} else {
						next = ReviewFinal
					}
				}
				if err := options.queueAutoReview(worker, next); err != nil {
					return err
				}
			}
		case AdvanceAccepted:
			accepted, reviewErr := persistedAutoReviewsAccepted(worker, stream)
			if reviewErr != nil || !accepted {
				reason := "all required persisted reviews must accept before landing"
				if reviewErr != nil {
					reason = reviewErr.Error()
				}
				return options.escalateAutoStream(worker.Stream, "landing-refused", "commit-only landing could not be completed: "+reason)
			}
			if stream.Advance.LandingCommit != "" {
				candidate, err := storedGitObjectID(stream.Advance.LandingCommit)
				if err != nil {
					return fmt.Errorf("recover landing candidate for %s: %w", stream.Stream, err)
				}
				ref := "refs/heads/agent/" + stream.Stream
				landed, err := readGitObjectIDCommand(worker.RepoRoot, "-C", worker.RepoRoot, "rev-parse", "--verify", ref)
				if err != nil {
					return fmt.Errorf("inspect landing ref %s for %s: %w", ref, stream.Stream, err)
				}
				if landed != candidate {
					expected, parseErr := storedGitObjectID(stream.Advance.LandingExpectedRef)
					if parseErr != nil {
						return fmt.Errorf("recover landing expected ref for %s: %w", stream.Stream, parseErr)
					}
					if landed != expected {
						return fmt.Errorf("landing for %s is unknown: ref %s is %s, expected old ref %s or candidate %s", stream.Stream, ref, landed, expected, candidate)
					}
					tree, treeErr := treeSHAForCommit(worker.RepoRoot, candidate.String())
					if treeErr != nil {
						return fmt.Errorf("read accepted landing tree for %s: %w", stream.Stream, treeErr)
					}
					if tree.String() != stream.Advance.TreeHash {
						return fmt.Errorf("accepted landing candidate tree %s differs from journaled tree %s", tree, stream.Advance.TreeHash)
					}
					if err := moveLandingRef(options.store.stateIO, worker.RepoRoot, stream.Stream, landingObject{CommitSHA: candidate, TreeSHA: tree}, expected.String()); err != nil {
						return fmt.Errorf("retry accepted landing ref for %s: %w", stream.Stream, err)
					}
				}
				if err := refreshLandingWorktree(options.store.stateIO, worker.RepoRoot, worker.Workdir, candidate.String()); err != nil {
					return fmt.Errorf("refresh accepted worker worktree for %s: %w", stream.Stream, err)
				}
				if err := options.store.transition(stream, SchedulerDone, "accepted", "commit-only landing completed"); err != nil {
					return err
				}
				continue
			}
			if _, _, err := options.landAutoAccepted(worker, stream); err != nil {
				return options.escalateAutoStream(worker.Stream, "landing-refused", "commit-only landing could not be completed: "+err.Error())
			}
			fresh, err := options.store.stream(stream.Stream)
			if err != nil {
				return err
			}
			if fresh.State != SchedulerDone {
				if err := options.store.transition(fresh, SchedulerDone, "accepted", "commit-only landing completed"); err != nil {
					return err
				}
			}
		case AdvanceRework:
			if stream.State == SchedulerRunning {
				_, exists, recordErr := options.jobSupervisor().RunByID(options.state, stream.RunID)
				if recordErr != nil {
					if handled, escalationErr := options.escalateUnknownRunRecord(worker.Stream, recordErr); handled {
						if escalationErr != nil {
							return escalationErr
						}
						continue recoveryStream
					}
					return fmt.Errorf("inspect rework worker run record %s for %s: %w", stream.RunID, worker.Stream, recordErr)
				}
				if !exists {
					continue
				}
			}
			if stream.State != SchedulerReady && stream.State != SchedulerRunning {
				if err := options.store.transition(stream, SchedulerReady, "recover automatic rework", "resume the original worker session"); err != nil {
					return err
				}
			}
		case AdvanceEscalated:
			if stream.State != SchedulerAwaitingOrchestrator {
				if err := options.store.transition(stream, SchedulerAwaitingOrchestrator, "recover escalation", "inspect the persisted stream report and runner event log"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (options schedulerRunOptions) escalateUnknownRunRecord(streamName string, err error) (bool, error) {
	var unknown schedulerRunUnknownError
	if !errors.As(err, &unknown) {
		return false, nil
	}
	reason := fmt.Sprintf("run %s state is unknown: %v", unknown.RunID, unknown.Cause)
	return true, options.escalateAutoStream(streamName, "unknown-run", reason)
}

func (options schedulerRunOptions) autoTaskIsLive(task SchedulerTask, jobID string) (bool, error) {
	if task.Role == schedulerReviewRole && task.Vendor == "gem" {
		return options.jobSupervisor().RunTagActive(options.state, schedulerGemReviewTag(task))
	}
	if jobID == "" {
		return false, nil
	}
	job, err := newJobStore(options.state).Get(jobID)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read persisted job %s: %w", jobID, err)
	}
	if job.State != JobRunning {
		return false, nil
	}
	return options.jobSupervisor().RunOwnsProcess(options.state, job.RunID, job.WorkerPID, job.WorkerStartedAt)
}

func (options schedulerRunOptions) acceptAutoStream(task SchedulerTask, stream SchedulerStream) error {
	landed, _, err := options.landAccepted(task, stream)
	if err != nil {
		return options.escalateAutoStream(task.Stream, "landing-refused", "commit-only landing could not be completed: "+err.Error())
	}
	if !landed {
		return options.escalateAutoStream(task.Stream, "landing-refused", "commit-only landing did not complete")
	}
	stream, err = options.store.stream(task.Stream)
	if err != nil {
		return err
	}
	if err := options.store.advance(task.Stream, AdvanceAccepted, "all required reviews accepted", "ACCEPT", stream.Advance.TreeHash); err != nil {
		return err
	}
	stream, err = options.store.stream(task.Stream)
	if err != nil {
		return err
	}
	return options.store.transition(stream, SchedulerDone, "accepted", "commit-only landing completed")
}

func resolveExternalRunnerState(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("runner state path is empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve runner state path: %w", err)
	}
	existing := absolute
	for {
		if info, err := os.Stat(existing); err == nil {
			if !info.IsDir() {
				existing = filepath.Dir(existing)
			}
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("inspect runner state parent %s: %w", existing, err)
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", fmt.Errorf("no existing parent for runner state path %s", absolute)
		}
		existing = parent
	}
	requestedExisting := existing
	existing, err = filepath.EvalSymlinks(existing)
	if err != nil {
		return "", fmt.Errorf("resolve runner state parent: %w", err)
	}
	suffix, err := filepath.Rel(requestedExisting, absolute)
	if err != nil {
		return "", fmt.Errorf("resolve runner state path relative to its existing parent: %w", err)
	}
	canonicalPath := filepath.Join(existing, suffix)
	root, gitErr := schedulerCommandOutput(existing, "git", "-C", existing, "rev-parse", "--show-toplevel")
	if gitErr == nil {
		root, err = filepath.Abs(strings.TrimSpace(root))
		if err != nil {
			return "", fmt.Errorf("resolve Git worktree root: %w", err)
		}
		relative, relErr := filepath.Rel(root, canonicalPath)
		if relErr == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return "", runnerStateInsideWorktreeError{path: absolute, root: root}
		}
	} else {
		var exitErr *exec.ExitError
		if !errors.As(gitErr, &exitErr) {
			return "", fmt.Errorf("check runner state against Git worktree: %w", gitErr)
		}
	}
	return absolute, nil
}

type runnerStateInsideWorktreeError struct {
	path string
	root string
}

func (err runnerStateInsideWorktreeError) Error() string {
	return fmt.Sprintf("runner state %s is inside Git worktree %s", err.path, err.root)
}

func resolveRunnerState(root runnerRoot, command, path string) (string, error) {
	resolved, err := resolveExternalRunnerState(path)
	if err == nil {
		return resolved, nil
	}
	var inside runnerStateInsideWorktreeError
	if errors.As(err, &inside) {
		next := root.InvocationCommand() + " " + command + " --state " + shellQuote(defaultRunnerState())
		diagnostic, diagErr := diag.FromCatalog("KB_RUNNER_STATE_INSIDE_WORKTREE", map[string]string{"nextCommand": next}, diag.WithBinary(root.Name()))
		if diagErr != nil {
			return "", fmt.Errorf("runner state diagnostic is missing from the platform catalog: %w", diagErr)
		}
		return "", diagnostic
	}
	return "", err
}

type streamAdvanceEvent struct {
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	Stream      string `json:"stream"`
	State       string `json:"state"`
	Round       int    `json:"round,omitempty"`
	Reason      string `json:"reason,omitempty"`
	LastVerdict string `json:"last_verdict,omitempty"`
}

func validAdvanceTransition(from, to StreamAdvanceState) bool {
	switch from {
	case "":
		return to == AdvanceWorking
	case AdvanceWorking:
		return to == AdvanceVerifying || to == AdvanceEscalated
	case AdvanceVerifying:
		return to == AdvanceReviewing || to == AdvanceRework || to == AdvanceEscalated
	case AdvanceReviewing:
		return to == AdvanceAccepted || to == AdvanceRework || to == AdvanceEscalated
	case AdvanceAccepted:
		// Recovery may need to durably quarantine an accepted snapshot whose
		// persisted review evidence fails the landing gate.
		return to == AdvanceEscalated
	case AdvanceRework:
		return to == AdvanceWorking || to == AdvanceEscalated
	default:
		return false
	}
}

func (s *schedulerStore) advance(streamName string, next StreamAdvanceState, reason, verdict, treeHash string) error {
	return s.advanceWithRunID(streamName, next, reason, verdict, treeHash, "")
}

func (s *schedulerStore) advanceWithRunID(streamName string, next StreamAdvanceState, reason, verdict, treeHash, runID string) error {
	return s.withLock(func() error {
		stream, err := s.stream(streamName)
		if err != nil {
			return err
		}
		advance, err := nextAdvanceSnapshot(stream, next, reason, verdict, treeHash)
		if err != nil {
			return err
		}
		if runID != "" {
			advance.RunID = runID
		}
		if reflect.DeepEqual(stream.Advance, advance) {
			return nil
		}
		stateChanged := stream.Advance == nil || stream.Advance.State != advance.State
		stream.Advance = advance
		stream.ChangedAt = nowSchedulerUTC()
		if !stateChanged {
			return s.commitAutoTransitionLocked([]SchedulerStream{stream})
		}
		status := "progress"
		if advance.State == AdvanceAccepted || advance.State == AdvanceEscalated {
			status = string(advance.State)
		}
		kind := "scheduler.advance"
		if status == string(AdvanceAccepted) || status == string(AdvanceEscalated) {
			kind = "orchestrator.event"
		}
		event := streamAdvanceEvent{Kind: kind, Status: status, Stream: stream.Stream, State: string(advance.State), Round: advance.Round, Reason: advance.Reason, LastVerdict: advance.LastVerdict}
		return s.commitAutoTransitionLocked([]SchedulerStream{stream}, event)
	})
}

func nextAdvanceSnapshot(stream SchedulerStream, next StreamAdvanceState, reason, verdict, treeHash string) (*StreamAdvance, error) {
	previous := StreamAdvanceState("")
	if stream.Advance != nil {
		previous = stream.Advance.State
	}
	if previous != next && !validAdvanceTransition(previous, next) {
		return nil, fmt.Errorf("invalid stream advancement transition %q -> %q for %s", previous, next, stream.Stream)
	}
	advance := StreamAdvance{State: next, LastVerdict: verdict, TreeHash: treeHash, Reason: reason}
	if stream.Advance != nil {
		advance.Round = stream.Advance.Round
		advance.PartialResumes = stream.Advance.PartialResumes
		advance.HighRisk = stream.Advance.HighRisk
		advance.PreviousTreeHash = stream.Advance.PreviousTreeHash
		advance.PreviousFindings = stream.Advance.PreviousFindings
		advance.LastReviewVerdict = stream.Advance.LastReviewVerdict
		advance.LandingCommit = stream.Advance.LandingCommit
		advance.LandingExpectedRef = stream.Advance.LandingExpectedRef
		advance.RunID = stream.Advance.RunID
		if advance.TreeHash == "" {
			advance.TreeHash = stream.Advance.TreeHash
		}
		if advance.LastVerdict == "" {
			advance.LastVerdict = stream.Advance.LastVerdict
		}
		if next == AdvanceRework {
			advance.Round++
		}
	}
	if next == AdvanceRework && advance.Round > 3 {
		advance.State = AdvanceEscalated
		advance.Reason = "automatic rework limit reached: " + reason
	}
	return &advance, nil
}

func (s *schedulerStore) appendOrchestratorEvent(event streamAdvanceEvent) error {
	if event.Kind != "orchestrator.event" {
		return errors.New("orchestrator event kind is required")
	}
	switch event.Status {
	case "accepted", "escalated", "vendor-limit", "stall", "disk":
	default:
		return fmt.Errorf("unsupported orchestrator event status %q", event.Status)
	}
	stream, err := s.stream(event.Stream)
	if err != nil {
		return fmt.Errorf("read stream for orchestrator outbox event: %w", err)
	}
	return s.commitAutoTransition([]SchedulerStream{stream}, event)
}

func nowSchedulerUTC() time.Time { return time.Now().UTC() }

func streamsCommand(root runnerRoot, args []string, out io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintf(out, "Usage: %s streams [--state <dir>] [--json]\n", root.Name())
		return 0, err
	}
	fs := flag.NewFlagSet("streams", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state", defaultRunnerState(), "runner state directory")
	jsonOutput := fs.Bool("json", false, "write machine-readable stream states")
	if err := fs.Parse(args); err != nil {
		return 2, fmt.Errorf("%s streams: %w; next: %s streams --help", root.Name(), err, root.InvocationCommand())
	}
	if fs.NArg() != 0 {
		return 2, fmt.Errorf("%s streams: unexpected arguments; next: %s streams --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "streams", *state)
	if err != nil {
		return 2, fmt.Errorf("%s streams: invalid runner state path: %w; next: %s streams --help", root.Name(), err, root.InvocationCommand())
	}
	streams, err := newSchedulerStore(resolvedState).streams()
	if err != nil {
		return 1, fmt.Errorf("%s streams: %w; next: %s streams --help", root.Name(), err, root.InvocationCommand())
	}
	rows := make([]StreamAdvanceRow, 0, len(streams))
	for _, stream := range streams {
		if stream.Advance == nil {
			continue
		}
		rows = append(rows, StreamAdvanceRow{Stream: stream.Stream, State: stream.Advance.State, Round: stream.Advance.Round, LastVerdict: stream.Advance.LastVerdict, Reason: stream.Advance.Reason})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Stream < rows[j].Stream })
	if *jsonOutput {
		if err := json.NewEncoder(out).Encode(rows); err != nil {
			return 1, fmt.Errorf("%s streams: encode JSON: %w", root.Name(), err)
		}
		return 0, nil
	}
	if len(rows) == 0 {
		if _, err := fmt.Fprintf(out, "No streams. next: %s streams --help\n", root.InvocationCommand()); err != nil {
			return 1, fmt.Errorf("%s streams: write output: %w", root.Name(), err)
		}
		return 0, nil
	}
	for _, row := range rows {
		if _, err := fmt.Fprintf(out, "%s state=%s round=%d last-verdict=%s\n", row.Stream, row.State, row.Round, row.LastVerdict); err != nil {
			return 1, fmt.Errorf("%s streams: write output: %w", root.Name(), err)
		}
	}
	return 0, nil
}

type StreamAdvanceRow struct {
	Stream      string             `json:"stream"`
	State       StreamAdvanceState `json:"state"`
	Round       int                `json:"round"`
	LastVerdict string             `json:"last_verdict,omitempty"`
	Reason      string             `json:"reason,omitempty"`
}
