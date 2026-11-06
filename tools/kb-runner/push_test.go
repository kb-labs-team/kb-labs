//go:build darwin || linux

package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// case: S-237.127
func TestWorkerCandidateAndBisectPushCallSitesUseOnlyVerifyHeads(t *testing.T) {
	f := newSchedulerFixture(t, `[]`, `{"schemaVersion":1,"sha":"`+schedulerTestSHA+`","status":"pass","jobs":[],"diagnostics":[]}`)
	t.Setenv("FAKE_CHANGED_FILES", "")
	options := newSchedulerRunOptions(newSchedulerStore(f.state), schedulerRunOptionsConfig{root: runnerRoot{invocation: "kb-runner"}, state: f.state, supervisor: f.supervisor})
	worker := f.addTask(t, "worker-push", "worker")
	if err := os.MkdirAll(worker.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := options.submit(worker, SchedulerStream{Stream: worker.Stream}); err != nil {
		t.Fatalf("worker verification submit: %v", err)
	}

	candidate := f.addTask(t, "candidate-push", "worker")
	if err := os.MkdirAll(candidate.Workdir, 0o700); err != nil {
		t.Fatal(err)
	}
	store := newSchedulerStore(f.state)
	candidateStream, err := store.stream(candidate.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transition(candidateStream, SchedulerRunning, "candidate", "submit candidate"); err != nil {
		t.Fatal(err)
	}
	candidateStream, err = store.stream(candidate.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if err := options.submitCandidate(candidate, candidateStream, schedulerTestSHA); err != nil {
		t.Fatalf("candidate submit: %v", err)
	}

	mergeOne, mergeTwo := strings.Repeat("a", 40), strings.Repeat("b", 40)
	if err := store.writeIntegration(SchedulerIntegration{LastGreenSHA: strings.Repeat("0", 40), Merges: []SchedulerMergeRecord{
		{CommitSHA: mergeOne, ParentSHA: strings.Repeat("0", 40), Stream: "prefix-one"},
		{CommitSHA: mergeTwo, ParentSHA: mergeOne, Stream: "prefix-two"},
	}}); err != nil {
		t.Fatal(err)
	}
	candidateStream.Submission = &SchedulerSubmission{SHA: schedulerTestSHA, Purpose: "candidate", RunID: "41", DeadlineAt: time.Now().Add(time.Hour)}
	verdict := map[string]any{"jobs": []any{map[string]any{"failures": []any{"TestCandidateFailure"}}}}
	if err := options.startCandidateBisect(candidate, candidateStream, verdict, "fixture/repo"); err != nil {
		t.Fatalf("bisect submit: %v", err)
	}

	calls, err := os.ReadFile(f.gitCalls)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"push backup " + schedulerTestSHA + ":refs/heads/verify/worker-push-" + schedulerTestSHA[:7],
		"push backup " + schedulerTestSHA + ":refs/heads/verify/candidate-candidate-push-" + schedulerTestSHA[:7],
		"push backup " + mergeOne + ":refs/heads/verify/bisect-prefix-one-" + mergeOne[:7],
		"push backup " + mergeTwo + ":refs/heads/verify/bisect-prefix-two-" + mergeTwo[:7],
	}
	for _, argv := range want {
		if strings.Count(string(calls), argv) != 1 {
			t.Errorf("fake Git argv missing or duplicated %q: %s", argv, calls)
		}
	}
	for _, forbidden := range []string{":refs/tags/", " +refs/heads/", "push --force", "push origin ", "push backup --force"} {
		if strings.Contains(string(calls), forbidden) {
			t.Errorf("fake Git argv contains forbidden push target %q: %s", forbidden, calls)
		}
	}
}
