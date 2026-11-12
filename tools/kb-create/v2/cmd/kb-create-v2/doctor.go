package v2cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/swap"
	"github.com/kb-labs/create/v2/versionroot"
)

// recoverRequest is `doctor --recover`: the flags the launcher hands to the
// platform's recovery tool. The launcher validates none of them; the tool owns
// what an administrator account is.
type recoverRequest struct {
	Enabled       bool
	Email, Tenant string
	PasswordStdin bool
	Generate      bool
	Yes           bool
	JSON          bool
}

func (r recoverRequest) args() []string {
	var args []string
	if r.Email != "" {
		args = append(args, "--email", r.Email)
	}
	if r.Tenant != "" {
		args = append(args, "--tenant", r.Tenant)
	}
	for _, flag := range []struct {
		name string
		set  bool
	}{{"--password-stdin", r.PasswordStdin}, {"--generate", r.Generate}, {"--yes", r.Yes}, {"--json", r.JSON}} {
		if flag.set {
			args = append(args, flag.name)
		}
	}
	return args
}

type doctorCommandResult struct {
	Operation          string           `json:"operation"`
	Status             string           `json:"status"`
	MarketplaceSources []map[string]any `json:"marketplaceSources,omitempty"`
	doctor.Response
}

func (doctorCommandResult) doctorOperationResult() {}

