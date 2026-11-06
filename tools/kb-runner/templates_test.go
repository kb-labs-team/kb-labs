//go:build darwin || linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// case: S-237.114, S-237.132
func TestSchedulerRendersProductionEmbeddedReviewMergeAndRoundTemplates(t *testing.T) {
	state := t.TempDir()
	options := newSchedulerRunOptions(newSchedulerStore(state), schedulerRunOptionsConfig{state: state})
	for _, name := range []string{runnerReviewTemplate, runnerMergeTemplate} {
		template, err := readRunnerTemplate(name)
		if err != nil || len(template) == 0 {
			t.Fatalf("embedded template %s: bytes=%q err=%v", name, template, err)
		}
		task := SchedulerTask{ID: strings.TrimSuffix(name, ".md"), Stream: "embedded-stream", PromptTemplate: name}
		if name == runnerReviewTemplate {
			task.Role = schedulerReviewRole
		} else {
			task.Role = schedulerMergeRole
		}
		reviewStream := SchedulerStream{Stream: task.Stream, TaskID: task.ID, RunID: "embedded-run"}
		parentStream := SchedulerStream{Stream: task.Stream, TaskID: task.ID}
		path, err := options.persistReviewPrompt(task, reviewStream, parentStream)
		if err != nil {
			t.Fatalf("render embedded template %s: %v", name, err)
		}
		content, err := os.ReadFile(path)
		if err != nil || !strings.Contains(string(content), "embedded-stream") || strings.Contains(string(content), "{stream}") {
			t.Fatalf("rendered %s=%q err=%v", name, content, err)
		}
	}
	message := filepath.Join(state, "message.md")
	if err := os.WriteFile(message, []byte("Do this work.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	round, err := prepareRoundPrompt(SchedulerTask{ID: "round", Stream: "embedded-round", Prompt: message}, state, options.store.stateIO)
	if err != nil {
		t.Fatalf("render embedded definition of done: %v", err)
	}
	content, err := os.ReadFile(round)
	if err != nil || !strings.Contains(string(content), "Do this work.") || !strings.Contains(string(content), "Definition of done") {
		t.Fatalf("rendered worker prompt=%q err=%v", content, err)
	}
}

func TestReviewPromptContentUsesSuppliedStreamsAndRunOutput(t *testing.T) {
	task := SchedulerTask{ID: "review-task", Stream: "review-stream", PromptTemplate: runnerReviewTemplate, Role: schedulerReviewRole}
	review := SchedulerStream{Stream: task.Stream, TaskID: task.ID, RunID: "review-run"}
	parent := SchedulerStream{Stream: "worker-stream", TaskID: "worker-task"}
	content, err := renderReviewPromptContent(task, review, parent, "/state")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "Review the completed stream worker-stream") || !strings.Contains(string(content), "review-run.review.md") || strings.Contains(string(content), "{stream}") || strings.Contains(string(content), "{review-report}") {
		t.Fatalf("rendered review content did not use the supplied journal values: %s", content)
	}
}
