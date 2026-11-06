package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kb-labs/devkit/internal/checks"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
	"github.com/spf13/cobra"
)

var (
	checkPackage             string
	checkInternalToolPackage string
	checkOnly                []string
	debugMode                bool
)

var checkCmd = &cobra.Command{
	Use:   "check",
	Short: "Check workspace packages against devkit rules",
	Long: `Runs all configured rules against packages in the workspace.

Checks include: package_json, tsconfig, tsup, eslint, structure, deps, circular.

Use --only to run a subset of checks.
Use --package to check a single package and retain workspace checks.
Use --internal-tool-package to run package-scoped checks for a declared internal tool.`,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		ws, cfg, err := loadWorkspace()
		if err != nil {
			return err
		}

		registry := checks.Build(cfg, ws.Root, "check")
		if checkPackage != "" && checkInternalToolPackage != "" {
			return diag.New("KB_RUNTIME_INPUT_INVALID", "Choose either --package or --internal-tool-package.",
				diag.WithHint("Run `kb-devkit check --help` to review package scopes."))
		}
		packageName := checkPackage
		includeWorkspaceRules := true
		var packageTargets []workspace.Package
		internalToolScope := cmd.Flags().Changed("internal-tool-package")
		if internalToolScope && checkInternalToolPackage == "" {
			return diag.New("KB_RUNTIME_INPUT_INVALID", "--internal-tool-package requires a package name.",
				diag.WithHint("Rerun with `kb-devkit check --help` to provide an internal-tool package name."))
		}
		if internalToolScope {
			packageName = checkInternalToolPackage
			includeWorkspaceRules = false
			packageTargets, err = internalToolCheckPackage(ws, packageName)
			if err != nil {
				return err
			}
		} else {
			packageTargets = selectedCheckPackages(ws, packageName)
		}
		if err := validateCheckSelection(ws, cfg, registry, checkOnly, packageName, includeWorkspaceRules); err != nil {
			return err
		}
		checksByCategory := selectedCheckCounts(ws, cfg, registry, checkOnly, packageName, includeWorkspaceRules)
		progressWriter := clikitcommand.FromCommand(cmd).ErrorWriter()
		var progressMu sync.Mutex
		progress := func(event checks.ProgressEvent) {
			progressMu.Lock()
			defer progressMu.Unlock()
			state := "DONE"
			if event.Running {
				state = "RUN"
			}
			fmt.Fprintf(progressWriter, "[%s] %s:%s elapsed %s\n", state, event.Package, event.Check, event.Elapsed.Round(time.Second))
		}
		var results map[string]checks.PackageResult
		if includeWorkspaceRules {
			results = checks.RunAllForPackages(ws, packageTargets, cfg, registry, checkOnly, progress)
		} else {
			results = checks.RunPackageRulesForPackages(ws, packageTargets, cfg, registry, checkOnly, progress)
		}
		packagesChecked := checkedPackageCount(results)
		if failures := checkExecutionFailures(results); len(failures) > 0 {
			return externalCheckFailureError(cmd, failures, results)
		}

		if jsonMode {
			return outputCheckJSON(results, cfg, checksByCategory, packagesChecked)
		}

		return outputCheckHuman(results, cfg, checksByCategory, packagesChecked)
	},
}

func init() {
	checkCmd.Flags().StringVar(&checkPackage, "package", "", "check a single package by name")
	checkCmd.Flags().StringVar(&checkInternalToolPackage, "internal-tool-package", "", "run package-scoped checks for a declared internal tool")
	checkCmd.Flags().StringSliceVar(&checkOnly, "only", nil, "run only specific checks (comma-separated)")
	checkCmd.Flags().BoolVar(&debugMode, "debug", false, "include check execution details")
	rootCmd.AddCommand(checkCmd)
}

// ─── JSON output ─────────────────────────────────────────────────────────────

type checkJSONResult struct {
	OK               bool                         `json:"ok"`
	Packages         map[string]packageJSONResult `json:"packages"`
	Results          []checkJSONPackage           `json:"results"`
	Groups           map[string]int               `json:"groups,omitempty"`
	Capabilities     map[string]int               `json:"capabilities,omitempty"`
	Summary          checkSummary                 `json:"summary"`
	ChecksByCategory map[string]int               `json:"checksByCategory"`
	Debug            bool                         `json:"debug,omitempty"`
	Hint             string                       `json:"hint,omitempty"`
}

