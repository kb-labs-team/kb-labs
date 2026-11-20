package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/kb-labs/dev/internal/config"
	"github.com/kb-labs/dev/internal/manager"
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
		if jsonMode {
			return commandFailureWithData("kb-dev start", safeStartResult(result, mgr.LogPath))
		}
		return commandFailure("kb-dev start")
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

type structuredStartResult struct {
	OK      bool                    `json:"ok"`
	Actions []structuredStartAction `json:"actions,omitempty"`
}

type structuredStartAction struct {
	Service          string                      `json:"service"`
	Action           string                      `json:"action"`
	ErrorCode        manager.ActionErrorCode     `json:"errorCode,omitempty"`
	HealthReason     manager.HealthFailureReason `json:"healthReason,omitempty"`
	LastProbeReason  manager.HealthFailureReason `json:"lastProbeReason,omitempty"`
	HealthStatusCode int                         `json:"healthStatusCode,omitempty"`
	LogPath          string                      `json:"logPath,omitempty"`
}

func safeStartResult(result *manager.Result, logPath func(string) string) *structuredStartResult {
	if result == nil {
		return nil
	}
	safe := &structuredStartResult{OK: result.OK, Actions: make([]structuredStartAction, len(result.Actions))}
	for i, action := range result.Actions {
		errorCode := action.ErrorCode
		if action.Action == "failed" && !knownActionErrorCode(errorCode) {
			errorCode = manager.ActionErrorServiceStartFailed
		}
		safe.Actions[i] = structuredStartAction{
			Service: action.Service, Action: action.Action, ErrorCode: errorCode,
			HealthReason:     knownHealthReason(action.HealthReason),
			LastProbeReason:  knownHealthReason(action.LastProbeReason),
			HealthStatusCode: safeHealthStatusCode(action.HealthStatusCode),
			LogPath:          logPath(action.Service),
		}
	}
	return safe
}

func knownHealthReason(reason manager.HealthFailureReason) manager.HealthFailureReason {
	switch reason {
	case manager.HealthFailureProbeFailed, manager.HealthFailureHTTPStatus,
		manager.HealthFailureTimeout, manager.HealthFailureProcessExited,
		manager.HealthFailureCancelled:
		return reason
	default:
		return ""
	}
}

func safeHealthStatusCode(code int) int {
	if code < 100 || code > 599 {
		return 0
	}
	return code
}

func knownActionErrorCode(code manager.ActionErrorCode) bool {
	switch code {
	case manager.ActionErrorPortInUse,
		manager.ActionErrorDockerUnavailable,
		manager.ActionErrorProcessStartFailed,
		manager.ActionErrorHealthCheckFailed,
		manager.ActionErrorServiceStartFailed:
		return true
	default:
		return false
	}
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
