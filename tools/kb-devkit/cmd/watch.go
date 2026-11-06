package cmd

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	clikitresult "github.com/kb-labs/clikit/result"
	clikitstream "github.com/kb-labs/clikit/stream"
	"github.com/kb-labs/devkit/internal/checks"
	"github.com/kb-labs/devkit/internal/watcher"
	"github.com/spf13/cobra"
)

var watchCmd = &cobra.Command{
	Use:   "watch",
	Short: "Watch workspace for changes and stream violations",
	Long: `Watches the workspace for file changes and re-runs checks on affected packages.

In --json mode, emits JSONL events (one JSON object per line) for agent consumption.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		var events *clikitstream.Writer
		if jsonMode {
			events = clikitstream.New(clikitcommand.StreamWriter(cmd))
		}
		failStream := func(err error) error {
			d := diag.FromError(err)
			_ = events.Fail(d)
			_ = events.Finish(events.ExitStatus())
			return clikitresult.StreamComplete(events.ExitStatus())
		}
		ws, cfg, err := loadWorkspace()
		if err != nil {
			if events != nil {
				return failStream(err)
			}
			return err
		}

		registry := checks.Build(cfg, ws.Root, "check")

		w, err := watcher.New(ws)
		if err != nil {
			if events != nil {
				return failStream(fmt.Errorf("init watcher: %w", err))
			}
			return fmt.Errorf("init watcher: %w", err)
		}

		o := newOutput()
		if !jsonMode {
			o.Info(fmt.Sprintf("Watching %d packages — press Ctrl+C to stop", len(ws.Packages)))
		}

		w.Start()
		defer w.Stop()

		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

		for {
			select {
			case event := <-w.Events():
				// Re-run checks for the affected package.
				pkg, ok := ws.PackageByPath(event.File)
				if !ok {
					continue
				}

				// Run checks on just this package.
				pkgResults := checks.RunAll(ws, cfg, registry, nil, nil)
				result, ok := pkgResults[pkg.Name]
				if !ok {
					continue
				}

				if jsonMode {
					eventType := watcher.EventCleared
					if len(result.Issues) > 0 {
						eventType = watcher.EventViolation
					}
					if err := events.Event(map[string]any{
						"event":   eventType,
						"package": pkg.Name,
						"file":    event.File,
						"issues":  result.Issues,
						"ts":      event.TS,
					}); err != nil {
						return failStream(err)
					}
				} else {
					if len(result.Issues) == 0 {
						clikitcommand.Printf("%s %s %s\n",
							o.StatusIcon("healthy"),
							o.label.Render(pkg.Name),
							o.dim.Render("— no issues"),
						)
					} else {
						clikitcommand.Printf("%s %s\n", o.StatusIcon("error"), o.label.Render(pkg.Name))
						for _, issue := range result.Issues {
							clikitcommand.Printf("   %s  %s\n", o.SeverityColor(string(issue.Severity)), issue.Message)
						}
					}
				}

			case <-sig:
				if events != nil {
					_ = events.Finish(events.ExitStatus())
					return clikitresult.StreamComplete(events.ExitStatus())
				}
				if !jsonMode {
					clikitcommand.Println()
					o.Info("Stopped")
				}
				return nil
			}
		}
	},
}

func init() {
	rootCmd.AddCommand(watchCmd)
}