type packageJSONResult struct {
	OK     bool           `json:"ok"`
	Issues []checks.Issue `json:"issues"`
}

type checkJSONPackage struct {
	Package string         `json:"package"`
	OK      bool           `json:"ok"`
	Issues  []checks.Issue `json:"issues"`
}

type checkSummary struct {
	Total           int `json:"total"`
	Passed          int `json:"passed"`
	Failed          int `json:"failed"`
	Errors          int `json:"errors"`
	Warnings        int `json:"warnings"`
	ChecksRun       int `json:"checksRun"`
	PackagesChecked int `json:"packagesChecked"`
}

func outputCheckJSON(results map[string]checks.PackageResult, cfg *config.DevkitConfig, checksByCategory map[string]int, packagesChecked int) error {
	out := checkJSONResult{
		OK:               true,
		Packages:         make(map[string]packageJSONResult, len(results)),
		Groups:           map[string]int{},
		Capabilities:     map[string]int{},
		ChecksByCategory: checksByCategory,
		Debug:            debugMode,
	}
	out.Summary.ChecksRun = sumCheckCounts(out.ChecksByCategory)
	out.Summary.PackagesChecked = packagesChecked

	for name, r := range results {
		hasErrors := false
		for _, issue := range r.Issues {
			if issue.Severity == checks.SeverityError {
				hasErrors = true
				out.Summary.Errors++
			} else if issue.Severity == checks.SeverityWarning {
				out.Summary.Warnings++
			}
		}

		ok := !hasErrors
		if !ok {
			out.OK = false
		}
		out.Packages[name] = packageJSONResult{
			OK:     ok,
			Issues: r.Issues,
		}
		out.Results = append(out.Results, checkJSONPackage{
			Package: name,
			OK:      ok,
			Issues:  r.Issues,
		})
		category := r.Package.Category
		if r.Package.Name == "workspace" {
			category = "workspace"
		}
		out.Groups[category]++
		for _, issue := range r.Issues {
			cap := string(issue.Capability)
			if cap == "" {
				cap = string(checks.CapabilityManual)
			}
			out.Capabilities[cap]++
		}

		if r.Package.Name != "workspace" {
			out.Summary.Total++
			if ok {
				out.Summary.Passed++
			} else {
				out.Summary.Failed++
			}
		}
	}

	if !out.OK {
		out.Hint = "run 'kb-devkit fix' to auto-fix issues where possible"
	}

	if !out.OK {
		return diag.New("KB_DEVKIT_STANDARDS_VIOLATIONS", "Workspace standards violations were found.",
			diag.WithHint("Review the findings, correct them, then rerun `kb-devkit check`."),
			diag.WithData(out))
	}
	return JSONOut(out)
}

// ─── Human output ─────────────────────────────────────────────────────────────

