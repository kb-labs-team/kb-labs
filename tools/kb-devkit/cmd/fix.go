package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"

	"github.com/kb-labs/devkit/internal/checks"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/spf13/cobra"
)

var (
	fixPackage  string
	fixDryRun   bool
	fixSafe     bool
	fixScaffold bool
	fixSync     bool
	fixAll      bool
)

var fixCmd = &cobra.Command{
	Use:   "fix",
	Short: "Auto-fix issues where possible",
	Long: `Applies deterministic fixes for issues that declare automation capability.
Use --dry-run to preview what would be changed.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		pkgs := ws.Packages
		if fixPackage != "" {
			pkgs = ws.FilterByName([]string{fixPackage})
			if len(pkgs) == 0 {
				return fmt.Errorf("package %q not found", fixPackage)
			}
		}

		registry := checks.Build(cfg, ws.Root, "check")
		results := checks.RunAll(ws, cfg, registry, nil, nil)
		modes := selectedFixCapabilities(cfg)

		fixCount := 0
		var fixLog []string

		for _, r := range results {
			if r.Skipped {
				continue
			}

			for _, rule := range registry.All() {
				fixer, ok := rule.(checks.Fixer)
				if !ok {
					continue
				}

				// Collect AutoFix issues for this rule.
				var fixable []checks.Issue
				for _, issue := range r.Issues {
					if issue.Check == rule.Name() && shouldApplyIssue(issue, modes) {
						fixable = append(fixable, issue)
					}
				}

				if len(fixable) == 0 {
					continue
				}

				if err := fixer.Apply(r.Package, fixable, fixDryRun); err != nil {
					return fmt.Errorf("fix %s in %s: %w", rule.Name(), r.Package.Name, err)
				}

				for _, issue := range fixable {
					fixLog = append(fixLog, fmt.Sprintf("%s: %s", r.Package.Name, issue.Message))
					fixCount++
				}
			}
		}

		if jsonMode {
			return JSONOut(map[string]any{
				"fixed":   fixCount,
				"dryRun":  fixDryRun,
				"modes":   modes,
				"actions": fixLog,
			})
		}

		o := newOutput()
		if fixCount == 0 {
			o.OK("Nothing to fix")
			return nil
		}

		prefix := "Fixed"
		if fixDryRun {
			prefix = "Would fix"
		}
		o.OK(fmt.Sprintf("%s %d issue(s):", prefix, fixCount))
		for _, entry := range fixLog {
			clikitcommand.Printf("  %s %s\n", o.bullet.Render("●"), entry)
		}

		return nil
	},
}

func init() {
	fixCmd.Flags().StringVar(&fixPackage, "package", "", "fix a single package by name")
	fixCmd.Flags().BoolVar(&fixDryRun, "dry-run", false, "preview fixes without applying")
	fixCmd.Flags().BoolVar(&fixSafe, "safe", false, "apply deterministic in-place fixes")
	fixCmd.Flags().BoolVar(&fixScaffold, "scaffold", false, "create missing deterministic boilerplate files")
	fixCmd.Flags().BoolVar(&fixSync, "sync", false, "include issues managed via sync")
	fixCmd.Flags().BoolVar(&fixAll, "all", false, "apply all supported fix capabilities")
	rootCmd.AddCommand(fixCmd)
}

func selectedFixCapabilities(cfg *config.DevkitConfig) []checks.Capability {
	if fixAll {
		return []checks.Capability{checks.CapabilityFixable, checks.CapabilityScaffoldable, checks.CapabilityManagedBySync}
	}
	if fixSafe || fixScaffold || fixSync {
		var out []checks.Capability
		if fixSafe {
			out = append(out, checks.CapabilityFixable)
		}
		if fixScaffold {
			out = append(out, checks.CapabilityScaffoldable)
		}
		if fixSync {
			out = append(out, checks.CapabilityManagedBySync)
		}
		return out
	}
	switch cfg.Fix.DefaultMode {
	case "scaffold":
		return []checks.Capability{checks.CapabilityScaffoldable}
	case "all":
		return []checks.Capability{checks.CapabilityFixable, checks.CapabilityScaffoldable, checks.CapabilityManagedBySync}
	default:
		return []checks.Capability{checks.CapabilityFixable}
	}
}

func shouldApplyIssue(issue checks.Issue, modes []checks.Capability) bool {
	if issue.AutoFix && issue.Capability == "" {
		issue.Capability = checks.CapabilityFixable
	}
	for _, mode := range modes {
		if issue.Capability == mode {
			return true
		}
	}
	return false
}
