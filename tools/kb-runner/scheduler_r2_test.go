//go:build darwin || linux

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const r2CommitReport = "## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): case\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): test\"},{\"kind\":\"code\",\"subject\":\"fix(kb-runner): code\"}]\n```\n"

// case: S-237.133
func TestSchedulerAutoLandRequiresEveryReviewerToAccept(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "r2-review-gate", "worker")
	task.Review, task.Reviewers = "cross", []string{"codex", "gemini"}
	if err := newSchedulerStore(f.state).updateTask(task); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Workdir, ".agent-report.md"), []byte("Status: DONE\n"+r2CommitReport), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: schedulerTestSHA, Status: "completed", Conclusion: "success"}
	stream.ReviewResults = map[string]string{"codex-1": "ACCEPT", "gemini-2": "SKIP"}
	if err := store.transition(stream, SchedulerRunning, "worker", "run worker"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "wait remote"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingReview, "reviews", "resolve reviews"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	if err := options.resolveReviewOutcome(task, stream); err != nil {
		t.Fatal(err)
	}
	got, err := store.stream(task.Stream)
	if err != nil || got.State != SchedulerAwaitingReview {
		t.Fatalf("ACCEPT+SKIP outcome=%+v err=%v; scheduler must queue an independent reviewer", got, err)
	}
	fallback, err := store.task("r2-review-gate-review-fallback-codex-gemini-2")
	if err != nil || fallback.Vendor != "codex" || fallback.ReviewerKey != "gemini-2" || fallback.Role != schedulerReviewRole {
		t.Fatalf("skipped reviewer was not requeued through another configured vendor: task=%+v err=%v", fallback, err)
	}
	calls, _ := os.ReadFile(f.gitCalls)
	if strings.Contains(string(calls), "|commit|") || strings.Contains(string(calls), "|merge|") {
		t.Fatalf("scheduler landed with a skipped required reviewer: %s", calls)
	}
}

// case: S-237.133
func TestSchedulerReviewSkipWithoutAnotherConfiguredVendorRequestsDecision(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "r2-review-unavailable", "worker")
	task.Review, task.Reviewers = "cross", []string{"zcode", "zcode"}
	if err := newSchedulerStore(f.state).updateTask(task); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.ReviewResults = map[string]string{"zcode-1": "ACCEPT", "zcode-2": "SKIP"}
	if err := store.transition(stream, SchedulerRunning, "worker", "worker done"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "wait remote"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingReview, "reviews", "resolve reviews"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := (newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})).resolveReviewOutcome(task, stream); err != nil {
		t.Fatal(err)
	}
	got, err := store.stream(task.Stream)
	if err != nil || got.State != SchedulerAwaitingOrchestrator || got.Cause != "review-unavailable" {
		t.Fatalf("review without another configured vendor=%+v err=%v", got, err)
	}
}