func outputCheckHuman(results map[string]checks.PackageResult, cfg *config.DevkitConfig, countsByCategory map[string]int, packagesChecked int) error {
	o := newOutput()

	checksRun := sumCheckCounts(countsByCategory)
	clikitcommand.Printf("Workspace check: %d package(s), %d check(s)\n", packagesChecked, checksRun)
	categories := make([]string, 0, len(countsByCategory))
	for category := range countsByCategory {
		categories = append(categories, category)
	}
	sort.Strings(categories)
	for _, category := range categories {
		count := countsByCategory[category]
		clikitcommand.Printf("   %s: %d check(s)\n", category, count)
	}
	totalErrors := 0
	totalWarnings := 0
	totalPassed := 0
	packagesWithFindings := 0

	for _, r := range results {
		if r.Skipped {
			continue
		}

		errCount := 0
		warnCount := 0
		for _, issue := range r.Issues {
			if issue.Severity == checks.SeverityError {
				errCount++
			} else {
				warnCount++
			}
		}
		totalErrors += errCount
		totalWarnings += warnCount
		if (errCount > 0 || warnCount > 0) && r.Package.Name != "workspace" {
			packagesWithFindings++
		}

		if errCount == 0 && warnCount == 0 {
			if r.Package.Name != "workspace" {
				totalPassed++
			}
			continue
		}

		state := "warning"
		if errCount > 0 {
			state = "error"
		}

		clikitcommand.Printf("\n%s %s\n", o.StatusIcon(state), o.label.Render(r.Package.Name))
		clikitcommand.Printf("   %s\n", o.dim.Render(r.Package.RelPath))

		for _, issue := range r.Issues {
			prefix := o.SeverityColor(string(issue.Severity))
			msg := issue.Message
			if issue.File != "" {
				msg += o.dim.Render(" — " + issue.File)
			}
			clikitcommand.Printf("   %s  %s\n", prefix, msg)
			if issue.Fix != "" {
				clikitcommand.Printf("          %s\n", o.dim.Render("fix: "+issue.Fix))
			}
		}
	}

	clikitcommand.Println()
	if totalErrors == 0 && totalWarnings == 0 {
		o.OK(fmt.Sprintf("All %d packages passed", totalPassed))
		return nil
	}

	if totalErrors == 0 {
		o.Warn(fmt.Sprintf("0 error(s), %d warning(s) across %d packages", totalWarnings, packagesWithFindings))
		return nil
	}

	o.Err(fmt.Sprintf("%d error(s), %d warning(s) across %d packages", totalErrors, totalWarnings, packagesWithFindings))
	return diag.New("KB_DEVKIT_STANDARDS_VIOLATIONS", "Workspace standards violations were found.",
		diag.WithHint("Review the findings, correct them, then rerun `kb-devkit check`."))
}

type externalCheckFailure struct {
	Check         string     `json:"check"`
	Cause         string     `json:"cause"`
	ExitCode      int        `json:"exitCode"`
	ExitCodeKnown bool       `json:"exitCodeKnown"`
	StderrTail    string     `json:"stderrTail"`
	RerunCommand  string     `json:"rerunCommand,omitempty"`
	Diagnostic    *diag.Diag `json:"-"`
}

func externalCheckFailureError(cmd *cobra.Command, failures []externalCheckFailure, results map[string]checks.PackageResult) error {
	diagnostics := make([]*diag.Diag, 0, len(failures))
	reportedFailures := make([]externalCheckFailure, len(failures))
	for index, failure := range failures {
		reportedFailures[index] = failure
		if failure.Diagnostic != nil {
			diagnostics = append(diagnostics, failure.Diagnostic)
			continue
		}
		onlyFlag := cmd.Flag("only")
		jsonFlag := cmd.Flag("json")
		if onlyFlag == nil || jsonFlag == nil {
			return fmt.Errorf("cannot construct check rerun command: registered --only or --json flag is missing")
		}
		nextCommand := fmt.Sprintf("%s --%s %s --%s", cmd.CommandPath(), onlyFlag.Name, shellQuoteArgument(failure.Check), jsonFlag.Name)
		reportedFailures[index].RerunCommand = nextCommand
		exitCode := fmt.Sprint(failure.ExitCode)
		stderrTail := failure.StderrTail
		if !failure.ExitCodeKnown {
			exitCode = "unavailable (check ended before an exit status was reported)"
		} else {
			exitCode = fmt.Sprint(failure.ExitCode)
		}
		if stderrTail == "" {
			stderrTail = "(no stderr output captured)"
		}
		diagnostic, err := diag.FromCatalog("KB_DEVKIT_CHECK_EXECUTION_FAILED", map[string]string{
			"check":       failure.Check,
			"exitCode":    exitCode,
			"stderrTail":  stderrTail,
			"nextCommand": nextCommand,
		})
		if err != nil {
			return err
		}
		// A zero child exit can still fail when the managed-process observer
		// cannot prove the child lifecycle. Do not present that as a failed
		// command exit; the underlying cause is the actionable failure.
		if failure.ExitCodeKnown && failure.ExitCode == 0 {
			diagnostic.Message = fmt.Sprintf("Workspace check %s failed: %s", failure.Check, failure.Cause)
		}
		diagnostic.Cause = diag.RedactText(fmt.Sprintf("%s: %s; stderr tail: %s", failure.Check, failure.Cause, stderrTail))
		diagnostics = append(diagnostics, diagnostic)
	}
	if len(diagnostics) == 1 {
		diagnostics[0].Data = map[string]any{"checks": reportedFailures, "packages": results}
		return diagnostics[0]
	}
	messages := make([]string, len(diagnostics))
	hints := make([]string, len(diagnostics))
	causes := make([]string, len(failures))
	for index, diagnostic := range diagnostics {
		messages[index] = diagnostic.Message
		hints[index] = diagnostic.Hint
		causes[index] = fmt.Sprintf("%s: %s", failures[index].Check, diagnostic.Cause)
	}
	return diag.New("KB_DEVKIT_CHECK_EXECUTION_FAILED", strings.Join(messages, "\n"),
		diag.WithMeta(diagnostics[0].Meta),
		diag.WithHint(strings.Join(hints, "\n")),
		diag.WithCause(strings.Join(causes, "\n")),
		diag.WithData(map[string]any{"checks": reportedFailures, "packages": results}))
}

