//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
)

// case: S-237.136
func TestLandingCommitObjectsExcludePostVerificationWorktreeEdits(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*testing.T, string)
	}{
		{name: "tracked", edit: func(t *testing.T, repo string) {
			if err := os.WriteFile(filepath.Join(repo, "src.go"), []byte("after verification\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "untracked", edit: func(t *testing.T, repo string) {
			if err := os.WriteFile(filepath.Join(repo, "late.txt"), []byte("after verification\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo, git := newImmutableLandRepo(t)
			if err := os.WriteFile(filepath.Join(repo, "src.go"), []byte("verified change\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "immutable-"+test.name)
			if err != nil {
				t.Fatal(err)
			}
			verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
			if err != nil {
				t.Fatal(err)
			}
			test.edit(t, repo)
			commits := []proposedCommit{{Kind: "case", Subject: "docs(qa): case"}, {Kind: "tests", Subject: "test(kb-runner): tests"}, {Kind: "code", Subject: "fix(kb-runner): code"}}
			object, err := buildLandingObjects(filesystemRunnerStateStore{}, repo, "immutable-"+test.name, verifiedTree.String(), git("rev-parse", "HEAD"), commits, t.TempDir(), "kb-runner land immutable --state /tmp/state")
			if err != nil || object.TreeSHA != verifiedTree {
				t.Fatalf("landing object included post-verification %s edit: commit=%s tree=%s verified tree=%s err=%v", test.name, object.CommitSHA, object.TreeSHA, verifiedTree, err)
			}
		})
	}
}

// case: S-237.149
func TestOrphanLandingCommitObjectsAreReusedOrRemainUnreachable(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	base := git("rev-parse", "HEAD")
	stream := "orphan-landing"
	git("update-ref", "refs/heads/agent/"+stream, base)
	for path, body := range map[string]string{
		"docs/qa/scenarios/S-237-orphan-landing.md": "case update\n",
		"tools/kb-runner/orphan_landing_test.go":    "package main\n",
		"src.go":                                    "verified source\n",
	} {
		absolute := filepath.Join(repo, path)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	git("add", "-A")
	git("commit", "-m", "fixture: verified worktree")
	verifiedTree, err := treeSHAForCommit(repo, git("rev-parse", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	commits := []proposedCommit{{Kind: "case", Subject: "docs(qa): add landing case"}, {Kind: "tests", Subject: "test(kb-runner): prove orphan recovery"}, {Kind: "code", Subject: "fix(kb-runner): reuse accepted identity"}}
	stateIO := filesystemRunnerStateStore{}
	first, err := buildLandingObjects(stateIO, repo, stream, verifiedTree.String(), base, commits, t.TempDir(), "kb-runner land orphan-landing --state /tmp/state")
	if err != nil {
		t.Fatal(err)
	}
	if got := git("rev-parse", "refs/heads/agent/"+stream); got != base {
		t.Fatalf("commit-tree side effect moved the landing ref before identity persistence: %s", got)
	}
	second, err := buildLandingObjects(stateIO, repo, stream, verifiedTree.String(), base, commits, t.TempDir(), "kb-runner land orphan-landing --state /tmp/state")
	if err != nil {
		t.Fatal(err)
	}
	if first.TreeSHA != verifiedTree || second.TreeSHA != verifiedTree {
		t.Fatalf("orphan or recovered commit tree differs from accepted tree: first=%+v second=%+v", first, second)
	}
	for _, object := range []landingObject{first, second} {
		if got := git("cat-file", "-t", object.CommitSHA.String()); got != "commit" {
			t.Fatalf("commit-tree object %s is missing after restart boundary: type=%s", object.CommitSHA, got)
		}
	}
	if err := moveLandingRef(stateIO, repo, stream, second, base); err != nil {
		t.Fatal(err)
	}
	landed := git("rev-parse", "refs/heads/agent/"+stream)
	if landed != second.CommitSHA.String() || treeSHAForCommitMust(t, repo, landed) != verifiedTree.String() {
		t.Fatalf("landing ref does not identify the recovered commit tree: ref=%s object=%+v", landed, second)
	}
	if got := git("rev-list", "--count", base+".."+landed); got != "3" {
		t.Fatalf("accepted branch contains %s commits after base, want one case/tests/code set", got)
	}
	if first.CommitSHA != second.CommitSHA {
		if ancestor := exec.Command("git", "-C", repo, "merge-base", "--is-ancestor", first.CommitSHA.String(), landed); ancestor.Run() == nil {
			t.Fatalf("unidentified orphan commit %s became part of the landed history", first.CommitSHA)
		}
		unreachable := git("fsck", "--unreachable", "--no-reflogs")
		if !strings.Contains(unreachable, first.CommitSHA.String()) {
			t.Fatalf("orphan commit %s is neither reused nor recorded as unreachable: %s", first.CommitSHA, unreachable)
		}
	}
}

func treeSHAForCommitMust(t *testing.T, repo, commit string) string {
	t.Helper()
	tree, err := treeSHAForCommit(repo, commit)
	if err != nil {
		t.Fatal(err)
	}
	return tree.String()
}

// case: S-237.149
func TestAutoAdvanceCommitOnlyLandingKeepsIntegrationBranchUntouched(t *testing.T) {
	for _, crashPoint := range []string{"before landing", "after ref move", "after accepted event"} {
		t.Run(crashPoint, func(t *testing.T) {
			fixture := newAutoCommitLandingFixture(t, "auto-commit-only")
			switch crashPoint {
			case "before landing":
				// The last required review has durably accepted; LandingCommit is absent.
			case "after ref move":
				fixture.persistLandingIntent(t)
				if err := moveLandingRef(filesystemRunnerStateStore{}, fixture.repo, fixture.stream, fixture.object, fixture.oldRef); err != nil {
					t.Fatal(err)
				}
			case "after accepted event":
				fixture.persistLandingIntent(t)
				if err := moveLandingRef(filesystemRunnerStateStore{}, fixture.repo, fixture.stream, fixture.object, fixture.oldRef); err != nil {
					t.Fatal(err)
				}
				if err := refreshLandingWorktree(filesystemRunnerStateStore{}, fixture.repo, fixture.repo, fixture.object.CommitSHA.String()); err != nil {
					t.Fatal(err)
				}
				if err := fixture.store.advance(fixture.stream, AdvanceAccepted, "all required reviews accepted", "ACCEPT", fixture.tree); err != nil {
					t.Fatal(err)
				}
			}
			fixture.recoverAndAssertExactlyOnce(t)
		})
	}
}

func TestAutoAdvanceCommitOnlyLandingWithoutAcceptedReviewsEscalates(t *testing.T) {
	fixture := newAutoCommitLandingFixture(t, "auto-commit-only-refused")
	fixture.persistLandingIntent(t)
	stream, err := fixture.store.stream(fixture.stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.ReviewResults = nil
	stream.Advance.State = AdvanceAccepted
	if err := fixture.store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}

	if err := fixture.options.recoverAutoStreams(); err != nil {
		t.Fatal(err)
	}
	got, err := fixture.store.stream(fixture.stream)
	if err != nil || got.State != SchedulerAwaitingOrchestrator || got.Advance.State != AdvanceEscalated || got.Cause != "landing-refused" {
		t.Fatalf("invalid accepted state was not durably escalated: stream=%+v err=%v", got, err)
	}
	if gotRef := fixture.git("rev-parse", "refs/heads/agent/"+fixture.stream); gotRef != fixture.oldRef {
		t.Fatalf("invalid accepted state moved worker ref: got=%s want=%s", gotRef, fixture.oldRef)
	}
	events, err := os.ReadFile(filepath.Join(fixture.store.dir, "events.jsonl"))
	if err != nil || strings.Contains(string(events), `"status":"accepted"`) || strings.Count(string(events), `"status":"escalated"`) != 1 {
		t.Fatalf("invalid accepted state emitted acceptance or missed escalation: events=%s err=%v", events, err)
	}
}

type autoCommitLandingFixture struct {
	repo    string
	state   string
	stream  string
	base    string
	oldRef  string
	tree    string
	git     func(...string) string
	task    SchedulerTask
	store   *schedulerStore
	options schedulerRunOptions
	object  landingObject
}

func newAutoCommitLandingFixture(t *testing.T, stream string) *autoCommitLandingFixture {
	t.Helper()
	repo, git := newImmutableLandRepo(t)
	base := git("rev-parse", "HEAD")
	git("checkout", "-b", "agent/"+stream)
	for path, body := range map[string]string{
		"docs/qa/scenarios/S-237-auto-advance.md": "case\n",
		"tools/kb-runner/lifecycle_test.go":       "test\n",
		"tools/kb-runner/lifecycle.go":            "code\n",
	} {
		absolute := filepath.Join(repo, path)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	report := "Status: DONE\n\n## Design gate\n| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |\n|---|---|---|---|\n| cause | owner | contract | owner |\n\n## Verification\nPASS\n\n## Open issues\nNone\n\n## Unrequested behaviour changes\nNone\n\n## Debt self-scan\nNone\n\n## Self-review\nComplete\n\n## Proposed commits\n```json\n[{\"kind\":\"case\",\"subject\":\"docs(qa): add auto-advance case\",\"body\":\"\"},{\"kind\":\"tests\",\"subject\":\"test(kb-runner): cover auto landing\",\"body\":\"\"},{\"kind\":\"code\",\"subject\":\"feat(kb-runner): auto advance\",\"body\":\"\"}]\n```\n"
	if err := os.WriteFile(filepath.Join(repo, ".agent-report.md"), []byte(report), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "docs/qa/scenarios/S-237-auto-advance.md", "tools/kb-runner/lifecycle_test.go", "tools/kb-runner/lifecycle.go", ".agent-report.md")
	git("commit", "-m", "work: verified stream tree")
	oldRef := git("rev-parse", "refs/heads/agent/"+stream)
	verified := git("rev-parse", "HEAD")
	tree, err := treeSHAForCommit(repo, verified)
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	prompt := filepath.Join(t.TempDir(), "worker.md")
	if err := os.WriteFile(prompt, []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	task := SchedulerTask{ID: stream, Stream: stream, Prompt: prompt, Workdir: repo, RepoRoot: repo, WorktreeRoot: t.TempDir(), Base: base, Vendor: "zcode", Effort: "medium", Role: schedulerWorkerRole, OutsideSuites: []string{"kb-runner:./..."}}
	store := newSchedulerStore(state)
	if _, err := store.add(task); err != nil {
		t.Fatal(err)
	}
	streamState, err := store.stream(stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(streamState, SchedulerRunning, "fixture worker completed", "review verified tree"); err != nil {
		t.Fatal(err)
	}
	streamState, _ = store.stream(stream)
	if err := store.transition(streamState, SchedulerAwaitingReview, "review task", "run the READY review task"); err != nil {
		t.Fatal(err)
	}
	for _, next := range []StreamAdvanceState{AdvanceWorking, AdvanceVerifying, AdvanceReviewing} {
		if err := store.advance(stream, next, "", "", tree.String()); err != nil {
			t.Fatal(err)
		}
	}
	streamState, err = store.stream(stream)
	if err != nil {
		t.Fatal(err)
	}
	streamState.ReviewResults = map[string]string{string(ReviewStandard): "ACCEPT"}
	streamState.Advance.LastVerdict = "ACCEPT"
	streamState.Advance.LastReviewVerdict = "ACCEPT"
	if err := store.commitAutoTransition([]SchedulerStream{streamState}); err != nil {
		t.Fatal(err)
	}
	commits := []proposedCommit{{Kind: "case", Subject: "docs(qa): add auto-advance case"}, {Kind: "tests", Subject: "test(kb-runner): cover auto landing"}, {Kind: "code", Subject: "feat(kb-runner): auto advance"}}
	object, err := buildLandingObjects(filesystemRunnerStateStore{}, repo, stream, tree.String(), base, commits, t.TempDir(), "kb-runner land auto-commit-only --state /tmp/state")
	if err != nil {
		t.Fatal(err)
	}
	return &autoCommitLandingFixture{repo: repo, state: state, stream: stream, base: base, oldRef: oldRef, tree: tree.String(), git: git, task: task, store: store, options: newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: state}), object: object}
}

func (fixture *autoCommitLandingFixture) persistLandingIntent(t *testing.T) {
	t.Helper()
	stream, err := fixture.store.stream(fixture.stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Advance.LandingCommit = fixture.object.CommitSHA.String()
	stream.Advance.LandingExpectedRef = fixture.oldRef
	if err := fixture.store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
		t.Fatal(err)
	}
}

func (fixture *autoCommitLandingFixture) recoverAndAssertExactlyOnce(t *testing.T) {
	t.Helper()
	if err := fixture.options.recoverAutoStreams(); err != nil {
		t.Fatalf("recovery: %v", err)
	}
	if err := fixture.options.recoverAutoStreams(); err != nil {
		t.Fatalf("repeated recovery: %v", err)
	}
	stream, err := fixture.store.stream(fixture.stream)
	if err != nil || stream.State != SchedulerDone || stream.Advance.State != AdvanceAccepted {
		t.Fatalf("landing did not converge: stream=%+v err=%v", stream, err)
	}
	commit := fixture.git("rev-parse", "refs/heads/agent/"+fixture.stream)
	landedTree := treeSHAForCommitMust(t, fixture.repo, commit)
	contentMatches, compareErr := landingTreesEqualWithoutStreamReports(fixture.repo, landedTree, fixture.tree)
	if fixture.git("rev-parse", "HEAD") != commit || compareErr != nil || !contentMatches {
		t.Fatalf("landing ref/worktree mismatch: ref=%s worktree=%s tree=%s want verified content tree=%s equal=%t err=%v", commit, fixture.git("rev-parse", "HEAD"), landedTree, fixture.tree, contentMatches, compareErr)
	}
	if _, err := schedulerCommandOutput(fixture.repo, "git", "-C", fixture.repo, "cat-file", "-e", commit+":.agent-report.md"); err == nil {
		t.Fatal("archived worker report remained in landed commit tree")
	}
	if got := fixture.git("rev-parse", "refs/heads/main"); got != fixture.base {
		t.Fatalf("integration branch moved from %s to %s", fixture.base, got)
	}
	commits := strings.Split(strings.TrimSpace(fixture.git("rev-list", "--reverse", "--parents", fixture.base+".."+commit)), "\n")
	if len(commits) != 3 {
		t.Fatalf("commit-only landing has %d commits after base, want case/tests/code: %q", len(commits), commits)
	}
	subjects := strings.Split(fixture.git("log", "--reverse", "--format=%s", fixture.base+".."+commit), "\n")
	wantSubjects := []string{"docs(qa): add auto-advance case", "test(kb-runner): cover auto landing", "feat(kb-runner): auto advance"}
	if strings.Join(subjects, "\n") != strings.Join(wantSubjects, "\n") {
		t.Fatalf("commit-only landing order=%q want=%q", subjects, wantSubjects)
	}
	for _, entry := range commits {
		if len(strings.Fields(entry)) != 2 {
			t.Fatalf("landing commit is not single-parent: %q", entry)
		}
	}
	events, err := os.ReadFile(filepath.Join(fixture.store.dir, "events.jsonl"))
	if err != nil || strings.Count(string(events), `"status":"accepted"`) != 1 {
		t.Fatalf("accepted event count=%d events=%s err=%v", strings.Count(string(events), `"status":"accepted"`), events, err)
	}
}

// case: S-237.149
func TestAcceptedTreeContainingRunnerStateFileIsRefused(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	state := filepath.Join(repo, "logs", "runner")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "streams.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "logs/runner/streams.json")
	git("commit", "-m", "fixture: state file in accepted tree")
	tree, err := treeSHAForCommit(repo, git("rev-parse", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	if err := refuseRunnerStateInTree(repo, state, tree.String()); err == nil {
		t.Fatal("accepted tree containing a runner state file was allowed to land")
	}
}

// case: S-237.136
func TestSchedulerMergeUsesImmutableLandingCommitAfterBranchAmendment(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "tools", "kb-runner", "scheduler-policy.json"), []byte(`{"integration_branch":"agent/integration","risk_zones":["tools/kb-runner/**"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "tools/kb-runner/scheduler-policy.json")
	git("commit", "-m", "chore: scheduler policy")
	git("checkout", "-b", "agent/immutable-merge")
	if err := os.WriteFile(filepath.Join(repo, "feature.txt"), []byte("verified feature\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".agent-report.md"), []byte("Status: DONE\n"+r2CommitReport), 0o600); err != nil {
		t.Fatal(err)
	}
	expectedOld := git("rev-parse", "HEAD")
	verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "immutable-merge")
	if err != nil {
		t.Fatal(err)
	}
	verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	git("checkout", "-b", "fixture-intruder")
	if err := os.WriteFile(filepath.Join(repo, "intruder.txt"), []byte("must not merge\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "intruder.txt")
	git("commit", "-m", "chore: concurrent amendment")
	intruderSHA := git("rev-parse", "HEAD")
	git("checkout", "agent/immutable-merge")
	if err := os.Remove(filepath.Join(repo, "intruder.txt")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}

	bin := t.TempDir()
	pushCalls := filepath.Join(t.TempDir(), "push.calls")
	shim := `#!/bin/sh
case " $* " in
  *" merge-tree --write-tree "*) "$REAL_GIT" -C "$LAND_REPO" update-ref refs/heads/agent/immutable-merge "$INTRUDER_SHA" ;;
  *" push backup "*) printf '%s\n' "$*" >> "$LAND_PUSH_CALLS"; exit 0 ;;
esac
exec "$REAL_GIT" "$@"
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("REAL_GIT", gitPath)
	t.Setenv("LAND_REPO", repo)
	t.Setenv("INTRUDER_SHA", intruderSHA)
	t.Setenv("LAND_PUSH_CALLS", pushCalls)
	if _, err := exec.Command(gitPath, "-C", repo, "remote", "add", "backup", "https://github.com/kb-labs/backup.git").CombinedOutput(); err != nil {
		t.Fatal(err)
	}

	worktrees := t.TempDir()
	state := t.TempDir()
	prompt := filepath.Join(t.TempDir(), "prompt.md")
	if err := os.WriteFile(prompt, []byte("worker prompt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	task, err := newSchedulerStore(state).add(SchedulerTask{ID: "immutable-merge", Stream: "immutable-merge", Prompt: prompt, Workdir: repo, RepoRoot: repo, WorktreeRoot: worktrees, Base: "main", Vendor: "codex", Effort: "high", Role: schedulerWorkerRole, Review: "single", Reviewers: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: verifiedSHA.String(), TreeSHA: verifiedTree.String(), ExpectedRefSHA: expectedOld, Status: "completed", Conclusion: "success"}
	stream.ReviewResults = map[string]string{"codex": "ACCEPT"}
	if err := store.transition(stream, SchedulerRunning, "worker", "worker done"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "remote passed"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingReview, "review", "review accepted"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	landed, mergeSHA, err := (newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: state})).landAccepted(task, stream)
	if err != nil || !landed {
		t.Fatalf("immutable landing failed: landed=%t err=%v", landed, err)
	}
	integration := filepath.Join(worktrees, "integration")
	if _, err := os.Stat(integration); err != nil {
		t.Fatal(err)
	}
	mergedTree, err := treeSHAForCommit(integration, mergeSHA)
	contentMatches, compareErr := landingTreesEqualWithoutStreamReports(integration, mergedTree.String(), verifiedTree.String())
	if err != nil || compareErr != nil || !contentMatches {
		t.Fatalf("integration merged a mutable branch amendment: merged tree=%s verified content tree=%s equal=%t err=%v compare err=%v", mergedTree, verifiedTree, contentMatches, err, compareErr)
	}
	if _, err := schedulerCommandOutput(integration, "git", "-C", integration, "cat-file", "-e", mergeSHA+":.agent-report.md"); err == nil {
		t.Fatal("integration landing retained the worker report in the commit tree")
	}
	stream, err = store.stream(task.Stream)
	if err != nil || stream.Submission == nil || stream.Submission.SHA != mergeSHA {
		t.Fatalf("candidate submission did not retain the exact immutable merge SHA: stream=%+v merge=%s err=%v", stream, mergeSHA, err)
	}
	pushed, err := os.ReadFile(pushCalls)
	if err != nil || !strings.Contains(string(pushed), "push backup "+mergeSHA+":refs/heads/verify/candidate-immutable-merge-") {
		t.Fatalf("candidate did not push the exact landing merge SHA: calls=%q merge=%s err=%v", pushed, mergeSHA, err)
	}
	if _, err := os.Stat(filepath.Join(integration, "intruder.txt")); !os.IsNotExist(err) {
		t.Fatalf("integration contains post-commit branch amendment: stat err=%v", err)
	}
	if current := git("rev-parse", "refs/heads/agent/immutable-merge"); current != intruderSHA {
		t.Fatalf("test interleave did not amend the worker ref; ref=%s want %s", current, intruderSHA)
	}
}

// case: S-237.136
func TestLandingRefCompareAndSwapRefusesAmendmentAndResubmits(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "tools", "kb-runner", "scheduler-policy.json"), []byte(`{"integration_branch":"agent/integration","risk_zones":["tools/kb-runner/**"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "tools/kb-runner/scheduler-policy.json")
	git("commit", "-m", "chore: scheduler policy")
	git("checkout", "-b", "agent/immutable-cas")
	if err := os.WriteFile(filepath.Join(repo, "feature.txt"), []byte("verified feature\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".agent-report.md"), []byte("Status: DONE\n"+r2CommitReport), 0o600); err != nil {
		t.Fatal(err)
	}
	expectedOld := git("rev-parse", "HEAD")
	verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "immutable-cas")
	if err != nil {
		t.Fatal(err)
	}
	verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	git("checkout", "-b", "fixture-cas-intruder")
	if err := os.WriteFile(filepath.Join(repo, "intruder.txt"), []byte("concurrent ref change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "intruder.txt")
	git("commit", "-m", "chore: concurrent ref change")
	intruderSHA := git("rev-parse", "HEAD")
	git("checkout", "agent/immutable-cas")
	if err := os.Remove(filepath.Join(repo, "intruder.txt")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}

	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	pushCalls := filepath.Join(t.TempDir(), "push.calls")
	shim := `#!/bin/sh
case " $* " in
  *" update-ref refs/heads/agent/immutable-cas "*)
    if [ "${LAND_CAS_RACE_DONE:-0}" = 0 ]; then
      "$REAL_GIT" -C "$LAND_REPO" update-ref refs/heads/agent/immutable-cas "$INTRUDER_SHA"
      export LAND_CAS_RACE_DONE=1
    fi ;;
  *" push backup "*) printf '%s\n' "$*" >> "$LAND_PUSH_CALLS"; exit 0 ;;
esac
exec "$REAL_GIT" "$@"
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("REAL_GIT", gitPath)
	t.Setenv("LAND_REPO", repo)
	t.Setenv("INTRUDER_SHA", intruderSHA)
	t.Setenv("LAND_PUSH_CALLS", pushCalls)
	if _, err := exec.Command(gitPath, "-C", repo, "remote", "add", "backup", "https://github.com/kb-labs/backup.git").CombinedOutput(); err != nil {
		t.Fatal(err)
	}

	state, worktrees := t.TempDir(), t.TempDir()
	prompt := filepath.Join(t.TempDir(), "prompt.md")
	if err := os.WriteFile(prompt, []byte("worker prompt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	task, err := newSchedulerStore(state).add(SchedulerTask{ID: "immutable-cas", Stream: "immutable-cas", Prompt: prompt, Workdir: repo, RepoRoot: repo, WorktreeRoot: worktrees, Base: "main", Vendor: "codex", Effort: "high", Role: schedulerWorkerRole, Review: "single", Reviewers: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: verifiedSHA.String(), TreeSHA: verifiedTree.String(), ExpectedRefSHA: expectedOld, Status: "completed", Conclusion: "success"}
	stream.ReviewResults = map[string]string{"codex": "ACCEPT"}
	if err := store.transition(stream, SchedulerRunning, "worker", "worker done"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "remote passed"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingReview, "review", "review accepted"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	landed, _, err := (newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: state})).landAccepted(task, stream)
	if err != nil || landed {
		t.Fatalf("compare-and-swap race should queue fresh verification: landed=%t err=%v", landed, err)
	}
	got, err := store.stream(task.Stream)
	if err != nil || got.State != SchedulerAwaitingRemote || got.Cause != "tree-changed-after-verify" || got.Submission.SHA != intruderSHA || len(got.ReviewResults) != 0 {
		t.Fatalf("CAS refusal did not start a fresh immutable verification: stream=%+v err=%v", got, err)
	}
	if branch := git("rev-parse", "refs/heads/agent/immutable-cas"); branch != intruderSHA {
		t.Fatalf("failed CAS partially moved the worker ref: %s != %s", branch, intruderSHA)
	}
	if _, err := os.Stat(filepath.Join(worktrees, "integration")); !os.IsNotExist(err) {
		t.Fatalf("CAS refusal proceeded to integration merge: %v", err)
	}
	pushed, err := os.ReadFile(pushCalls)
	if err != nil || !strings.Contains(string(pushed), intruderSHA) {
		t.Fatalf("CAS refusal did not submit the amended immutable commit: calls=%q err=%v", pushed, err)
	}
}

// case: S-237.136
func TestIntegrationCASRefusesConcurrentAdvanceWithoutPushingIt(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "tools", "kb-runner", "scheduler-policy.json"), []byte(`{"integration_branch":"agent/integration","risk_zones":["tools/kb-runner/**"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "tools/kb-runner/scheduler-policy.json")
	git("commit", "-m", "chore: scheduler policy")
	git("checkout", "-b", "agent/integration-cas")
	if err := os.WriteFile(filepath.Join(repo, "feature.txt"), []byte("verified feature\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".agent-report.md"), []byte("Status: DONE\n"+r2CommitReport), 0o600); err != nil {
		t.Fatal(err)
	}
	expectedWorker := git("rev-parse", "HEAD")
	verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "integration-cas")
	if err != nil {
		t.Fatal(err)
	}
	verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	integrationOld := git("rev-parse", "HEAD")
	git("checkout", "-b", "fixture-integration-intruder")
	if err := os.WriteFile(filepath.Join(repo, "intruder.txt"), []byte("concurrent integration change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git("add", "intruder.txt")
	git("commit", "-m", "chore: concurrent integration commit")
	intruderSHA := git("rev-parse", "HEAD")
	git("checkout", "agent/integration-cas")
	if err := os.Remove(filepath.Join(repo, "intruder.txt")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}

	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	pushCalls := filepath.Join(t.TempDir(), "push.calls")
	shim := `#!/bin/sh
case " $* " in
  *" -C $LAND_INTEGRATION update-ref refs/heads/agent/integration "*)
    "$REAL_GIT" -C "$LAND_REPO" update-ref refs/heads/agent/integration "$INTRUDER_SHA"
    ;;
  *" push backup "*) printf '%s\n' "$*" >> "$LAND_PUSH_CALLS"; exit 0 ;;
esac
exec "$REAL_GIT" "$@"
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("REAL_GIT", gitPath)
	t.Setenv("LAND_REPO", repo)
	t.Setenv("INTRUDER_SHA", intruderSHA)
	t.Setenv("LAND_PUSH_CALLS", pushCalls)
	if _, err := exec.Command(gitPath, "-C", repo, "remote", "add", "backup", "https://github.com/kb-labs/backup.git").CombinedOutput(); err != nil {
		t.Fatal(err)
	}

	worktrees, state := t.TempDir(), t.TempDir()
	t.Setenv("LAND_INTEGRATION", filepath.Join(worktrees, "integration"))
	prompt := filepath.Join(t.TempDir(), "prompt.md")
	if err := os.WriteFile(prompt, []byte("worker prompt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	task, err := newSchedulerStore(state).add(SchedulerTask{ID: "integration-cas", Stream: "integration-cas", Prompt: prompt, Workdir: repo, RepoRoot: repo, WorktreeRoot: worktrees, Base: "main", Vendor: "codex", Effort: "high", Role: schedulerWorkerRole, Review: "single", Reviewers: []string{"codex"}})
	if err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: verifiedSHA.String(), TreeSHA: verifiedTree.String(), ExpectedRefSHA: expectedWorker, Status: "completed", Conclusion: "success"}
	stream.ReviewResults = map[string]string{"codex": "ACCEPT"}
	if err := store.transition(stream, SchedulerRunning, "worker", "worker done"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "remote passed"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	if err := store.transition(stream, SchedulerAwaitingReview, "review", "review accepted"); err != nil {
		t.Fatal(err)
	}
	stream, _ = store.stream(task.Stream)
	landed, mergeSHA, err := (newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: state})).landAccepted(task, stream)
	var conflict *integrationRefConflict
	if !errors.As(err, &conflict) || landed {
		t.Fatalf("integration compare-and-swap race should refuse landing: landed=%t err=%v", landed, err)
	}
	if conflict.Expected != integrationOld || conflict.Ref != "refs/heads/agent/integration" {
		t.Fatalf("typed CAS refusal lost the captured integration identity: conflict=%+v expected old=%s", conflict, integrationOld)
	}
	if mergeSHA != "" {
		t.Fatalf("refused landing returned merge SHA %s", mergeSHA)
	}
	if branch := git("rev-parse", "refs/heads/agent/integration"); branch != intruderSHA {
		t.Fatalf("integration CAS overwrote concurrent commit: branch=%s want=%s", branch, intruderSHA)
	}
	if got, readErr := os.ReadFile(pushCalls); !os.IsNotExist(readErr) || len(got) != 0 {
		t.Fatalf("candidate or bisect push occurred after integration CAS refusal: calls=%q err=%v", got, readErr)
	}
	stream, err = store.stream(task.Stream)
	if err != nil || stream.State != SchedulerReady {
		t.Fatalf("integration CAS refusal did not return stream to READY: stream=%+v err=%v", stream, err)
	}
}

// case: S-237.123
func TestLandingArchivesVerifiedReportFilesOutsideCommitTree(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	for path, body := range map[string]string{"src.go": "verified change\n", ".agent-report.md": "worker report\n", ".review-report.adversarial.md": "review report\n"} {
		if err := os.WriteFile(filepath.Join(repo, path), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "report-artifacts")
	if err != nil {
		t.Fatal(err)
	}
	verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	commits := []proposedCommit{{Kind: "case", Subject: "docs(qa): case"}, {Kind: "tests", Subject: "test(kb-runner): tests"}, {Kind: "code", Subject: "fix(kb-runner): code"}}
	object, err := buildLandingObjects(filesystemRunnerStateStore{}, repo, "report-artifacts", verifiedTree.String(), git("rev-parse", "HEAD"), commits, t.TempDir(), "kb-runner land report-artifacts --state /tmp/state")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := landingTreeEntries(repo, object.TreeSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{".agent-report.md", ".review-report.adversarial.md"} {
		if _, exists := entries[path]; exists {
			t.Errorf("landing tree includes report artifact %q", path)
		}
	}
	archives, err := filepath.Glob(filepath.Join(repo, "reviews", "archive", "report-artifacts-*.md"))
	if err != nil || len(archives) != 2 {
		t.Fatalf("report archives = %v, err=%v; want both verified report files archived", archives, err)
	}
	for _, archived := range archives {
		contents, err := os.ReadFile(archived)
		if err != nil || (string(contents) != "worker report\n" && string(contents) != "review report\n") {
			t.Errorf("archived report %s = %q, err=%v", archived, contents, err)
		}
	}
}

// case: S-237.123
func TestLandingRefusesBaseTrackedReportFilesWithCataloguedDiagnostic(t *testing.T) {
	repo, git := newImmutableLandRepo(t)
	if err := os.WriteFile(filepath.Join(repo, ".review-report.md"), []byte("base report\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", ".review-report.md")
	git("commit", "-m", "chore: base report")
	git("checkout", "-b", "agent/base-report")
	if err := os.WriteFile(filepath.Join(repo, "src.go"), []byte("verified change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "base-report")
	if err != nil {
		t.Fatal(err)
	}
	verifiedTree, err := treeSHAForCommit(repo, verifiedSHA.String())
	if err != nil {
		t.Fatal(err)
	}
	commits := []proposedCommit{{Kind: "case", Subject: "docs(qa): case"}, {Kind: "tests", Subject: "test(kb-runner): tests"}, {Kind: "code", Subject: "fix(kb-runner): code"}}
	_, err = buildLandingObjects(filesystemRunnerStateStore{}, repo, "base-report", verifiedTree.String(), git("rev-parse", "HEAD"), commits, t.TempDir(), "kb-runner land base-report --state /tmp/state")
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || diagnostic.Code != "KB_RUNNER_LAND_BASE_REPORT_TRACKED" || !strings.Contains(diagnostic.Message, ".review-report.md") {
		t.Fatalf("base tracked report refusal = %v, want catalogued path-specific diagnostic", err)
	}
}

func newImmutableLandRepo(t *testing.T) (string, func(...string) string) {
	t.Helper()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	repo := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		command := exec.Command(gitPath, append([]string{"-C", repo}, args...)...)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return strings.TrimSpace(string(output))
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.name", "Fixture"}, {"config", "user.email", "fixture@example.test"}} {
		run(args...)
	}
	if err := os.MkdirAll(filepath.Join(repo, "tools", "kb-runner"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "src.go"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "chore: base")
	return repo, run
}

func gitFrom(t *testing.T, gitPath, repo string, args ...string) string {
	t.Helper()
	command := exec.Command(gitPath, append([]string{"-C", repo}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s: %v", args, output, err)
	}
	return strings.TrimSpace(string(output))
}
