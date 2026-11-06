package cmd

import (
	"errors"
	"reflect"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/devkit/internal/engine"
)

// case: S-179.37
func TestTaskGraphFailureUsesCataloguedDependencyDiagnosis(t *testing.T) {
	err := taskGraphFailure(&engine.TaskGraphError{
		Package:        "@fixture/app",
		Task:           "build",
		Dependency:     "@fixture/runtime",
		DependencyTask: "build",
	})

	var failure *diag.Diag
	if !errors.As(err, &failure) {
		t.Fatalf("task graph failure = %T, want catalogued diagnostic", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("render task graph diagnostic: %v", err)
	}
	expected := renderCatalogEnvelope(t, "KB_DEVKIT_TASK_GRAPH_INVALID", map[string]any{
		"package": "@fixture/app", "task": "build", "dependency": "@fixture/runtime", "dependencyTask": "build",
	})
	if envelope.Code != "KB_DEVKIT_TASK_GRAPH_INVALID" || envelope.Hint != expected.Hint ||
		envelope.Details["package"] != "@fixture/app" {
		t.Fatalf("task graph diagnosis = %+v", envelope)
	}
}

// case: S-179.42
func TestTaskCycleFailureUsesCataloguedCycleAndDependencyKinds(t *testing.T) {
	cycle := &engine.TaskCycleError{Edges: []engine.TaskCycleEdge{
		{From: engine.TaskIdentity{Package: "@fixture/a", Task: "build"}, To: engine.TaskIdentity{Package: "@fixture/b", Task: "build"}, Kind: engine.DependenciesKind},
		{From: engine.TaskIdentity{Package: "@fixture/b", Task: "build"}, To: engine.TaskIdentity{Package: "@fixture/c", Task: "build"}, Kind: engine.DevDependenciesKind},
		{From: engine.TaskIdentity{Package: "@fixture/c", Task: "build"}, To: engine.TaskIdentity{Package: "@fixture/a", Task: "build"}, Kind: engine.PeerDependenciesKind},
	}}
	err := taskCycleFailure(cycle, []string{"build"})

	var failure *diag.Diag
	if !errors.As(err, &failure) {
		t.Fatalf("task cycle failure = %T, want catalogued diagnostic", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("render task cycle diagnostic: %v", err)
	}
	expected := renderCatalogEnvelope(t, "KB_DEVKIT_TASK_GRAPH_CYCLE", map[string]any{
		"task":            "build",
		"cycle":           cycle.CycleDescription(),
		"dependencyEdges": cycle.DependencyEdges(),
	})
	if envelope.Code != expected.Code || envelope.Hint != expected.Hint || envelope.Message != expected.Message || !reflect.DeepEqual(envelope.Details, expected.Details) {
		t.Fatalf("task cycle diagnosis = %+v", envelope)
	}
}

// case: S-179.42
func TestTaskAccountingFailureListsUnaccountedTasks(t *testing.T) {
	err := taskAccountingFailure(&engine.RunAccountingError{UnaccountedTasks: []engine.TaskIdentity{
		{Package: "@fixture/app", Task: "build"},
	}}, []string{"build"})

	var failure *diag.Diag
	if !errors.As(err, &failure) {
		t.Fatalf("task accounting failure = %T, want catalogued diagnostic", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("render task accounting diagnostic: %v", err)
	}
	expected := renderCatalogEnvelope(t, "KB_DEVKIT_RUN_INCOMPLETE", map[string]any{
		"task":             "build",
		"unaccountedTasks": []string{"@fixture/app:build"},
	})
	if envelope.Code != expected.Code || envelope.Hint != expected.Hint || envelope.Message != expected.Message || !reflect.DeepEqual(envelope.Details, expected.Details) {
		t.Fatalf("task accounting diagnosis = %+v", envelope)
	}
}

// case: S-179.38
func TestTaskFailureWithoutPersistedLogUsesCataloguedRecovery(t *testing.T) {
	err := taskFailure(engine.TaskResult{
		Package:      "@fixture/app",
		Task:         "build",
		LogPath:      "/workspace/.kb/devkit/logs/task.log",
		LogDirectory: "/workspace/.kb/devkit/logs",
		LogError:     "permission denied",
	}, nil)

	var failure *diag.Diag
	if !errors.As(err, &failure) {
		t.Fatalf("task failure = %T, want catalogued diagnostic", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("render task log diagnostic: %v", err)
	}
	expected := renderCatalogEnvelope(t, "KB_DEVKIT_TASK_LOG_UNAVAILABLE", map[string]any{
		"package": "@fixture/app", "task": "build", "logPath": "/workspace/.kb/devkit/logs/task.log",
		"logDirectory": "/workspace/.kb/devkit/logs", "logError": "permission denied",
	})
	if envelope.Code != "KB_DEVKIT_TASK_LOG_UNAVAILABLE" || envelope.Hint != expected.Hint ||
		envelope.Details["package"] != "@fixture/app" ||
		envelope.Details["logPath"] != "/workspace/.kb/devkit/logs/task.log" ||
		envelope.Details["logError"] != "permission denied" {
		t.Fatalf("task log diagnosis = %+v", envelope)
	}
}

func renderCatalogEnvelope(t *testing.T, code string, meta map[string]any) diag.Envelope {
	t.Helper()
	envelope, err := diag.ToEnvelope(diag.New(code, "", diag.WithMeta(meta)))
	if err != nil {
		t.Fatalf("render catalog diagnostic %s: %v", code, err)
	}
	return envelope
}