func shellQuoteArgument(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func checkExecutionFailures(results map[string]checks.PackageResult) []externalCheckFailure {
	failures := make(map[string]map[string]*diag.Diag)
	for _, result := range results {
		for _, issue := range result.Issues {
			if issue.CheckFailure {
				if failures[issue.Check] == nil {
					failures[issue.Check] = make(map[string]*diag.Diag)
				}
				if diagnostic, exists := failures[issue.Check][issue.Cause]; !exists || diagnostic == nil {
					failures[issue.Check][issue.Cause] = issue.FailureDiagnostic
				}
			}
		}
	}
	checkNames := make([]string, 0, len(failures))
	for checkName := range failures {
		checkNames = append(checkNames, checkName)
	}
	sort.Strings(checkNames)
	result := make([]externalCheckFailure, 0, len(checkNames))
	for _, checkName := range checkNames {
		causes := make([]string, 0, len(failures[checkName]))
		for cause := range failures[checkName] {
			causes = append(causes, cause)
		}
		sort.Strings(causes)
		for _, cause := range causes {
			var exitCode int
			var exitCodeKnown bool
			var stderrTail string
			for _, packageResult := range results {
				for _, issue := range packageResult.Issues {
					if issue.Check == checkName && issue.Cause == cause {
						exitCode = issue.FailureExitCode
						exitCodeKnown = issue.FailureExitCodeKnown
						stderrTail = issue.FailureStderrTail
					}
				}
			}
			result = append(result, externalCheckFailure{Check: checkName, Cause: cause, ExitCode: exitCode, ExitCodeKnown: exitCodeKnown, StderrTail: stderrTail, Diagnostic: failures[checkName][cause]})
		}
	}
	return result
}

func validateCheckSelection(ws *workspace.Workspace, cfg *config.DevkitConfig, registry *checks.Registry, only []string, packageName string, includeWorkspaceRules bool) error {
	known := make(map[string]bool)
	for _, rule := range registry.All() {
		known[rule.Name()] = true
	}
	if checks.CircularEnabled(cfg) {
		known["circular"] = true
	}
	for _, name := range only {
		if !known[name] {
			return diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Unknown check %q in --only.", name),
				diag.WithHint(fmt.Sprintf("Choose a check from: %s.", strings.Join(sortedKeys(known), ", "))))
		}
	}
	for _, name := range only {
		if name == "circular" && packageName != "" {
			if !includeWorkspaceRules {
				return diag.New("KB_RUNTIME_INPUT_INVALID", "The circular check analyzes the full workspace graph and cannot run in internal-tool package scope.",
					diag.WithHint(fmt.Sprintf("Rerun with `kb-devkit check --internal-tool-package %s` without --only circular.", packageName)))
			}
			return diag.New("KB_RUNTIME_INPUT_INVALID", "The circular check analyzes the full workspace graph and cannot be limited to one package.",
				diag.WithHint("Rerun without --package: kb-devkit check --only circular"))
		}
	}
	pkgs := selectedCheckPackages(ws, packageName)
	if packageName != "" {
		if len(pkgs) == 0 {
			return diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Package %q was not found in the workspace.", packageName),
				diag.WithHint("Run `kb-devkit deps` to list discovered packages, then rerun with one of those package names."))
		}
	}
	count := 0
	for _, pkg := range pkgs {
		preset, err := config.ResolvePreset(pkg.Preset, cfg)
		if err != nil {
			continue
		}
		count += len(registry.ApplicableRulesFor(pkg, preset, only))
	}
	if includeWorkspaceRules {
		count += len(registry.WorkspaceRules(only))
	}
	if len(only) == 1 && only[0] == "circular" && checks.CircularEnabled(cfg) {
		count++
	}
	if count == 0 {
		if packageName != "" && len(pkgs) == 1 {
			pkg := pkgs[0]
			if preset, err := config.ResolvePreset(pkg.Preset, cfg); err == nil {
				if checkName, categories := registry.PackageApplicabilityMismatch(pkg, preset, only); checkName != "" {
					rerunCommand := "kb-devkit check"
					if !includeWorkspaceRules {
						rerunCommand = fmt.Sprintf("kb-devkit check --internal-tool-package %s", pkg.Name)
					}
					return diag.New("KB_RUNTIME_INPUT_INVALID",
						fmt.Sprintf("Check %q does not apply to package %q because its category is %q.", checkName, pkg.Name, pkg.Category),
						diag.WithHint(fmt.Sprintf("%s applies to these categories: %s. Select a package in one of those categories, or run `%s` without --only.", checkName, strings.Join(categories, ", "), rerunCommand)))
				}
			}
		}
		return diag.New("KB_RUNTIME_INPUT_INVALID", "The check selection matched no workspace packages or checks.",
			diag.WithHint("Run `kb-devkit check --help` to review filters, then select a package and check that exist in this workspace."))
	}
	return nil
}

