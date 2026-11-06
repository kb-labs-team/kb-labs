package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
	"github.com/spf13/cobra"
)

var (
	runAffected    bool
	runDiffOnly    bool
	runPackages    []string
	runNoCache     bool
	runLive        bool
	runConcurrency int
)

var runCmd = &cobra.Command{
	Use:   "run <task> [task2 ...]",
	Short: "Run tasks across the workspace with content-addressable caching",
	Long: `Runs one or more named tasks (build, lint, test, type-check, or custom)
across all packages in dependency order.

Results are cached by input hash — identical inputs skip execution and
restore outputs instantly. Cache lives in .kb/devkit/.

Examples:
  kb-devkit run build
  kb-devkit run build lint
  kb-devkit run build lint test --affected
  kb-devkit run build --packages @acme/core-types,@acme/core-runtime
  kb-devkit run build --no-cache
  kb-devkit run deploy`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		// Require tasks to be declared in devkit.yaml.
		if len(cfg.Tasks) == 0 {
			return fmt.Errorf("no tasks defined in devkit.yaml\n\n  Add a tasks: section or run `kb-devkit init` to generate a starter config")
		}
		for _, task := range args {
			if _, ok := cfg.Tasks[task]; !ok {
				return diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Task %q is not declared in devkit.yaml.", task),
					diag.WithHint("Add the task under tasks: in devkit.yaml, or run `kb-devkit run build` for the standard build task."))
			}
		}

		cacheRoot := filepath.Join(ws.Root, ".kb", "devkit")

		// Resolve package filter.
		var pkgs []workspace.Package
		switch {
		case runAffected:
			pkgs, err = engine.AffectedRunPackages(ws, cfg, args, cacheRoot, runDiffOnly)
			if err != nil {
				return fmt.Errorf("affected: %w", err)
			}
			if len(pkgs) == 0 {
				o := newOutput()
				o.OK("No affected or dirty packages — nothing to run")
				return nil
			}
		case len(runPackages) > 0:
			pkgs = ws.FilterByName(runPackages)
			if len(pkgs) == 0 {
				return diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("No workspace packages match --packages %q.", strings.Join(runPackages, ", ")),
					diag.WithHint("Run `kb-devkit deps` to list discovered packages, then rerun with one of those package names."))
			}
		}

		opts := engine.RunOptions{
			Tasks:       args,
			Packages:    pkgs,
			Affected:    runAffected,
			NoCache:     runNoCache,
			LiveOutput:  runLive,
			Concurrency: runConcurrency,
			WSRoot:      ws.Root,
			CacheRoot:   cacheRoot,
		}

		o := newOutput()

		if !jsonMode {
			clikitcommand.Println()
			var outputMu sync.Mutex
			progressWriter := clikitcommand.FromCommand(cmd).ProgressWriter()
			if !stdoutIsTerminal() {
				opts.OnHeartbeat = func(packageName, taskName string, elapsed time.Duration) {
					outputMu.Lock()
					defer outputMu.Unlock()
					fmt.Fprintf(progressWriter, "  [RUN ] %s:%s elapsed %s\n", packageName, taskName, elapsed.Round(time.Second))
				}
			}
			opts.OnResult = func(r engine.TaskResult, done, total int) {
				outputMu.Lock()
				defer outputMu.Unlock()
				printTaskResult(progressWriter, o, r, done, total)
			}
		}

		start := time.Now()
		result, err := engine.Run(ws, cfg, opts)
		elapsed := time.Since(start)
		if err != nil {
			var cycleErr *engine.TaskCycleError
			if errors.As(err, &cycleErr) {
				return taskCycleFailure(cycleErr, args)
			}
			var graphErr *engine.TaskGraphError
			if errors.As(err, &graphErr) {
				return taskGraphFailure(graphErr)
			}
			var accountingErr *engine.RunAccountingError
			if errors.As(err, &accountingErr) {
				return taskAccountingFailure(accountingErr, args)
			}
			return err
		}
		summary, err := result.Summary()
		if err != nil {
			var accountingErr *engine.RunAccountingError
			if errors.As(err, &accountingErr) {
				return taskAccountingFailure(accountingErr, args)
			}
			return err
		}

		if jsonMode {
			payload := map[string]any{
				"results": result.Results,
				"summary": summary,
				"elapsed": elapsed.String(),
			}
			if !result.OK {
				return taskFailure(failedTaskResult(result.Results), payload)
			}
			return JSONOut(payload)
		}

		// Summary line.
		s := summary
		clikitcommand.Printf("\n  %s scheduled  %s  %s  %s  %s  %s not affected  — %s\n\n",
			o.dim.Render(fmt.Sprintf("%d", s.Scheduled)),
			o.healthy.Render(fmt.Sprintf("%d passed", s.Passed)),
			o.dim.Render(fmt.Sprintf("%d cached", s.Cached)),
			colorCount(s.Failed, o),
			o.warning.Render(fmt.Sprintf("%d blocked", s.Blocked)),
			o.dim.Render(fmt.Sprintf("%d", s.NotAffected)),
			elapsed.Round(time.Millisecond),
		)
		if len(s.BlockedTasks) <= 10 {
			for _, blocked := range s.BlockedTasks {
				clikitcommand.Printf("  %s\n", o.dim.Render(fmt.Sprintf("%s:%s blocked-by %s:%s", blocked.Package, blocked.Task, blocked.BlockedByPackage, blocked.BlockedByTask)))
			}
		} else if len(s.BlockedTasks) > 10 {
			clikitcommand.Printf("  %s\n", o.dim.Render("Blocked task details omitted; rerun with --json for the full list."))
		}

		if !result.OK {
			return taskFailure(failedTaskResult(result.Results), summary)
		}
		return nil
	},
}

