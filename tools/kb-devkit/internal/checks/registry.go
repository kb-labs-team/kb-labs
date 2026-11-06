package checks

import (
	"sort"
	"time"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

var defaultRules []Rule

func init() {
	defaultRules = []Rule{
		&PackageJSONRule{},
		&TSConfigRule{},
		&TSupRule{},
		&ESLintRule{},
		&StructureRule{},
		&DepsRule{},
		&ReleaseBoundaryRule{},
	}
}

// Registry holds registered rules.
type Registry struct {
	rules []Rule
}

// Default returns a Registry with all built-in rules registered.
func Default() *Registry {
	r := &Registry{}
	r.rules = append(r.rules, defaultRules...)
	return r
}

// Build returns a Registry with built-in rules plus external command-backed
// checks declared in config.Custom for the given phase.
func Build(cfg *config.DevkitConfig, workspaceRoot, phase string) *Registry {
	r := Default()
	if cfg == nil {
		return r
	}
	graphTasks := make([]string, 0, len(cfg.Tasks))
	for name := range cfg.Tasks {
		graphTasks = append(graphTasks, name)
	}
	sort.Strings(graphTasks)
	r.Register(&aggregateTaskOwnerRule{cfg: cfg})
	for _, c := range cfg.Custom {
		if !matchesPhase(c, phase) {
			continue
		}
		packCfg, ok := cfg.Checks.Packages[c.Name]
		if ok && !packCfg.Enabled {
			continue
		}
		r.Register(&externalRule{
			name:           c.Name,
			run:            c.Run,
			fix:            c.Fix,
			phase:          phase,
			language:       c.Language,
			categories:     c.Categories,
			anchorPackages: c.AnchorPackages,
			requiresBuild:  c.RequiresBuild,
			scope:          c.Scope,
			workspaceRoot:  workspaceRoot,
			checkConfig:    packCfg,
			graphTasks:     graphTasks,
			timeout:        time.Duration(cfg.Checks.TimeoutMS) * time.Millisecond,
		})
	}
	return r
}

// Register adds a custom rule to the registry.
func (r *Registry) Register(rule Rule) {
	r.rules = append(r.rules, rule)
}

// RulesFor returns rules applicable to a given preset's language.
func (r *Registry) RulesFor(preset config.Preset) []Rule {
	var result []Rule
	for _, rule := range r.rules {
		if scoped, ok := rule.(interface{ Scope() string }); ok {
			if scoped.Scope() == "workspace" {
				continue
			}
			if external, ok := rule.(*externalRule); ok && matchesLanguage(config.CustomCheck{Language: external.language}, preset.Language) {
				result = append(result, rule)
			}
			continue
		}
		if preset.Language == "go" {
			if rule.Name() == "structure" || rule.Name() == "deps" {
				result = append(result, rule)
			}
			continue
		}
		result = append(result, rule)
	}
	return result
}

// ApplicableRulesFor is the single package/check applicability owner. Package
// execution, selection validation, and check counts all consume this result.
func (r *Registry) ApplicableRulesFor(pkg workspace.Package, preset config.Preset, only []string) []Rule {
	var result []Rule
	for _, rule := range r.RulesFor(preset) {
		if scoped, ok := rule.(interface{ Scope() string }); ok && scoped.Scope() == "workspace" {
			continue
		}
		if !selectedRule(rule, only) {
			continue
		}
		if applicable, ok := rule.(interface{ AppliesToPackage(workspace.Package) bool }); ok && !applicable.AppliesToPackage(pkg) {
			continue
		}
		result = append(result, rule)
	}
	return result
}

// WorkspaceRules returns selected workspace-scoped checks, each of which runs
// once for the workspace rather than once per package.
func (r *Registry) WorkspaceRules(only []string) []Rule {
	var result []Rule
	for _, rule := range r.rules {
		if scoped, ok := rule.(interface{ Scope() string }); !ok || scoped.Scope() != "workspace" || !selectedRule(rule, only) {
			continue
		}
		result = append(result, rule)
	}
	return result
}

// PackageApplicabilityMismatch explains a category-filtered selected check
// that is known and language-compatible but does not apply to this package.
func (r *Registry) PackageApplicabilityMismatch(pkg workspace.Package, preset config.Preset, only []string) (string, []string) {
	for _, rule := range r.RulesFor(preset) {
		if !selectedRule(rule, only) {
			continue
		}
		applicable, ok := rule.(interface{ AppliesToPackage(workspace.Package) bool })
		if !ok || applicable.AppliesToPackage(pkg) {
			continue
		}
		categories, ok := rule.(interface{ ApplicableCategories() []string })
		if ok {
			return rule.Name(), categories.ApplicableCategories()
		}
	}
	return "", nil
}

func selectedRule(rule Rule, only []string) bool {
	if len(only) == 0 {
		return true
	}
	for _, selected := range only {
		if rule.Name() == selected {
			return true
		}
	}
	return false
}

// All returns all registered rules.
func (r *Registry) All() []Rule {
	return r.rules
}
