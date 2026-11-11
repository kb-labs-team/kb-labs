//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// case: S-237.86, S-237.123
func TestMergeResolutionIsReverifiedAndPublishedThroughSharedLanding(t *testing.T) {
	for _, race := range []string{"publish-resolved-merge", "integration-cas-refusal", "worker-cas-refusal"} {
		t.Run(race, func(t *testing.T) {
			raceIntegration := race == "integration-cas-refusal"
			raceWorker := race == "worker-cas-refusal"
			repo, git := newImmutableLandRepo(t)
			policy := []byte(`{"integration_branch":"agent/integration","risk_zones":["tools/kb-runner/**"]}`)
			if err := os.WriteFile(filepath.Join(repo, "tools", "kb-runner", "scheduler-policy.json"), policy, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(repo, "conflict.txt"), []byte("base\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			git("add", "tools/kb-runner/scheduler-policy.json", "conflict.txt")
			git("commit", "-m", "chore: base")
			git("checkout", "-b", "agent/integration")
			if err := os.WriteFile(filepath.Join(repo, "conflict.txt"), []byte("integration version\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			git("add", "conflict.txt")
			git("commit", "-m", "feat: integration conflict side")
			integrationSHA := git("rev-parse", "HEAD")
			git("checkout", "-b", "agent/integration-racer")
			if err := os.WriteFile(filepath.Join(repo, "integration-racer.txt"), []byte("concurrent integration commit\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			git("add", "integration-racer.txt")
			git("commit", "-m", "chore: concurrent integration update")
			intruderSHA := git("rev-parse", "HEAD")
			git("checkout", "main")
			git("checkout", "-b", "agent/resolution-worker")
			if err := os.WriteFile(filepath.Join(repo, "conflict.txt"), []byte("worker version\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			report := "Status: DONE\n" + r2CommitReport
			if err := os.WriteFile(filepath.Join(repo, ".agent-report.md"), []byte(report), 0o600); err != nil {
				t.Fatal(err)
			}
			git("add", "conflict.txt")
			git("commit", "-m", "feat: worker conflict side")
			workerSHA := git("rev-parse", "HEAD")
			verifiedSHA, _, err := snapshotWorktree(filesystemRunnerStateStore{}, repo, "resolution-worker")
			if err != nil {
				t.Fatal(err)
			}
			workerTree, err := treeSHAForCommit(repo, verifiedSHA.String())
			if err != nil {
				t.Fatal(err)
			}
			worktrees := t.TempDir()
			integrationWorktree := filepath.Join(worktrees, "integration")
			git("worktree", "add", integrationWorktree, "agent/integration")
			mergeOutput, mergeErr := gitRaw(t, repo, "merge", "--no-ff", "--no-edit", "refs/heads/agent/integration")
			if mergeErr == nil || !strings.Contains(mergeOutput, "CONFLICT") {
				t.Fatalf("fixture did not create a real merge conflict: output=%q err=%v", mergeOutput, mergeErr)
			}
			if err := os.WriteFile(filepath.Join(repo, "conflict.txt"), []byte("resolver version\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := exec.Command(gitPathForTest(t), "-C", repo, "remote", "add", "backup", "https://github.com/kb-labs/backup.git").CombinedOutput(); err != nil {
				t.Fatal(err)
			}

			state := t.TempDir()
			prompt := filepath.Join(t.TempDir(), "worker-prompt.md")
			if err := os.WriteFile(prompt, []byte("worker prompt\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			store := newSchedulerStore(state)
			worker, err := store.add(SchedulerTask{ID: "resolution-worker", Stream: "resolution-worker", Prompt: prompt, Workdir: repo, RepoRoot: repo, WorktreeRoot: worktrees, Base: "main", Vendor: "codex", Effort: "high", Role: schedulerWorkerRole, Review: "single", Reviewers: []string{"codex"}})
			if err != nil {
				t.Fatal(err)
			}
			workerState, err := store.stream(worker.Stream)
			if err != nil {
				t.Fatal(err)
			}
			workerState.Submission = &SchedulerSubmission{SHA: workerSHA, TreeSHA: workerTree.String(), ExpectedRefSHA: workerSHA, Status: "completed", Conclusion: "success"}
			workerState.ReviewResults = map[string]string{"codex": "ACCEPT"}
			if err := store.transition(workerState, SchedulerRunning, "worker", "worker complete"); err != nil {
				t.Fatal(err)
			}
			workerState, _ = store.stream(worker.Stream)
			if err := store.transition(workerState, SchedulerAwaitingRemote, "remote", "remote passed"); err != nil {
				t.Fatal(err)
			}
			workerState, _ = store.stream(worker.Stream)
			if err := store.transition(workerState, SchedulerAwaitingReview, "review", "review accepted"); err != nil {
				t.Fatal(err)
			}
			mergeTask, err := store.add(SchedulerTask{ID: "resolution-worker-merge", Stream: "resolution-worker-merge", PromptTemplate: runnerMergeTemplate, Workdir: repo, RepoRoot: repo, WorktreeRoot: worktrees, Base: "main", DependsOn: []string{worker.ID}, Vendor: "codex", Effort: "high", Role: schedulerMergeRole})
			if err != nil {
				t.Fatal(err)
			}
			mergeState, _ := store.stream(mergeTask.Stream)
			if err := store.transition(mergeState, SchedulerRunning, "merge resolver", "finish resolver"); err != nil {
				t.Fatal(err)
			}

			gitPath := gitPathForTest(t)
			shimDir := t.TempDir()
			pushLog := filepath.Join(t.TempDir(), "push.argv")
			shim := `#!/bin/sh
case " $* " in
  *" commit-tree "*)
    output=$("$REAL_GIT" "$@") || exit $?
    if [ "$LAND_INJECT_WORKER_REF_RACE" = "1" ]; then
      "$REAL_GIT" -C "$LAND_REPO" update-ref "$LAND_WORKER_REF" "$LAND_INTRUDER_SHA"
    fi
    printf '%s\n' "$output"
    exit 0 ;;
  *" -C $LAND_INTEGRATION update-ref refs/heads/agent/integration "*)
    if [ "$LAND_INJECT_REF_RACE" = "1" ]; then "$REAL_GIT" -C "$LAND_REPO" update-ref refs/heads/agent/integration "$LAND_INTRUDER_SHA"; fi
    ;;
  *" push backup "*) printf '%s\n' "$*" >> "$LAND_PUSH_LOG"; exit 0 ;;
esac
exec "$REAL_GIT" "$@"
`
			if err := os.WriteFile(filepath.Join(shimDir, "git"), []byte(shim), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", shimDir+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("REAL_GIT", gitPath)
			t.Setenv("LAND_REPO", repo)
			t.Setenv("LAND_INTEGRATION", integrationWorktree)
			t.Setenv("LAND_WORKER_REF", "refs/heads/agent/resolution-worker")
			t.Setenv("LAND_INTRUDER_SHA", intruderSHA)
			t.Setenv("LAND_PUSH_LOG", pushLog)
			if raceIntegration {
				t.Setenv("LAND_INJECT_REF_RACE", "1")
			} else {
				t.Setenv("LAND_INJECT_REF_RACE", "0")
			}
			if raceWorker {
				t.Setenv("LAND_INJECT_WORKER_REF_RACE", "1")
			} else {
				t.Setenv("LAND_INJECT_WORKER_REF_RACE", "0")
			}
			options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: state})
			mergeState, _ = store.stream(mergeTask.Stream)
			finishErr := options.finishMerge(mergeTask, mergeState)
			if raceWorker {
				var conflict *landingRefConflict
				if !errors.As(finishErr, &conflict) {
					t.Fatalf("worker-ref CAS race was not refused with the typed landing conflict: err=%v", finishErr)
				}
				if branch := git("rev-parse", "refs/heads/agent/resolution-worker"); branch != intruderSHA {
					t.Fatalf("resolver CAS replaced the concurrent worker ref: got=%s want=%s", branch, intruderSHA)
				}
				if pushes, readErr := os.ReadFile(pushLog); !os.IsNotExist(readErr) || len(pushes) != 0 {
					t.Fatalf("resolver SHA or concurrent ref was pushed after CAS refusal: pushes=%q err=%v", pushes, readErr)
				}
				return
			}
			if finishErr != nil {
				t.Fatalf("finish resolver: %v", finishErr)
			}
			resolvedSHA := git("rev-parse", "HEAD")
			resolvedTree, err := treeSHAForCommit(repo, resolvedSHA)
			if err != nil {
				t.Fatal(err)
			}
			resolvedEntries, err := landingTreeEntries(repo, resolvedTree.String())
			if err != nil {
				t.Fatal(err)
			}
			if _, exists := resolvedEntries[".agent-report.md"]; exists {
				t.Fatal("merge-resolution commit contains the stream report artifact")
			}
			workerState, err = store.stream(worker.Stream)
			workerState, err = store.stream(worker.Stream)
			if err != nil || workerState.State != SchedulerAwaitingRemote || workerState.Submission == nil || workerState.Submission.SHA == resolvedSHA || workerState.Submission.SHA == integrationSHA || workerState.Submission.TreeSHA == resolvedTree.String() || workerState.Submission.ExpectedRefSHA != resolvedSHA {
				t.Fatalf("resolver snapshot did not preserve the worker report against the resolved branch: stream=%+v wantRefSHA=%s tree=%s err=%v", workerState, resolvedSHA, resolvedTree, err)
			}
			if resolverPushes, readErr := os.ReadFile(pushLog); readErr != nil || !strings.Contains(string(resolverPushes), "push backup "+workerState.Submission.SHA+":refs/heads/verify/resolution-worker-") {
				t.Fatalf("resolved worker snapshot SHA was not remotely verified: pushes=%q err=%v", resolverPushes, readErr)
			}
			mergeState, err = store.stream(mergeTask.Stream)
			if err != nil || mergeState.State != SchedulerDone {
				t.Fatalf("resolver task did not complete after scheduling worker reverification: state=%+v err=%v", mergeState, err)
			}

			workerState.Submission.Status, workerState.Submission.Conclusion = "completed", "success"
			if err := store.transition(workerState, SchedulerAwaitingReview, "review", "review the resolved worker tree"); err != nil {
				t.Fatal(err)
			}
			workerState, _ = store.stream(worker.Stream)
			workerState.ReviewResults = map[string]string{"codex": "ACCEPT"}
			if err := store.writeStreamObserved(workerState); err != nil {
				t.Fatal(err)
			}
			workerState, _ = store.stream(worker.Stream)
			landed, candidateSHA, err := options.landAccepted(worker, workerState)
			if raceIntegration {
				var conflict *integrationRefConflict
				if landed || !errors.As(err, &conflict) {
					t.Fatalf("integration race did not refuse resolver landing: landed=%t candidate=%s err=%v", landed, candidateSHA, err)
				}
				if branch := git("rev-parse", "refs/heads/agent/integration"); branch != intruderSHA {
					t.Fatalf("integration CAS replaced the concurrent ref: got=%s want=%s", branch, intruderSHA)
				}
				if pushes, readErr := os.ReadFile(pushLog); readErr != nil || strings.Contains(string(pushes), "verify/candidate-") {
					t.Fatalf("candidate was submitted after integration CAS refusal: pushes=%q err=%v", pushes, readErr)
				}
				workerState, err = store.stream(worker.Stream)
				if err != nil || workerState.State != SchedulerReady {
					t.Fatalf("CAS refusal did not return resolved stream to READY: state=%+v err=%v", workerState, err)
				}
				return
			}
			if err != nil || !landed || candidateSHA == "" {
				t.Fatalf("shared landing did not publish the resolved tree: landed=%t candidate=%s err=%v", landed, candidateSHA, err)
			}
			archives, err := filepath.Glob(filepath.Join(repo, "reviews", "archive", "resolution-worker-*.md"))
			if err != nil || len(archives) == 0 {
				t.Fatalf("merge-resolution report archives = %v, err=%v", archives, err)
			}
			published := gitFrom(t, gitPath, integrationWorktree, "show", candidateSHA+":conflict.txt")
			if published != "resolver version" {
				t.Fatalf("candidate merge omitted the resolver's conflict result: content=%q candidate=%s err=%v", published, candidateSHA, err)
			}
			pushes, err := os.ReadFile(pushLog)
			if err != nil || !strings.Contains(string(pushes), "push backup "+workerState.Submission.SHA+":refs/heads/verify/resolution-worker-") || !strings.Contains(string(pushes), "push backup "+candidateSHA+":refs/heads/verify/candidate-resolution-worker-") {
				t.Fatalf("resolved worker snapshot and resulting candidate SHA were not the verified/published identities: pushes=%q resolved=%s candidate=%s err=%v", pushes, workerState.Submission.SHA, candidateSHA, err)
			}
		})
	}
}

func gitPathForTest(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func gitRaw(t *testing.T, repo string, args ...string) (string, error) {
	t.Helper()
	command := exec.Command(gitPathForTest(t), append([]string{"-C", repo}, args...)...)
	output, err := command.CombinedOutput()
	return string(output), err
}
