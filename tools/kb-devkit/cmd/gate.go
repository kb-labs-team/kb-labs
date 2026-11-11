package cmd

import (
	"context"
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"strings"

	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/devkit/internal/checks"
	"github.com/spf13/cobra"
)

var gateCmd = &cobra.Command{
	Use:   "gate",
	Short: "Pre-commit gate: check only staged files",
	Long: `Runs checks against packages that contain staged files (git diff --cached).
Exits with code 1 if any errors are found, blocking the commit.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		// Get staged files.
		stagedFiles, err := getStagedFiles()
		if err != nil {
			return fmt.Errorf("get staged files: %w", err)
		}

		if len(stagedFiles) == 0 {
			if !jsonMode {
				newOutput().OK("No staged files — gate passed")
			} else {
				return JSONOut(map[string]any{"packages": []any{}})
			}
			return nil
		}

		// Map staged files to packages.
		stagedPkgs := make(map[string]bool)
		for _, file := range stagedFiles {
			pkg, ok := ws.PackageByPath(file)
			if ok {
				stagedPkgs[pkg.Name] = true
			}
		}

		if len(stagedPkgs) == 0 {
			if !jsonMode {
				newOutput().OK("No workspace packages affected by staged files")
			}
			return nil
		}

		// Run checks on affected packages only.
		var pkgNames []string
		for name := range stagedPkgs {
			pkgNames = append(pkgNames, name)
		}
		filteredPkgs := ws.FilterByName(pkgNames)
		wsFiltered := *ws
		wsFiltered.Packages = filteredPkgs

		registry := checks.Build(cfg, ws.Root, "gate")
		results := checks.RunAll(&wsFiltered, cfg, registry, nil, nil)

		// Count errors.
		errorCount := 0
		for _, r := range results {
			for _, issue := range r.Issues {
				if issue.Severity == checks.SeverityError {
					errorCount++
				}
			}
		}

		if jsonMode {
			if errorCount > 0 {
				return commandFailure("kb-devkit gate")
			}
			return JSONOut(map[string]any{
				"errors":  errorCount,
				"results": results,
			})
		}

		o := newOutput()
		if errorCount == 0 {
			o.OK(fmt.Sprintf("Gate passed (%d package(s) checked)", len(results)))
			return nil
		}

		o.Err(fmt.Sprintf("Gate blocked — %d error(s) in %d package(s)", errorCount, len(results)))
		for _, r := range results {
			for _, issue := range r.Issues {
				if issue.Severity == checks.SeverityError {
					clikitcommand.Printf("  %s  %s: %s\n",
						o.errStyle.Render("✕"),
						r.Package.Name,
						issue.Message,
					)
				}
			}
		}
		return commandFailure("kb-devkit gate")
	},
}

func init() {
	rootCmd.AddCommand(gateCmd)
}

func getStagedFiles() ([]string, error) {
	result, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "git", Executable: "git", Args: []string{"diff", "--cached", "--name-only"}, Operation: toolchain.OperationVersionProbe})
	if err != nil {
		return nil, fmt.Errorf("git diff --cached: %w", err)
	}

	var files []string
	for _, line := range strings.Split(result.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}
