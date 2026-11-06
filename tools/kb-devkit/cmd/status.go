package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"

	"github.com/kb-labs/devkit/internal/checks"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show workspace health table",
	Long:  `Displays a grouped health table of all packages in the workspace.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		registry := checks.Build(cfg, ws.Root, "check")
		results := checks.RunAll(ws, cfg, registry, nil, nil)

		if jsonMode {
			return outputStatusJSON(results)
		}

		return outputStatusHuman(results)
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
}

type statusJSONResult struct {
	OK       bool                   `json:"ok"`
	Packages map[string]statusEntry `json:"packages"`
	Summary  statusSummary          `json:"summary"`
}

type statusEntry struct {
	State    string         `json:"state"`
	Category string         `json:"category"`
	Issues   []checks.Issue `json:"issues,omitempty"`
}

type statusSummary struct {
	Healthy int `json:"healthy"`
	Warning int `json:"warning"`
	Error   int `json:"error"`
	Total   int `json:"total"`
}

func outputStatusJSON(results map[string]checks.PackageResult) error {
	out := statusJSONResult{
		OK:       true,
		Packages: make(map[string]statusEntry, len(results)),
	}

	for name, r := range results {
		state := "healthy"
		for _, issue := range r.Issues {
			if issue.Severity == checks.SeverityError {
				state = "error"
				break
			} else if issue.Severity == checks.SeverityWarning && state == "healthy" {
				state = "warning"
			}
		}
		if state == "error" {
			out.OK = false
		}
		out.Packages[name] = statusEntry{
			State:    state,
			Category: r.Package.Category,
			Issues:   r.Issues,
		}
		out.Summary.Total++
		switch state {
		case "healthy":
			out.Summary.Healthy++
		case "warning":
			out.Summary.Warning++
		case "error":
			out.Summary.Error++
		}
	}

	if !out.OK {
		return commandFailure("kb-devkit status")
	}
	return JSONOut(out)
}

func outputStatusHuman(results map[string]checks.PackageResult) error {
	o := newOutput()

	// Group by category.
	byCategory := make(map[string][]checks.PackageResult)
	var categories []string
	seen := make(map[string]bool)
	for _, r := range results {
		cat := r.Package.Category
		if !seen[cat] {
			seen[cat] = true
			categories = append(categories, cat)
		}
		byCategory[cat] = append(byCategory[cat], r)
	}

	healthy, warning, errCount := 0, 0, 0

	clikitcommand.Printf("\n%s\n\n", o.label.Render("KB Devkit — Workspace Status"))

	for _, cat := range categories {
		clikitcommand.Printf("  %s\n", o.dim.Render("["+cat+"]"))

		for _, r := range byCategory[cat] {
			state := "healthy"
			for _, issue := range r.Issues {
				if issue.Severity == checks.SeverityError {
					state = "error"
					break
				} else if issue.Severity == checks.SeverityWarning && state == "healthy" {
					state = "warning"
				}
			}

			switch state {
			case "healthy":
				healthy++
			case "warning":
				warning++
			case "error":
				errCount++
			}

			clikitcommand.Printf("  %s %-40s  %s\n",
				o.StatusIcon(state),
				r.Package.Name,
				o.dim.Render(r.Package.RelPath),
			)

			if state != "healthy" {
				for _, issue := range r.Issues {
					if issue.Severity == checks.SeverityError {
						clikitcommand.Printf("       %s\n", o.dim.Render("↳ "+issue.Message))
					}
				}
			}
		}
		clikitcommand.Println()
	}

	clikitcommand.Printf("  %s  %s  %s  (%d total)\n",
		o.StatusIcon("healthy")+" "+fmt.Sprintf("%d healthy", healthy),
		o.StatusIcon("warning")+" "+fmt.Sprintf("%d warning", warning),
		o.StatusIcon("error")+" "+fmt.Sprintf("%d error", errCount),
		healthy+warning+errCount,
	)
	clikitcommand.Println()

	if errCount > 0 {
		return commandFailure("kb-devkit status")
	}
	return nil
}