// case: S-237.134
func TestSchedulerSubmissionPersistsTreeAndLandIgnoresLaterWorktreeChanges(t *testing.T) {
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		command := exec.Command(realGit, append([]string{"-C", repo}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Fixture"}, {"config", "user.email", "fixture@example.test"}} {
		git(args...)
	}
	if err := os.MkdirAll(filepath.Join(repo, "tools", "kb-runner"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "tools", "kb-runner", "scheduler-policy.json"), []byte(`{"integration_branch":"agent/integration","risk_zones":["tools/kb-runner/**"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("verified\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "tracked.txt")
	git("add", "tools/kb-runner/scheduler-policy.json")
	git("commit", "-m", "chore: base")
	git("checkout", "-b", "agent/r2-tree")
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("verified change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(repo, "task.md")
	if err := os.WriteFile(prompt, []byte("worker task"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	pushCalls := filepath.Join(t.TempDir(), "push.calls")
	shim := "#!/bin/sh\nargs=\"$*\"\ncase \"$args\" in *' push backup '*) printf '%s\\n' \"$args\" >> \"$FAKE_PUSH_CALLS\"; exit 0 ;; esac\nexec \"$REAL_GIT\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("REAL_GIT", realGit)
	t.Setenv("FAKE_PUSH_CALLS", pushCalls)
	t.Setenv("FAKE_BACKUP_REMOTE", "https://github.com/kb-labs/backup.git")
	state := filepath.Join(t.TempDir(), "state")
	worktrees := filepath.Join(t.TempDir(), "worktrees")
	if err := os.WriteFile(filepath.Join(repo, ".agent-report.md"), []byte("Status: DONE\n"+r2CommitReport), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(state)
	task, err := store.add(SchedulerTask{ID: "r2-tree", Stream: "r2-tree", Prompt: prompt, Workdir: repo, RepoRoot: repo, WorktreeRoot: worktrees, Base: "main", Vendor: "codex", Effort: "high", Role: schedulerWorkerRole, Review: "cross", Reviewers: []string{"codex", "gemini"}})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: state})
	submission, err := options.submit(task, stream)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(submission)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	verifiedTree, ok := fields["tree_sha"].(string)
	if !ok || verifiedTree == "" {
		t.Fatalf("remote submission did not persist its tree id: %s", encoded)
	}
	stream, _ = store.stream(task.Stream)
	stream.Submission = &submission
	if err := store.transition(stream, SchedulerRunning, "worker", "worker done"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "wait remote"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	stream.ReviewResults = map[string]string{"codex-1": "ACCEPT", "gemini-2": "ACCEPT"}
	if err := store.transition(stream, SchedulerAwaitingReview, "review", "accepted"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "tracked.txt"), []byte("edit after verification\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	landed, _, err := options.landAccepted(task, stream)
	if err != nil || !landed {
		t.Fatalf("immutable landing failed: landed=%t err=%v", landed, err)
	}
	got, err := store.stream(task.Stream)
	if err != nil || got.State != SchedulerAwaitingRemote || got.Submission.Purpose != "candidate" {
		t.Fatalf("candidate was not submitted after immutable landing: %+v err=%v", got, err)
	}
	if gotSHA := git("rev-parse", "HEAD"); gotSHA == submission.ExpectedRefSHA {
		t.Fatalf("landing did not move the worker branch to its immutable grouped commit: %s", gotSHA)
	}
	if committedTree, err := treeSHAForCommit(repo, git("rev-parse", "HEAD")); err != nil {
		t.Fatalf("read landed worker branch tree: %v", err)
	} else if equal, err := landingTreesEqualWithoutStreamReports(repo, committedTree.String(), verifiedTree); err != nil || !equal {
		t.Fatalf("worker branch differs from verified tree outside report artifacts: tree=%s verified=%s equal=%t err=%v", committedTree, verifiedTree, equal, err)
	} else if entries, err := landingTreeEntries(repo, committedTree.String()); err != nil {
		t.Fatalf("read landed worker branch entries: %v", err)
	} else if _, exists := entries[".agent-report.md"]; exists {
		t.Fatal("landed worker branch contains the stream report artifact")
	}
	worktreeBytes, err := os.ReadFile(filepath.Join(repo, "tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(worktreeBytes); got != "edit after verification\n" {
		t.Fatalf("refresh rewrote worker worktree files: %q", got)
	}
	if _, err := exec.Command(realGit, "-C", repo, "diff", "--cached", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("worker index was not refreshed to landed commit: %v", err)
	}
	integration := filepath.Join(worktrees, "integration")
	if got := gitFrom(t, realGit, integration, "show", "HEAD:tracked.txt"); got != "verified change" {
		t.Fatalf("integration contains post-verification edit: %q", got)
	}
}

// case: S-237.135
func TestSchedulerStateDirectoryRejectsTasksFromAnotherRepository(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	first := f.addTask(t, "r2-repo-first", "worker")
	f.addAwaitingRemote(t, first, SchedulerSubmission{SHA: schedulerTestSHA, Ref: "verify/r2-repo-first-0123456", RunID: "71"})
	otherRepo := t.TempDir()
	prompt := filepath.Join(otherRepo, "task.md")
	if err := os.WriteFile(prompt, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	_, err := store.add(SchedulerTask{ID: "r2-repo-second", Stream: "r2-repo-second", Prompt: prompt, Workdir: filepath.Join(f.worktrees, "r2-repo-second"), RepoRoot: otherRepo, WorktreeRoot: f.worktrees, Base: "main", Vendor: "codex", Effort: "high", Role: schedulerWorkerRole, Review: "single", Reviewers: []string{"codex"}})
	if err == nil || !strings.Contains(err.Error(), f.repo) || !strings.Contains(err.Error(), otherRepo) {
		t.Fatalf("second repository task was not refused with both roots; err=%v", err)
	}
	if _, err := store.task("r2-repo-second"); !os.IsNotExist(err) {
		t.Fatalf("refused task was persisted: %v", err)
	}
	if err := (newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{}, state: f.state, supervisor: f.supervisor})).watchRemote(t.Context()); err != nil {
		t.Fatal(err)
	}
	ghCalls, err := os.ReadFile(f.ghCalls)
	if err != nil || !strings.Contains(string(ghCalls), "run list --repo kb-labs/backup") {
		t.Fatalf("remote watcher did not use the state repository binding: calls=%q err=%v", ghCalls, err)
	}
	data, err := os.ReadFile(filepath.Join(f.state, "sched", "repository.json"))
	if err != nil || !bytes.Contains(data, []byte(f.repo)) {
		t.Fatalf("first repository binding was not persisted: %s err=%v", data, err)
	}
}