func selectedCheckCounts(ws *workspace.Workspace, cfg *config.DevkitConfig, registry *checks.Registry, only []string, packageName string, includeWorkspaceRules bool) map[string]int {
	counts := make(map[string]int)
	pkgs := selectedCheckPackages(ws, packageName)
	for _, pkg := range pkgs {
		preset, err := config.ResolvePreset(pkg.Preset, cfg)
		if err != nil {
			continue
		}
		applicableCount := len(registry.ApplicableRulesFor(pkg, preset, only))
		if applicableCount > 0 {
			counts[pkg.Category] += applicableCount
		}
	}
	if workspaceRules := len(registry.WorkspaceRules(only)); includeWorkspaceRules && workspaceRules > 0 {
		counts["workspace"] = workspaceRules
	}
	if len(only) == 1 && only[0] == "circular" && checks.CircularEnabled(cfg) {
		counts["circular"] = 1
	}
	return counts
}

func internalToolCheckPackage(ws *workspace.Workspace, packageName string) ([]workspace.Package, error) {
	packages := selectedCheckPackages(ws, packageName)
	if len(packages) == 0 {
		return nil, diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Package %q was not found in the workspace.", packageName),
			diag.WithHint("Run `kb-devkit deps` to list discovered packages, then rerun with one of those package names."))
	}
	if packages[0].ReleaseLane != "internal-tool" {
		return nil, diag.New("KB_RUNTIME_INPUT_INVALID", fmt.Sprintf("Package %q is not declared in the internal-tool release lane.", packageName),
			diag.WithHint("Select a package declared with `releaseLane: internal-tool` in devkit.yaml."))
	}
	return packages, nil
}

func selectedCheckPackages(ws *workspace.Workspace, packageName string) []workspace.Package {
	if packageName != "" {
		return ws.FilterByName([]string{packageName})
	}
	packages := make([]workspace.Package, 0, len(ws.Packages))
	for _, pkg := range ws.Packages {
		if pkg.ReleaseLane != "internal-tool" {
			packages = append(packages, pkg)
		}
	}
	return packages
}

func checkedPackageCount(results map[string]checks.PackageResult) int {
	count := 0
	for _, result := range results {
		if result.Package.Name != "workspace" && !result.Skipped && result.ChecksRun > 0 {
			count++
		}
	}
	return count
}

func sumCheckCounts(counts map[string]int) int {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
