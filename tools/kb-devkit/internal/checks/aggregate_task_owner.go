package checks

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
)

const aggregateTaskOwnerCheck = "aggregate-task-owner"

type aggregateTaskOwnerRule struct {
	cfg *config.DevkitConfig
}

func (r *aggregateTaskOwnerRule) Name() string                                   { return aggregateTaskOwnerCheck }
func (r *aggregateTaskOwnerRule) Scope() string                                  { return "workspace" }
func (r *aggregateTaskOwnerRule) Check(workspace.Package, config.Preset) []Issue { return nil }

func (r *aggregateTaskOwnerRule) CheckWorkspace(ws *workspace.Workspace) []Issue {
	aggregates := make([]workspace.Package, 0)
	for _, pkg := range ws.Packages {
		if ws.IsAggregatePackage(pkg.Name) {
			aggregates = append(aggregates, pkg)
		}
	}
	sort.Slice(aggregates, func(i, j int) bool { return aggregates[i].Name < aggregates[j].Name })

	taskNames := make([]string, 0, len(r.cfg.Tasks))
	for taskName := range r.cfg.Tasks {
		taskNames = append(taskNames, taskName)
	}
	sort.Strings(taskNames)

	var issues []Issue
	for _, pkg := range aggregates {
		var assigned []string
		for _, taskName := range taskNames {
			if engine.ResolveTaskDef(r.cfg, taskName, pkg.Category) != nil {
				assigned = append(assigned, taskName)
			}
		}
		if len(assigned) == 0 {
			continue
		}
		children := strings.Join(ws.AggregateChildren(pkg.Name), ", ")
		file := filepath.Join(pkg.Dir, "package.json")
		if relative, err := filepath.Rel(ws.Root, file); err == nil {
			file = relative
		}
		issues = append(issues, Issue{
			Check:    aggregateTaskOwnerCheck,
			Severity: SeverityError,
			Message:  fmt.Sprintf("Aggregate package %q contains workspace package(s) %s and has scheduled task variant(s) %s.", pkg.Name, children, strings.Join(assigned, ", ")),
			Fix:      "Move this aggregate to a category with no task variants, or let its child packages own the tasks.",
			File:     file,
		})
	}
	return issues
}
