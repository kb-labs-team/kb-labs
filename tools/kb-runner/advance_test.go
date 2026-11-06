//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func TestAdvanceReportGateRequiresEveryDoDSection(t *testing.T) {
	report := []byte("Status: DONE\n\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n\n## Verification\n\npassed\n\n## Open issues\n\nnone\n\n## Unrequested behaviour changes\n\nnone\n\n## Debt self-scan\n\nnone\n\n## Self-review\n\ncomplete\n")
	if err := validateAdvanceReport(report); err == nil {
		t.Fatal("report without its design table heading was accepted")
	}
	report = append([]byte("Status: DONE\n\n## Design gate\n"), report[len("Status: DONE\n\n"):]...)
	if err := validateAdvanceReport(report); err != nil {
		t.Fatalf("complete report rejected: %v", err)
	}
}

func TestOutsideSuiteResultRequiresPassedModules(t *testing.T) {
	result := verifyOutsideResult{Modules: []verifyOutsideModuleResult{{Module: "runner", Log: "runner.jsonl", ExitCode: 0}}}
	if err := requireGreenOutsideResult("tree-a", result); err != nil {
		t.Fatalf("green run-owned suite result rejected: %v", err)
	}
	result.Modules[0].ExitCode = 1
	if err := requireGreenOutsideResult("tree-a", result); err == nil {
		t.Fatal("failed outside suite was accepted")
	}
}

func TestReviewVendorRoutingUsesSingleRoleTable(t *testing.T) {
	for _, test := range []struct {
		role     ReviewRole
		highRisk bool
		want     string
	}{{ReviewStandard, false, "zcode"}, {ReviewDelta, true, "gem"}, {ReviewAdversarial, false, ""}, {ReviewAdversarial, true, "gem"}, {ReviewFinal, false, ""}, {ReviewFinal, true, "codex"}} {
		got, err := reviewRouteForRole(test.role, test.highRisk)
		if err != nil || got.Vendor != test.want {
			t.Fatalf("route role=%s high-risk=%v got=%+v err=%v; want vendor %q", test.role, test.highRisk, got, err, test.want)
		}
	}
}

func TestRunnerStateMustResolveOutsideEveryWorktree(t *testing.T) {
	repo := t.TempDir()
	gitTest(t, repo, "init")
	inside := filepath.Join(repo, "logs", "runner")
	if _, err := resolveExternalRunnerState(inside); err == nil {
		t.Fatal("runner state inside a Git worktree was accepted")
	}
	alias := filepath.Join(t.TempDir(), "repo-alias")
	if err := os.Symlink(repo, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveExternalRunnerState(filepath.Join(alias, "logs", "runner")); err == nil {
		t.Fatal("runner state reached through a symlink into a Git worktree was accepted")
	}
	if err := refuseRunnerStateInTree(repo, inside, "tree"); err == nil {
		t.Fatal("commit-only landing accepted runner state inside the repository tree")
	}
	external := filepath.Join(t.TempDir(), "state")
	resolved, err := resolveExternalRunnerState(external)
	if err != nil || resolved != external {
		t.Fatalf("external state resolved=%q err=%v", resolved, err)
	}
}

func TestStateConsumingStatusRefusesRunnerStateInsideWorktreeWithCatalogDiagnostic(t *testing.T) {
	repo := t.TempDir()
	gitTest(t, repo, "init")
	inside := filepath.Join(repo, "logs", "runner")
	for _, test := range []struct {
		name string
		args []string
	}{
		{"status", []string{"status", "--state", inside}},
		{"land", []string{"land", "stream", "--state", inside}},
		{"scheduler-list", []string{"sched", "ls", "--state", inside}},
		{"run", []string{"run", "--tag", "tag", "--state", inside, "--stall", "1m", "--stdout", filepath.Join(repo, "out.log"), "--stderr", filepath.Join(repo, "err.log"), "--", "true"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			status := executeInvocation("kb-runner", test.args, &stdout, &stderr)
			if status.Code() != 2 || !strings.Contains(stderr.String(), "KB_RUNNER_STATE_INSIDE_WORKTREE") || !strings.Contains(stderr.String(), "--state") {
				t.Fatalf("state refusal exit=%d stdout=%q stderr=%q", status.Code(), stdout.String(), stderr.String())
			}
		})
	}
}

func TestGemVerdictUsesFirstVerdictLine(t *testing.T) {
	if got, ok := firstGemVerdict([]byte("comment\nVerdict: REJECT\nVerdict: ACCEPT\n")); !ok || got != "REJECT" {
		t.Fatalf("first gem verdict=%q ok=%v", got, ok)
	}
	if _, ok := firstGemVerdict([]byte("Verdict: REWORK\nVerdict: ACCEPT\n")); ok {
		t.Fatal("invalid first verdict was skipped")
	}
}

func TestAutoReviewReportRejectsTruncatedVerdictAndMissingSections(t *testing.T) {
	for _, test := range []struct {
		name   string
		report string
	}{
		{name: "verdict only", report: "Verdict: ACCEPT\n"},
		{name: "no verification", report: "Verdict: ACCEPT\n\n## Defects\n\nNone.\n"},
		{name: "no findings", report: "Verdict: ACCEPT\n\n## Verification\n\nPASS\n"},
		{name: "truncated after verification heading", report: "Verdict: ACCEPT\n\n## Defects\n\nNone.\n\n## Verification\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateAutoReviewReport([]byte(test.report)); err == nil {
				t.Fatalf("incomplete report unexpectedly accepted: %q", test.report)
			}
		})
	}
	complete := []byte("Verdict: ACCEPT\n\n## Defects\n\nNone.\n\n## Verification\n\nPASS\n")
	if err := validateAutoReviewReport(complete); err != nil {
		t.Fatalf("complete report rejected: %v", err)
	}
}

