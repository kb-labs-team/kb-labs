//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

// case: S-237.129
func TestIndependentReviewCannotConsumeSharedReport(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	worker := f.addTask(t, "private-review", "worker")
	worker.Review, worker.Reviewers = "cross", []string{"codex", "codex"}
	store := newSchedulerStore(f.state)
	if err := store.updateTask(worker); err != nil {
		t.Fatal(err)
	}
	workerStream, err := store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(workerStream, SchedulerAwaitingReview, "reviews", "run reviewers"); err != nil {
		t.Fatal(err)
	}
	first := f.addTask(t, worker.Stream+"-codex-1", "review", worker.ID)
	second := f.addTask(t, worker.Stream+"-codex-2", "review", worker.ID)
	first.Workdir, second.Workdir = worker.Workdir, worker.Workdir
	first.ReviewerKey, second.ReviewerKey = "codex-1", "codex-2"
	if err := store.updateTask(first); err != nil {
		t.Fatal(err)
	}
	if err := store.updateTask(second); err != nil {
		t.Fatal(err)
	}
	for _, task := range []SchedulerTask{first, second} {
		stream, err := store.stream(task.Stream)
		if err != nil {
			t.Fatal(err)
		}
		runID, err := proc.AllocateRunID()
		if err != nil {
			t.Fatal(err)
		}
		stream.RunID = runID
		if err := store.commitAutoTransition([]SchedulerStream{stream}); err != nil {
			t.Fatal(err)
		}
		stream, err = store.stream(task.Stream)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.transition(stream, SchedulerRunning, "review", "wait for reviewer"); err != nil {
			t.Fatal(err)
		}
	}
	shared := filepath.Join(worker.Workdir, ".review-report.md")
	if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shared, []byte("ACCEPT\nshared verdict\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{state: f.state, supervisor: f.supervisor})
	firstStream, err := store.stream(first.Stream)
	if err != nil {
		t.Fatal(err)
	}
	runTestReviewJob(t, f.supervisor, f.state, firstStream.RunID, "")
	if err := options.finishReview(first, firstStream); err != nil {
		t.Fatal(err)
	}
	missing, err := store.stream(first.Stream)
	if err != nil || missing.State != SchedulerAwaitingOrchestrator || missing.Cause != "review-missing" {
		t.Fatalf("missing private report state=%+v err=%v", missing, err)
	}
	secondStream, err := store.stream(second.Stream)
	if err != nil {
		t.Fatal(err)
	}
	runTestReviewJob(t, f.supervisor, f.state, secondStream.RunID, "Verdict: ACCEPT\n\n## Defects\n\nprivate verdict\n\n## Verification\n\nPASS\n")
	if err := options.finishReview(second, secondStream); err != nil {
		t.Fatal(err)
	}
	workerStream, err = store.stream(worker.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(workerStream.ReviewResults) != 1 || workerStream.ReviewResults["codex-2"] != "ACCEPT" {
		t.Fatalf("shared verdict counted for another reviewer: %+v", workerStream.ReviewResults)
	}
}

// case: S-237.130
func TestPublicLandRefusesPartialPersistedCrossReview(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "partial-cross-land", "worker")
	task.Review, task.Reviewers = "cross", []string{"codex", "gemini"}
	store := newSchedulerStore(f.state)
	if err := store.updateTask(task); err != nil {
		t.Fatal(err)
	}
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: schedulerTestSHA, Ref: "verify/partial-cross-land-0123456", Status: "completed", Conclusion: "success"}
	stream.ReviewResults = map[string]string{"codex-1": "ACCEPT"}
	if err := store.transition(stream, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "wait remote"); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerAwaitingReview, "review", "wait reviews"); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	status := executeInvocation("kb-runner", []string{"land", task.Stream, "--state", f.state}, &stdout, &stderr)
	if status.Code() != 2 || !strings.Contains(stderr.String(), "gemini") || !strings.Contains(stderr.String(), "review") {
		t.Fatalf("partial cross-review land exit=%d stdout=%s stderr=%s", status.Code(), stdout.String(), stderr.String())
	}
	calls, err := os.ReadFile(f.gitCalls)
	if err != nil || strings.Contains(string(calls), " commit ") || strings.Contains(string(calls), " merge ") {
		t.Fatalf("partial cross-review caused Git mutation: calls=%q err=%v", calls, err)
	}
}

// case: S-237.131
func TestWatchRemotePropagatesOutageHandlerPersistenceFailure(t *testing.T) {
	runs := `[{"databaseId":51,"event":"push","path":".github/workflows/remote-verify.yml","headBranch":"verify/outage-stream-0123456","headSha":"` + schedulerTestSHA + `","status":"completed","conclusion":"failure"}]`
	f := newSchedulerFixture(t, runs, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"outage","jobs":[],"diagnostics":[]}`)
	task := f.addTask(t, "outage-stream", "worker")
	store := newSchedulerStore(f.state)
	stream, err := store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	stream.Submission = &SchedulerSubmission{SHA: schedulerTestSHA, Ref: "verify/outage-stream-0123456", RunID: "51", Status: "queued", DeadlineAt: time.Now().Add(time.Hour)}
	if err := store.transition(stream, SchedulerRunning, "worker", "finish worker"); err != nil {
		t.Fatal(err)
	}
	stream, err = store.stream(task.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(stream, SchedulerAwaitingRemote, "remote", "wait remote"); err != nil {
		t.Fatal(err)
	}
	events := filepath.Join(store.dir, "events.jsonl")
	if err := os.Remove(events); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(events, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_GH_VIEW_FAIL", "1")
	options := newSchedulerRunOptions(store, schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: f.state, supervisor: f.supervisor})
	if err := options.watchRemote(context.Background()); err == nil || !strings.Contains(err.Error(), "events.jsonl") {
		t.Fatalf("watcher discarded outage handler persistence error: %v", err)
	}
}
