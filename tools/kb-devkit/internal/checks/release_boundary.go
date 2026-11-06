package checks

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
)

// ReleaseBoundaryRule enforces that gating packages do not depend on private tools.
type ReleaseBoundaryRule struct{}

func (r *ReleaseBoundaryRule) Name() string                                   { return "release-boundary" }
func (r *ReleaseBoundaryRule) Scope() string                                  { return "workspace" }
func (r *ReleaseBoundaryRule) Check(workspace.Package, config.Preset) []Issue { return nil }

func (r *ReleaseBoundaryRule) CheckWorkspace(ws *workspace.Workspace) []Issue {
	internalTools := make(map[string]struct{})
	packagesByName := make(map[string]workspace.Package, len(ws.Packages))
	for _, pkg := range ws.Packages {
		packagesByName[pkg.Name] = pkg
		if pkg.ReleaseLane == "internal-tool" {
			internalTools[pkg.Name] = struct{}{}
		}
	}
	dependencyReader, err := engine.NewWorkspaceDependencyReader(packagesByName)
	if err != nil {
		return []Issue{{Check: r.Name(), Severity: SeverityError, Message: fmt.Sprintf("could not resolve workspace Go module paths: %v", err)}}
	}
	var issues []Issue
	for _, pkg := range ws.Packages {
		if pkg.ReleaseLane == "internal-tool" {
			continue
		}
		dependencies, err := dependencyReader.WorkspaceDeps(pkg.Dir)
		if err != nil {
			issues = append(issues, Issue{Check: r.Name(), Severity: SeverityError, Message: fmt.Sprintf("could not resolve workspace dependencies for %q: %v", pkg.Name, err)})
			continue
		}
		for _, name := range dependencies {
			if _, internal := internalTools[name]; !internal {
				continue
			}
			manifestPath := filepath.Join(pkg.Dir, "package.json")
			if _, statErr := os.Stat(manifestPath); os.IsNotExist(statErr) {
				manifestPath = filepath.Join(pkg.Dir, "go.mod")
			}
			issues = append(issues, Issue{
				Check:    r.Name(),
				Severity: SeverityError,
				Message:  fmt.Sprintf("gating package %q declares workspace dependency on internal tool %q", pkg.Name, name),
				File:     manifestPath,
			})
		}
	}
	return issues
}