func TestCappedFileReadsOnlyConfiguredPrefix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readCappedFile(path, 32)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, bytes.Repeat([]byte("x"), 32)) || !bytes.Contains(data, []byte("truncated at source size cap")) {
		t.Fatalf("capped read did not preserve only the bounded prefix: %q", data)
	}
}

func TestStreamAdvancePersistsRoundsAndEscalatesAfterThreeReworks(t *testing.T) {
	store := newSchedulerStore(filepath.Join(t.TempDir(), "state"))
	prompt := filepath.Join(t.TempDir(), "worker.md")
	if err := os.WriteFile(prompt, []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.add(SchedulerTask{Stream: "alpha", Prompt: prompt, Workdir: t.TempDir(), RepoRoot: t.TempDir(), Base: "main", Vendor: "zcode", Effort: "medium", Role: schedulerWorkerRole, Review: "single", Reviewers: []string{"zcode"}}); err != nil {
		t.Fatal(err)
	}
	for round := 1; round <= 3; round++ {
		for _, step := range []struct {
			state   StreamAdvanceState
			verdict string
		}{
			{AdvanceWorking, ""},
			{AdvanceVerifying, ""},
			{AdvanceReviewing, ""},
			{AdvanceRework, "REJECT"},
		} {
			if err := store.advance("alpha", step.state, "review defects", step.verdict, "tree"); err != nil {
				t.Fatalf("round %d transition to %s: %v", round, step.state, err)
			}
		}
	}
	if err := store.advance("alpha", AdvanceWorking, "", "", "tree"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance("alpha", AdvanceVerifying, "", "", "tree"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance("alpha", AdvanceReviewing, "", "", "tree"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance("alpha", AdvanceRework, "fourth rejection", "REJECT", "tree"); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if stream.Advance.State != AdvanceEscalated || stream.Advance.Round != 4 || !strings.Contains(stream.Advance.Reason, "automatic rework limit") {
		t.Fatalf("fourth rework was not escalated: %+v", stream.Advance)
	}
}

func TestStreamsCommandReportsPersistedAdvancement(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state")
	store := newSchedulerStore(state)
	if err := os.MkdirAll(store.streamsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	stream := SchedulerStream{Stream: "alpha", Advance: &StreamAdvance{State: AdvanceAccepted, Round: 1, LastVerdict: "ACCEPT"}}
	if err := store.writeJSON(store.streamPath(stream.Stream), stream); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	status := executeInvocation("kb-runner", []string{"streams", "--state", state, "--json"}, &output, &bytes.Buffer{})
	if status.Code() != 0 {
		t.Fatalf("streams exit=%d output=%s", status.Code(), output.String())
	}
	var rows []StreamAdvanceRow
	if err := json.Unmarshal(output.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Stream != "alpha" || rows[0].State != AdvanceAccepted || rows[0].LastVerdict != "ACCEPT" {
		t.Fatalf("stream rows=%+v", rows)
	}
}

func TestStreamAdvanceRejectsIllegalTransitions(t *testing.T) {
	if validAdvanceTransition(AdvanceAccepted, AdvanceWorking) {
		t.Fatal("accepted stream was allowed to restart")
	}
}

func TestPromptFrontmatterDeclaresReasoningEffort(t *testing.T) {
	effort, found, err := promptEffort([]byte("---\neffort: high\n---\nTask body\n"))
	if err != nil || !found || effort != "high" {
		t.Fatalf("prompt effort=%q found=%v err=%v", effort, found, err)
	}
	effort, found, err = promptEffort([]byte("Task body without frontmatter\n"))
	if err != nil || found || effort != "" {
		t.Fatalf("undeclared prompt effort=%q found=%v err=%v", effort, found, err)
	}
	if _, _, err := promptEffort([]byte("---\neffort: urgent\n---\n")); err == nil {
		t.Fatal("invalid prompt effort was accepted")
	}
}

func TestDeltaReviewFocusIncludesPreviousFindingsAndExactTreeDiff(t *testing.T) {
	focus := deltaReviewFocus("tree-old", "## Defects\n- preserve this finding\n", "diff --git a/a.go b/a.go\n+fixed\n")
	for _, expected := range []string{"tree-old", "## Defects\n- preserve this finding", "diff --git a/a.go b/a.go", "+fixed"} {
		if !strings.Contains(focus, expected) {
			t.Fatalf("delta focus omitted %q: %s", expected, focus)
		}
	}
}

func TestReviewOutputWriterAndReaderShareRunIdentity(t *testing.T) {
	state := filepath.Join(t.TempDir(), "runner-state")
	runID := "run-123"
	want := []byte("Verdict: ACCEPT\n\n## Defects\n\nNone.\n")
	supervisor := newFakeSchedulerSupervisor()
	path, err := reviewRunReportPath(state, runID)
	if err != nil {
		t.Fatal(err)
	}
	_, stderrPath := schedulerRunOutputPaths(state, runID)
	run, err := supervisor.Start(context.Background(), proc.Config{
		StateDir: state, Tag: runID, RunID: runID, StdoutPath: path, StderrPath: stderrPath,
		Command: []string{"/bin/sh", "-c", "printf '%s' \"$1\"", "review-fixture", string(want)},
	})
	if err != nil {
		t.Fatalf("start fake review job: %v", err)
	}
	if err := run.Wait(); err != nil {
		t.Fatalf("wait for fake review job: %v", err)
	}
	path, got, err := readReviewRunOutput(supervisor, state, runID)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("review output path=%q data=%q err=%v", path, got, err)
	}
	if expected := filepath.Join(state, "jobs", runID+".review.md"); path != expected {
		t.Fatalf("review output path=%q want=%q", path, expected)
	}
}

func TestAutoReworkPromptContainsBothReviewDefectSectionsVerbatim(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "runner-state")
	workdir := filepath.Join(root, "repo")
	if err := os.MkdirAll(workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(root, "worker.md")
	if err := os.WriteFile(prompt, []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(state)
	task, err := store.add(SchedulerTask{Stream: "reviewed", Prompt: prompt, Workdir: workdir, RepoRoot: workdir, WorktreeRoot: root, Base: "main", Vendor: "zcode", Effort: "medium", Role: schedulerWorkerRole, OutsideSuites: []string{"kb-runner:./..."}})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerRunning, "agent round", "wait for worker report"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceWorking, "", "", ""); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerAwaitingReview, "review", "await reviewer"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceVerifying, "", "", "tree-a"); err != nil {
		t.Fatal(err)
	}
	if err := store.advance(task.Stream, AdvanceReviewing, "", "", "tree-a"); err != nil {
		t.Fatal(err)
	}
	first := "## Defects\n- first reviewer finding, byte exact\n"
	second := "## Findings\n- second reviewer finding, byte exact\n"
	supervisor := newFakeSchedulerSupervisor()
	var runIDs []string
	for index, report := range []string{"Verdict: REJECT\n\n" + first, "Verdict: REJECT\n\n" + second} {
		runID, err := proc.AllocateRunID()
		if err != nil {
			t.Fatal(err)
		}
		_, err = store.addWithSnapshotsAndRunID(SchedulerTask{Stream: fmt.Sprintf("reviewed-review-%d", index), PromptTemplate: runnerReviewTemplate, Workdir: workdir, WorktreeRoot: root, RepoRoot: workdir, Base: "main", Vendor: "gem", Effort: "medium", Role: schedulerReviewRole, ReviewerKind: ReviewStandard, DependsOn: []string{task.ID}}, runID, nil)
		if err != nil {
			t.Fatal(err)
		}
		runTestReviewJob(t, supervisor, state, runID, report)
		runIDs = append(runIDs, runID)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	seedSchedulerWorkerSession(t, store, &stream, "auto-rework-session")
	stream.ReviewRunIDs = runIDs
	if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
	if err := (newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: state, supervisor: supervisor})).queueAutoRework(task, "reviews rejected"); err != nil {
		t.Fatal(err)
	}
	updated, err := store.task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(updated.Prompt)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{first, second, "update .agent-report.md"} {
		if !strings.Contains(string(body), expected) {
			t.Fatalf("rework prompt omitted verbatim text %q: %s", expected, body)
		}
	}
	updatedStream, err := store.stream(task.Stream)
	if err != nil || updatedStream.Advance.PreviousFindings != first+"\n\n"+second || updatedStream.Advance.PreviousTreeHash != "tree-a" {
		t.Fatalf("persisted delta-review context=%+v err=%v", updatedStream.Advance, err)
	}
}
