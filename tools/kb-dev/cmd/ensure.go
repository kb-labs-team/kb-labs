package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/kb-labs/dev/internal/manager"
	"github.com/kb-labs/dev/internal/scenario"
	"github.com/spf13/cobra"
)

var ensureCmd = &cobra.Command{
	Use:   "ensure <targets...>",
	Short: "Ensure services are alive (idempotent, agent-friendly)",
	Long: `Idempotent desired state command. For each target:
  - Already alive → skip
  - Dead → start (with dependencies)
  - Failed → restart

With --scenario PATH, applies a scenario.yaml: writes its overlays into
.kb/overlays/, restarts the listed services, and ensures its domain group.
--scenario default removes scenario-managed overlays and is a no-op when
the overlay state is already clean.

Returns ok:true only when ALL targets are alive.`,
	Args: func(cmd *cobra.Command, args []string) error {
		if v, _ := cmd.Flags().GetString("scenario"); v != "" {
			return nil
		}
		if len(args) < 1 {
			return fmt.Errorf("requires at least 1 service target (or --scenario PATH)")
		}
		return nil
	},
	RunE: runEnsure,
}

func init() {
	ensureCmd.Flags().String("scenario", "", "apply a scenario.yaml (path) or `default` to reset overlays")
	rootCmd.AddCommand(ensureCmd)
}

func runEnsure(cmd *cobra.Command, args []string) error {
	if scenarioPath, _ := cmd.Flags().GetString("scenario"); scenarioPath != "" {
		return runEnsureScenario(cmd, scenarioPath)
	}

	mgr, err := loadManager()
	if err != nil {
		return err
	}
	if err := ensureSupportedRuntime(cmd, mgr); err != nil {
		return err
	}

	result := mgr.Ensure(cmd.Context(), args)
	return emitEnsureResult(result)
}

// runEnsureScenario applies a scenario.yaml against the current project.
//
// Flow:
//  1. Load scenario.yaml (or treat the literal `default` as a reset).
//  2. ComputeDiff against the existing `.kb/overlays/` state and Apply.
//  3. If the scenario declares a Domain group, ensure those services are
//     alive (covers cold start).
//  4. If the plan was non-empty AND Restarts is non-empty, restart the
//     listed services so they pick up the new overlay state.
//
// Idempotent: a repeat invocation with no overlay drift produces an empty
// plan and skips the restart phase.
func runEnsureScenario(cmd *cobra.Command, scenarioPath string) error {
	var scen *scenario.Scenario
	if scenarioPath == scenario.DefaultScenarioName {
		scen = nil // ComputeDiff(nil) is the reset operation
	} else {
		path := scenarioPath
		if !filepath.IsAbs(path) {
			path = filepath.Clean(path)
		}
		s, err := scenario.Load(path)
		if err != nil {
			return err
		}
		scen = s
	}

	// Manager is only needed when the scenario asks us to mutate services
	// (Restarts) or to ensure a domain group alive. For pure-overlay or
	// `--scenario default` invocations we never touch the service manager,
	// so we can run without `devservices.yaml` — useful for CI hosts that
	// orchestrate the platform via Docker and only need overlay file ops.
	needsManager := scen != nil && (len(scen.Restarts) > 0 || scen.Domain != "")

	projectRoot, err := resolveScenarioProjectRoot(needsManager)
	if err != nil {
		return err
	}

	plan, err := scenario.ComputeDiff(projectRoot, scen)
	if err != nil {
		return err
	}
	if err := plan.Apply(); err != nil {
		return err
	}

	combined := &manager.Result{OK: true}
	for _, a := range plan.Actions {
		combined.Actions = append(combined.Actions, manager.Action{
			Service: scenarioServiceLabel(scen),
			Action:  "overlay-" + a.Op,
			Reason:  a.File,
		})
	}

	if !needsManager {
		return emitEnsureResult(combined)
	}

	mgr, err := loadManager()
	if err != nil {
		return err
	}

	// Cold-start handling: ensure the scenario's domain group is alive, even
	// when the plan was empty (e.g. files were already on disk but services
	// were dead).
	if scen.Domain != "" {
		members := mgr.GroupMembers(scen.Domain)
		if len(members) > 0 {
			ensured := mgr.Ensure(cmd.Context(), members)
			combined.Actions = append(combined.Actions, ensured.Actions...)
			if !ensured.OK {
				combined.OK = false
				combined.Hint = ensured.Hint
				return emitEnsureResult(combined)
			}
		}
	}

	// Restart only when the overlay state actually changed. A clean
	// re-apply is a true no-op.
	if !plan.IsEmpty() && len(scen.Restarts) > 0 {
		restarted := mgr.Restart(cmd.Context(), scen.Restarts, false, false)
		combined.Actions = append(combined.Actions, restarted.Actions...)
		if !restarted.OK {
			combined.OK = false
			combined.Hint = restarted.Hint
		}
	}

	return emitEnsureResult(combined)
}

// resolveScenarioProjectRoot picks the project root for overlay file
// operations. When the scenario needs the service manager (restarts or
// domain) we go through the normal `devservices.yaml` discovery so we
// agree on the project root with the rest of kb-dev. When it doesn't,
// we accept a missing `devservices.yaml` and walk up looking for a
// `.kb/` marker directory. If neither is found we ERROR — silently
// writing overlay files to an unrelated cwd would be a footgun: the
// command would report success while applying to the wrong project.
func resolveScenarioProjectRoot(needsManager bool) (string, error) {
	cfg, err := FindConfig()
	if err == nil {
		return cfg.ProjectDir, nil
	}
	if needsManager {
		return "", err
	}
	cwd, werr := os.Getwd()
	if werr != nil {
		return "", werr
	}
	dir := cwd
	for {
		if info, statErr := os.Stat(filepath.Join(dir, ".kb")); statErr == nil && info.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no project root found: walked up from %s but neither devservices.yaml nor .kb/ directory exists. Run from inside a KB Labs project or pass --config explicitly", cwd)
		}
		dir = parent
	}
}

func scenarioServiceLabel(s *scenario.Scenario) string {
	if s == nil {
		return "scenario:default"
	}
	return "scenario:" + s.Name
}

func emitEnsureResult(result *manager.Result) error {
	if !result.OK {
		return serviceCommandFailure("kb-dev ensure", result)
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
			out.Info(a.Service + " " + a.Reason)
		case "stopped":
			out.OK(a.Service + " stopped")
		case "overlay-write":
			out.OK(a.Service + " wrote " + a.Reason)
		case "overlay-remove":
			out.Info(a.Service + " removed " + a.Reason)
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

	return nil
}
