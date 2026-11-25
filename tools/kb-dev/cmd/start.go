package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/kb-labs/dev/internal/config"
	"github.com/spf13/cobra"
)

var startCmd = &cobra.Command{
	Use:   "start [target]",
	Short: "Start all services, a group, or a single service",
	Long:  "Starts services with dependency resolution. Dependencies are started automatically.",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runStart,
}

func init() {
	startCmd.Flags().Bool("watch", false, "stay alive and auto-restart crashed services")
	rootCmd.AddCommand(startCmd)
}

func runStart(cmd *cobra.Command, args []string) error {
	mgr, err := loadManager()
	if err != nil {
		return err
	}
	if err := ensureSupportedRuntime(cmd, mgr); err != nil {
		return err
	}

	target := ""
	if len(args) > 0 {
		target = args[0]
	}

	targets, err := mgr.Config().ResolveTarget(target)
	if err != nil {
		return err
	}

	result := mgr.Start(cmd.Context(), targets, forceFlag)

	if !result.OK {
		return serviceCommandFailure("kb-dev start", result)
	}
	if jsonMode {
		return JSONOut(result)
	}

	out := newOutput()
	for _, a := range result.Actions {
		switch a.Action {
		case "started":
			out.OK(a.Service + " started (" + a.Elapsed + ")")
		case "skipped":
			out.Info(a.Service + " already running")
		case "failed":
			out.Err(a.Service + " failed: " + a.Error)
			for _, line := range a.LogsTail {
				out.Detail(line)
			}
		}
	}

	if result.Hint != "" {
		out.Warn(result.Hint)
	}

	// Watch mode.
	watch, _ := cmd.Flags().GetBool("watch")
	if watch && result.OK {
		out.Info("Watching services (Ctrl+C to stop)...")
		mgr.Watch(cmd.Context())
	}

	if result.OK {
		printHighlights(mgr.Config().Services)
	}

	return nil
}

// printHighlights prints a prominent block for services marked highlight:true.
func printHighlights(services map[string]config.Service) {
	enabled := colorEnabled()
	accent := lipgloss.NewStyle().Bold(true).Foreground(color(enabled, "12"))
	url := lipgloss.NewStyle().Foreground(color(enabled, "14"))
	dim := lipgloss.NewStyle().Foreground(color(enabled, "8"))

	var lines []string
	for _, svc := range services {
		if !svc.Highlight || svc.URL == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("  %s  %s  %s",
			accent.Render("→"),
			url.Render(svc.URL),
			dim.Render(svc.Name),
		))
	}
	if len(lines) == 0 {
		return
	}
	clikitcommand.Println()
	for _, l := range lines {
		clikitcommand.Println(l)
	}
	clikitcommand.Println(dim.Render("  " + strings.Repeat("─", 40)))
}