func (d doctorCommandResult) human() string {
	lines := []string{"Platform diagnosis completed.", "Status: " + d.Status}
	if d.PlatformChannel != "" {
		lines = append(lines, "Platform channel: "+d.PlatformChannel)
	}
	if d.PlatformVersion != "" {
		lines = append(lines, "Platform version: "+d.PlatformVersion)
	}
	for _, source := range d.MarketplaceSources {
		line := fmt.Sprintf("Marketplace source: %s %s", source["kind"], source["url"])
		if source["signingKeyConfigured"] == true {
			line += " (signing key configured)"
		}
		if source["authTokenConfigured"] == true {
			line += " (token configured)"
		}
		lines = append(lines, line)
	}
	if d.PendingRestart != nil {
		lines = append(lines, renderPendingRestart(d.PendingRestart))
	}
	if d.Retention != nil {
		lines = append(lines, "Install root: "+d.Retention.InstallRoot,
			"Platform root: "+d.Retention.PlatformRoot,
			"Version roots directory: "+d.Retention.VersionsDirectory,
			"Shared runtime state: "+d.Retention.SharedState,
			"Installer state: "+d.Retention.InstallerState,
			"Host state: "+d.Retention.HostState)
		for _, version := range d.Retention.Versions {
			lines = append(lines, fmt.Sprintf("Retained version %s (%s): %d bytes", version.Version, version.Role, version.DiskUsageBytes))
		}
		for _, snapshot := range d.Retention.Snapshots {
			lines = append(lines, fmt.Sprintf("Recovery snapshot %s: %d bytes", snapshot.ID, snapshot.DiskUsageBytes))
		}
	}
	var warnings []doctor.Finding
	for _, finding := range d.Findings {
		if finding.Severity == doctor.SeverityWarning {
			warnings = append(warnings, finding)
			continue
		}
		line := "Finding " + finding.Code
		if finding.Component != "" {
			line += ": package=" + finding.Component
		}
		if finding.Path != "" {
			line += " path=" + finding.Path
		}
		lines = append(lines, line)
		if finding.Hint != "" {
			lines = append(lines, "Hint: "+finding.Hint)
		}
	}
	if len(warnings) > 0 {
		lines = append(lines, "Warnings:")
		for _, warning := range warnings {
			action := warning.Action
			if action == "" {
				action = warning.Hint
			}
			lines = append(lines, "Warning "+warning.Code+": "+action)
		}
	}
	for _, section := range []struct {
		name string
		data *doctor.Section
	}{{"installation", d.Installation}, {"platform", d.Platform}} {
		if section.data == nil {
			continue
		}
		for _, check := range section.data.Checks {
			if section.name == "platform" && (check.Slot != "" || check.ID == "adapters") {
				continue
			}
			if check.OK {
				continue
			}
			name := strings.ToUpper(section.name[:1]) + section.name[1:]
			line := name + " check " + check.ID
			if check.Code != "" {
				line += " (" + check.Code + ")"
			}
			if check.Detail != "" {
				line += ": " + check.Detail
			}
			lines = append(lines, line)
			if check.Hint != "" {
				lines = append(lines, "Next: "+check.Hint)
			}
		}
		if section.name == "platform" {
			if text := renderDoctorPlatformChecks(section.data.Checks); text != "" {
				lines = append(lines, strings.Split(text, "\n")...)
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (i doctorCommandInput) inspectPlatform() doctor.Section {
	layout, layoutErr := versionroot.ForPlatformPath(i.PlatformRoot)
	if layoutErr != nil {
		return doctor.NewSection([]doctor.Check{{ID: "host-process", Detail: "The installation layout cannot be resolved: " + layoutErr.Error()}})
	}
	platformRoot := layout.PlatformRoot()
	if active, err := receipt.Read(platformRoot); err == nil && active.Plan.ServiceGraph.Profile == "client" {
		return doctor.NewSection(nil)
	}
	runner, err := host.NewRunner(i.PlatformRoot)
	if err != nil {
		return doctor.NewSection([]doctor.Check{{ID: "host-process", Detail: "The host cannot be inspected: " + err.Error(), Hint: "Repair the installation first."}})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	truth, err := supervisor.Observe(ctx, runner, runner.State)
	if err != nil {
		return doctor.NewSection([]doctor.Check{{ID: "host-process", Detail: "The host status cannot be read: " + err.Error()}})
	}
	status := truth.Status
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return doctor.NewSection([]doctor.Check{{ID: "host-process", Detail: "The active install receipt cannot be read while checking adapter bindings."}})
	}
	platform := doctor.InspectPlatform(ctx, status, nil, active.Plan.ProviderBindings)
	if truth.Kind == supervisor.KindHostExited {
		startHint := "Run `" + contracts.ShellCommand("kb-create", "start", "--platform-root", i.PlatformRoot) + "`."
		detail := "The supervisor is running but its host process has exited."
		if truth.Exit != nil {
			detail = "The supervisor is running but its host process has exited (" + truth.Exit.Cause + ")."
		}
		return doctor.NewSection([]doctor.Check{
			{ID: "host-process", Detail: detail, Hint: startHint},
			{ID: "adapters", Detail: "Adapter status cannot be checked while the host is stopped.", Hint: startHint},
		})
	}
	if status.State == host.StateStopped {
		startHint := "Run `" + contracts.ShellCommand("kb-create", "start", "--platform-root", i.PlatformRoot) + "`."
		for index := range platform.Checks {
			if platform.Checks[index].ID == "host-process" || platform.Checks[index].ID == "adapters" {
				platform.Checks[index].Hint = startHint
			}
		}
	}
	return platform
}

// runDoctorFix applies manifest-declared safe defaults under a snapshot and
// restarts the host so it reads them; a host that no longer starts is rolled
// back like a failed update.
func (i doctorCommandInput) fixDoctor(response doctor.Response) (doctorFixResult, *diag.Diag) {
	root := i.PlatformRoot
	layout, err := versionroot.ForPlatformPath(root)
	if err != nil {
		return doctorFixResult{}, unsupportedPlatformLayout(root, err)
	}
	platformRoot := layout.PlatformRoot()
	activeRoot, activeErr := layout.Active()
	if activeErr != nil {
		return doctorFixResult{}, unsupportedPlatformLayout(root, activeErr)
	}
	projectionRepairRequested := false
	for _, finding := range response.Findings {
		if finding.Code == "KB_INSTALL_MANIFEST_PROJECTION_INVALID" {
			projectionRepairRequested = true
			break
		}
	}
	unresolvedRequiredInput := false
	state, err := host.StateForRoot(root)
	if err != nil {
		return doctorFixResult{}, asDiag(err)
	}
	release, err := state.AcquireOperation("doctor-fix")
	if err != nil {
		return doctorFixResult{}, asDiag(err)
	}
	defer release()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	correlationID := fmt.Sprintf("doctor-fix-%d", time.Now().UTC().UnixNano())
	command := hostCommand{PlatformRoot: root, Executable: i.Executable, Version: buildVersion}
	var snapshot contracts.Snapshot
	result, err := swap.Run(ctx, lifecycleHost{command: command, state: state}, swap.Operation{
		Name:            "repair",
		PreviousVersion: installedVersion(platformRoot),
		KeepStoppedIf:   func() bool { return unresolvedRequiredInput },
		Change: func(context.Context, bool) (string, error) {
			active, receiptErr := receipt.Read(activeRoot)
			if receiptErr != nil {
				return "", receiptErr
			}
			if err := installed.EnsureProjections(activeRoot, active.Plan.Artifacts); err != nil {
				return "", err
			}
			input, inputErr := automaticDoctorInput(activeRoot)
			if inputErr != nil {
				return "", inputErr
			}
			response.Findings = doctor.Diagnose(input.Manifests, input.Configured)
			response.Repair = doctor.PlanRepair(response.Findings)
			if projectionRepairRequested {
				// Restoring a missing projection can reveal unrelated required
				// credentials. Those cannot block the explicitly requested file
				// repair, and remain visible in the resulting findings.
				unresolvedRequiredInput = len(response.Repair.RequiredInput) > 0
			}
			repairPlan := response.Repair
			if projectionRepairRequested {
				repairPlan.RequiredInput = nil
			}
			var fixErr error
			snapshot, fixErr = runtime.DoctorFix(activeRoot, repairPlan, runtime.Dependencies{})
			return snapshot.ID, fixErr
		},
		Restore: func(_ context.Context, id string) error {
			_, restoreErr := lifecycle.Rollback(platformRoot, layout.SnapshotsDir(), id, nil)
			return restoreErr
		},
	})
	if err != nil {
		return doctorFixResult{}, operationDiagnostic(root, correlationID, "", asDiag(err), nil)
	}
	if active, receiptErr := receipt.Read(platformRoot); receiptErr == nil && active.Plan.Host != nil {
		if origin := recordedGatewayURL(active); origin != "" {
			registry := gateway.Registry{OperationRoot: root}
			if registryErr := registry.Writer(gateway.DoctorFix).Register(platformRoot, origin); registryErr != nil {
				return doctorFixResult{}, asDiag(registryErr)
			}
		}
	}
	if filepath.Base(i.Executable) == "kb-create" {
		if _, shimErr := shim.Ensure(i.Executable, platformRoot); shimErr != nil {
			return doctorFixResult{}, shimFailure("KB_INSTALL_APPLY_FAILED", root, shimErr)
		}
	}
	fixOK := !unresolvedRequiredInput
	// Safe projection repair is complete even when the repair plan still names
	// user input. Return through clikit's success boundary so that the structured
	// repair.requiredInput details remain in data instead of becoming a generic
	// unhealthy-status error.
	return doctorFixResult{OK: fixOK, Operation: "doctor-fix", Findings: response.Findings, Repair: response.Repair, Snapshot: snapshotSummary(snapshot), HostRestarted: result.WasRunning && !unresolvedRequiredInput}, nil
}

// runRecover runs the platform's recovery tool with the host stopped, so the
// tool is the only writer of the platform database. The launcher supplies the
// host's environment and working directory, and the terminal (a password may
// arrive on stdin); it does not interpret the tool's result beyond its status.
func automaticDoctorInput(platformRoot string) (doctor.Input, error) {
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return doctor.Input{}, fmt.Errorf("read active V2 receipt: %w", err)
	}
	manifests, err := installed.LoadAll(platformRoot, active.Plan.Artifacts)
	if err != nil {
		return doctor.Input{}, err
	}
	paths := make([]string, 0)
	for _, manifest := range manifests {
		for _, requirement := range manifest.Requirements {
			paths = append(paths, requirement.Path)
		}
	}
	configured, err := installed.ConfiguredPaths(platformRoot, paths)
	if err != nil {
		return doctor.Input{}, err
	}
	return installed.DoctorInput(platformRoot, active.Plan.Artifacts, configured)
}

func projectionFindings(issues []installed.ProjectionIssue) []doctor.Finding {
	findings := make([]doctor.Finding, 0, len(issues))
	for _, issue := range issues {
		findings = append(findings, doctor.Finding{
			Code:      "KB_INSTALL_MANIFEST_PROJECTION_INVALID",
			Severity:  doctor.SeverityError,
			Component: issue.Package,
			Path:      filepath.Join("node_modules", issue.Package, "kb-create.manifest.json"),
			Hint:      issue.Reason + ". Run `kb-create doctor --fix`.",
		})
	}
	return findings
}
