package checks

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
)

const typeCheckProjectCheck = "type-check-project"

type typeCheckProjectRule struct {
	cfg *config.DevkitConfig
}

func (r *typeCheckProjectRule) Name() string                                   { return typeCheckProjectCheck }
func (r *typeCheckProjectRule) Scope() string                                  { return "workspace" }
func (r *typeCheckProjectRule) Check(workspace.Package, config.Preset) []Issue { return nil }

func (r *typeCheckProjectRule) CheckWorkspace(ws *workspace.Workspace) []Issue {
	packages := append([]workspace.Package(nil), ws.Packages...)
	sort.Slice(packages, func(i, j int) bool { return packages[i].Name < packages[j].Name })
	var issues []Issue
	for _, pkg := range packages {
		if ws.IsAggregatePackage(pkg.Name) || engine.ResolveTaskDef(r.cfg, "type-check", pkg.Category) == nil {
			continue
		}
		project := filepath.Join(pkg.Dir, "tsconfig.json")
		if _, err := os.Stat(project); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			issues = append(issues, Issue{Check: typeCheckProjectCheck, Severity: SeverityError, Message: fmt.Sprintf("Cannot inspect package-owned TypeScript project for %q: %v", pkg.Name, err), File: project})
			continue
		}
		issues = append(issues, Issue{
			Check: typeCheckProjectCheck, Severity: SeverityError,
			Message: fmt.Sprintf("Package %q has a type-check task but no package-owned tsconfig.json.", pkg.Name),
			File: filepath.Join(pkg.Dir, "package.json"),
			Fix: "Add a package-owned tsconfig.json or assign the package to a category without a type-check task.",
		})
	}
	return issues
}
