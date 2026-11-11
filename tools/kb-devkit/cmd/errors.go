package cmd

import (
	"fmt"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/devkit/internal/engine"
)

func commandFailure(command string) error {
	return diag.New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.",
		diag.WithMeta(map[string]any{"command": command}))
}

func taskFailure(result engine.TaskResult, data any) error {
	if result.Diagnostic != nil {
		result.Diagnostic.Data = data
		return result.Diagnostic
	}
	code := "KB_DEVKIT_TASK_FAILED"
	meta := map[string]any{
		"package": result.Package,
		"task":    result.Task,
		"logPath": result.LogPath,
	}
	if result.LogError != "" {
		code = "KB_DEVKIT_TASK_LOG_UNAVAILABLE"
		meta["logDirectory"] = result.LogDirectory
		meta["logError"] = result.LogError
	}
	return diag.New(code, "",
		diag.WithMeta(meta),
		diag.WithData(data))
}

func taskGraphFailure(err *engine.TaskGraphError) error {
	return diag.New("KB_DEVKIT_TASK_GRAPH_INVALID", "",
		diag.WithMeta(map[string]any{
			"package":        err.Package,
			"task":           err.Task,
			"dependency":     err.Dependency,
			"dependencyTask": err.DependencyTask,
		}),
	)
}

func taskCycleFailure(err *engine.TaskCycleError, tasks []string) error {
	return diag.New("KB_DEVKIT_TASK_GRAPH_CYCLE", "",
		diag.WithMeta(map[string]any{
			"task":            strings.Join(tasks, " "),
			"cycle":           err.CycleDescription(),
			"dependencyEdges": err.DependencyEdges(),
		}),
	)
}

func taskAccountingFailure(err *engine.RunAccountingError, tasks []string) error {
	unaccounted := make([]string, 0, len(err.UnaccountedTasks))
	for _, task := range err.UnaccountedTasks {
		unaccounted = append(unaccounted, fmt.Sprintf("%s:%s", task.Package, task.Task))
	}
	return diag.New("KB_DEVKIT_RUN_INCOMPLETE", "",
		diag.WithMeta(map[string]any{
			"task":             strings.Join(tasks, " "),
			"unaccountedTasks": unaccounted,
		}),
	)
}