func failedTaskResult(results []engine.TaskResult) engine.TaskResult {
	for _, result := range results {
		if !result.OK && !result.Cached {
			return result
		}
	}
	return engine.TaskResult{}
}

func init() {
	runCmd.Flags().BoolVar(&runAffected, "affected", false, "run only changed packages + all downstream dependents")
	runCmd.Flags().BoolVar(&runDiffOnly, "diff-only", false, "with --affected, use only the configured diff; do not include dirty or never-run packages")
	runCmd.Flags().StringSliceVar(&runPackages, "packages", nil, "run specific packages (comma-separated)")
	runCmd.Flags().BoolVar(&runNoCache, "no-cache", false, "bypass cache lookup (still stores result)")
	runCmd.Flags().BoolVar(&runLive, "live", false, "stream output while running (forces concurrency=1)")
	runCmd.Flags().IntVar(&runConcurrency, "concurrency", 0, "parallel task limit (default: NumCPU-1)")
	rootCmd.AddCommand(runCmd)
}

func colorCount(n int, o output) string {
	if n == 0 {
		return o.dim.Render("0 failed")
	}
	return o.errStyle.Render(fmt.Sprintf("%d failed", n))
}

func printTaskResult(w io.Writer, o output, r engine.TaskResult, done, total int) {
	counter := o.dim.Render(fmt.Sprintf("[%3d/%-3d]", done, total))
	var icon, result, cache, elapsed string
	if r.OK {
		icon = o.StatusIcon("healthy")
		result = o.dim.Render("success")
	} else {
		icon = o.StatusIcon("error")
		result = o.errStyle.Render("failed")
	}
	if r.Cached {
		cache = o.dim.Render("cached")
	} else {
		cache = o.dim.Render("-")
	}
	elapsed = o.dim.Render(r.Elapsed.Round(time.Millisecond).String())

	// Truncate long package names.
	name := r.Package
	if len(name) > 42 {
		name = "…" + name[len(name)-41:]
	}

	fmt.Fprintf(w, "  %s %s %-42s  %-12s  %-9s  %-7s  %s\n",
		counter,
		icon,
		name,
		o.dim.Render("["+r.Task+"]"),
		result,
		cache,
		elapsed,
	)

	// Print error output inline.
	if !r.OK && !r.Cached {
		lines, hidden := failureTail(r.Stdout, r.Stderr, failLineLimit())
		if hidden > 0 {
			fmt.Fprintf(w, "           %s\n", o.dim.Render(
				fmt.Sprintf("… %d earlier lines hidden (KB_DEVKIT_FAIL_LINES=0 for all)", hidden)))
		}
		for _, line := range lines {
			fmt.Fprintf(w, "           %s\n", o.dim.Render(line))
		}
	}
}

// failLineLimit returns how many trailing lines of a failed task's output to
// print. Defaults to 50; KB_DEVKIT_FAIL_LINES overrides it (0 = unlimited).
func failLineLimit() int {
	limit := 50
	if v := os.Getenv("KB_DEVKIT_FAIL_LINES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			limit = n
		}
	}
	return limit
}

// failureTail combines a failed task's stdout and stderr (stdout first, since
// test runners like vitest and `go test` print assertion detail there and
// summarise the failure at the END) and returns the trailing `limit` lines plus
// the count of lines hidden above them. A limit <= 0 means "return everything".
// Showing the tail — not the first lines of stderr, which are usually setup
// noise — is what makes a failed CI task diagnosable.
func failureTail(stdout, stderr string, limit int) (lines []string, hidden int) {
	combined := strings.TrimRight(stdout, "\n")
	if s := strings.TrimRight(stderr, "\n"); s != "" {
		if combined != "" {
			combined += "\n"
		}
		combined += s
	}
	combined = strings.TrimSpace(combined)
	if combined == "" {
		return nil, 0
	}
	all := strings.Split(combined, "\n")
	start := 0
	if limit > 0 && len(all) > limit {
		start = len(all) - limit
	}
	return all[start:], start
}
