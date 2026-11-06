// Package engine implements the task execution engine.
// A task is any command with declared inputs, outputs, and dependencies.
// The engine caches results by input hash — same inputs → restore from cache.
package engine

import (
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// TaskDef is the resolved definition of one (package, task) pair.
// Resolution picks the correct variant from TaskConfig based on the package category.
type TaskDef struct {
	Name    string
	Command string
	Inputs  []string // glob patterns relative to package dir
	Outputs []string // glob patterns relative to package dir
	// Deps: "^build" = run 'build' for all workspace deps first
	//       "build"  = run 'build' for this package first
	Deps  []string
	Cache bool // default true; false = always run (e.g. deploy)
}

// TaskResult is the outcome of running one (package, task) pair.
type TaskResult struct {
	Package      string
	Task         string
	OK           bool
	Cached       bool
	Elapsed      time.Duration
	ExitCode     int
	Stdout       string
	Stderr       string
	Error        string
	Diagnostic   *diag.Diag `json:"diagnostic,omitempty"`
	LogPath      string     `json:"logPath,omitempty"`
	LogError     string     `json:"logError,omitempty"`
	LogDirectory string     `json:"logDirectory,omitempty"`
}

// ResolveTaskDef returns the TaskDef for a specific (task name, package category) pair.
// Returns nil if no variant matches the package category — the package is skipped for this task.
func ResolveTaskDef(cfg *config.DevkitConfig, taskName, pkgCategory string) *TaskDef {
	tc, ok := cfg.Tasks[taskName]
	if !ok {
		return nil
	}
	v := tc.ResolveVariant(pkgCategory)
	if v == nil {
		return nil
	}
	cacheVal := true
	if v.Cache != nil {
		cacheVal = *v.Cache
	}
	return &TaskDef{
		Name:    taskName,
		Command: v.Command,
		Inputs:  v.Inputs,
		Outputs: v.Outputs,
		Deps:    v.Deps,
		Cache:   cacheVal,
	}
}

// ResolvePackageTaskDef resolves a task for a package in the discovered
// workspace. Aggregate packages never own task variants; their nested workspace
// packages own the work.
func ResolvePackageTaskDef(ws *workspace.Workspace, cfg *config.DevkitConfig, taskName string, pkg workspace.Package) *TaskDef {
	if ws.IsAggregatePackage(pkg.Name) {
		return nil
	}
	return ResolveTaskDef(cfg, taskName, pkg.Category)
}
