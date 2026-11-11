package v2cli

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
)

type doctorFixResult struct {
	OK            bool              `json:"ok"`
	Operation     string            `json:"operation"`
	Findings      []doctor.Finding  `json:"findings"`
	Repair        doctor.RepairPlan `json:"repair"`
	Snapshot      map[string]any    `json:"snapshot"`
	HostRestarted bool              `json:"hostRestarted"`
}

func (doctorFixResult) doctorOperationResult() {}

type doctorOperationResult interface {
	doctorOperationResult()
}

type doctorCommandInput struct {
	Command      *cobra.Command
	PlatformRoot string
	Executable   string
	InputFile    string
	Fix          bool
	Recover      recoverRequest
	Foreground   bool
}

func executeDoctor(_ context.Context, input doctorCommandInput) (doctorOperationResult, *diag.Diag) {
	in := input
	root := in.PlatformRoot
	if root == "" {
		root = defaultPlatformRoot()
	}
	if _, err := (secrets.Store{PlatformRoot: root}).BootstrapCompleted(); err != nil {
		return nil, asDiag(err)
	}
	if in.Recover.Enabled {
		return executeRecover(input)
	}
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr != nil {
		return nil, unsupportedPlatformLayout(root, layoutErr)
	}
	platformRoot := layout.PlatformRoot()
	in.PlatformRoot = root
	if in.InputFile == "" {
		if _, err := receipt.Read(platformRoot); err != nil {
			return nil, contracts.NewDiag(contracts.CodeReceiptUnavailable, "No active installation receipt was found.", "Run `kb-create install` to create the platform, then retry `kb-create doctor`.", err)
		}
	}
	var doctorInput doctor.Input
	var err error
	var manifestFindings []doctor.Finding
	if in.InputFile != "" {
		data, readErr := os.ReadFile(in.InputFile)
		if readErr != nil {
			return nil, contracts.NewDiag("KB_INSTALL_INPUT_REQUIRED", "doctor input could not be read", "supply a readable V2 doctor input JSON file", readErr)
		}
		doctorInput, err = doctor.Decode(data)
	} else {
		active, readErr := receipt.Read(platformRoot)
		if readErr != nil {
			err = fmt.Errorf("read active V2 receipt: %w", readErr)
		} else if active.Plan.ServiceGraph.Profile == "client" {
			doctorInput = doctor.Input{Configured: map[string]bool{}}
		} else {
			issues, inspectErr := installed.InspectProjections(platformRoot, active.Plan.Artifacts)
			if inspectErr != nil {
				err = inspectErr
			} else if len(issues) > 0 {
				manifestFindings = projectionFindings(issues)
			} else {
				doctorInput, err = automaticDoctorInput(platformRoot)
			}
		}
	}
	if err != nil {
		return nil, contracts.NewDiag("KB_INSTALL_DOCTOR_INPUT_INVALID", "installed manifest diagnostics could not be prepared", "install exact V2 artifacts that ship matching V2 manifests", err)
	}
	findings := append(doctor.Diagnose(doctorInput.Manifests, doctorInput.Configured), manifestFindings...)
	response := doctor.Response{Findings: findings, Repair: doctor.PlanRepair(findings)}
	state, stateErr := host.StateForRoot(root)
	if stateErr != nil {
		return nil, asDiag(stateErr)
	}
	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		return nil, asDiag(homeErr)
	}
	registryPath := gateway.RegistryPath(home)
	registryRoots, registryErr := (gateway.Registry{Path: registryPath, OperationRoot: root}).Read()
	if registryErr != nil {
		return nil, asDiag(registryErr)
	}
	if active, activeErr := receipt.Read(platformRoot); activeErr == nil && active.Plan.Host != nil {
		origin := recordedGatewayURL(active)
		registered := false
		for _, row := range registryRoots {
			if row.InstallationID == active.InstallationID && row.URL == origin {
				registered = true
				break
			}
		}
		if origin != "" && !registered {
			response.Findings = append(response.Findings, doctor.Finding{Code: contracts.CodeGatewayIndexUnavailable,
				Severity: doctor.SeverityError, Component: "kb-create", Path: registryPath, SafeFix: true,
				Action: "gateway-registry-row-from-receipt",
				Hint:   "Run `" + contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root) + "` to restore this row from the validated installation receipt."})
			response.Repair = doctor.PlanRepair(response.Findings)
		}
	}
	shimClassification := shim.Classification{Kind: shim.ClassificationAbsent}
	if in.Executable != "" {
		shimClassification, err = shim.Classify(in.Executable, platformRoot)
		if err != nil {
			return nil, contracts.NewDiag(contracts.CodeOperationFailed, "the kb command ownership could not be classified", "check the launcher directory and installation layout, then retry `kb-create doctor`", err)
		}
		if shimClassification.Kind == shim.ClassificationForeign {
			response.Findings = append(response.Findings, doctor.Finding{Code: "KB_INSTALL_SHIM_DANGLING", Severity: doctor.SeverityError,
				Component: "kb-create", Path: shim.Path(in.Executable), Hint: foreignShimHint(shimClassification, root)})
		}
	}
	if active, readErr := receipt.Read(platformRoot); readErr == nil {
		response.PlatformChannel, response.PlatformVersion = active.Plan.PlatformChannel, active.Plan.ServiceGraph.PlatformVersion
		response.InstalledVersion = active.Plan.ServiceGraph.PlatformVersion
		response.Profile = active.Plan.ServiceGraph.Profile
		runningRoot := ""
		if runner, runnerErr := host.NewRecordedRunner(root); runnerErr == nil {
			if running, statusErr := runner.Status(context.Background()); statusErr == nil {
				response.RunningVersion = running.PlatformVersion
				response.PendingRestart = pendingRestart(active, running, root)
				if running.PID > 0 {
					runningRoot = running.TreeRoot
				}
			}
		}
		if layoutErr := layout.Validate(); layoutErr != nil {
			return nil, unsupportedPlatformLayout(root, layoutErr)
		}
		versions, retentionErr := layout.Retained(runningRoot)
		if retentionErr != nil {
			return nil, contracts.NewDiag(contracts.CodeOperationFailed, "retained platform versions could not be inspected", "check that the installed root and its version directory are readable, then retry `kb-create doctor`", retentionErr)
		}
		snapshots, retentionErr := receipt.ListSnapshots(layout.SnapshotsDir())
		if retentionErr != nil {
			return nil, contracts.NewDiag(contracts.CodeOperationFailed, "recovery snapshots could not be inspected", "check the V2 receipt directory, then retry `kb-create doctor`", retentionErr)
		}
		response.Retention = &doctor.RetentionReport{InstallRoot: root, PlatformRoot: platformRoot,
			VersionsDirectory: layout.VersionsDir(), SharedState: layout.SharedStateDir(), InstallerState: layout.InstallerStateDir(),
			HostState: layout.HostStateDir(),
			Versions:  versions, Snapshots: snapshots}
	}
	marketplaceSources, sourcesErr := marketplaceSourceStatus(platformRoot)
	if sourcesErr != nil {
		return nil, contracts.NewDiag(contracts.CodeApplyFailed, "The installed Marketplace source configuration could not be read.", "Run `kb-create status` to inspect the source configuration, repair the installed configuration, then retry `kb-create doctor`.", sourcesErr)
	}
	installation := doctor.InspectInstallation(platformRoot, state)
	if in.Executable != "" && shimClassification.Kind != shim.ClassificationOwned {
		hint := "Run `" + contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root) + "` to repair the command shim."
		switch shimClassification.Kind {
		case shim.ClassificationForeign:
			hint = foreignShimHint(shimClassification, root)
		case shim.ClassificationOtherInstallation:
			hint = otherInstallationShimHint(shimClassification, root)
		}
		installation.Checks = append(installation.Checks, doctor.Check{ID: "kb-command-shim", Detail: "The `kb` command shim is missing, foreign, or points to another installation.", Hint: hint})
		installation.OK = false
	}
	platform := in.inspectPlatform()
	response.Installation, response.Platform = &installation, &platform
	response.OK = !doctor.HasErrors(response.Findings) && installation.OK && platform.OK
	response.Installed = installation.OK
	for _, check := range platform.Checks {
		if check.ID == "host-process" && check.OK {
			response.Running, response.Reachable = true, true
		}
	}
	response.Next = "kb-create install"
	if response.Installed {
		response.Next = "kb-create start"
		if response.Profile == "client" {
			response.Next = "kb auth login --gateway-url <url> --email <member>"
		}
		if response.Running {
			response.Next = "cd ~/any-project && kb commit"
		}
	}
	if len(manifestFindings) > 0 {
		response.Next = "kb-create doctor --fix"
	}
	if in.Fix {
		if in.PlatformRoot == "" {
			return nil, contracts.NewDiag(contracts.CodeInputRequired, "--platform-root is required with --fix", "pass the V2 platform root that owns the active receipt", nil)
		}
		return executeDoctorFix(in, response)
	}
	status := "healthy"
	if !response.OK {
		status = "unhealthy"
	}
	return doctorCommandResult{Operation: "doctor", Status: status, MarketplaceSources: marketplaceSources, Response: response}, nil
}

func foreignShimHint(classification shim.Classification, platformRoot string) string {
	remove := contracts.ShellCommand("rm", "--", classification.Link)
	repair := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", platformRoot)
	if classification.LinkIsSymlink {
		return fmt.Sprintf("The `kb` link %s points to %s. It cannot be mapped to a validated installation, so KB Labs considers it foreign and will not change it. Inspect the target first, then run %s to remove this link and %s to recreate the shim.",
			contracts.ShellCommand(classification.Link), contracts.ShellCommand(classification.Target), remove, repair)
	}
	return fmt.Sprintf("The `kb` launcher path %s is an existing file, not a link to a validated installation, so KB Labs considers it foreign and will not change it. Inspect the file first, then run %s to remove it and %s to recreate the shim.",
		contracts.ShellCommand(classification.Link), remove, repair)
}

func otherInstallationShimHint(classification shim.Classification, platformRoot string) string {
	remove := contracts.ShellCommand("rm", "--", classification.Link)
	repair := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", platformRoot)
	return fmt.Sprintf("The `kb` link %s points to validated installation %s. KB Labs leaves it with that installation. To switch deliberately, inspect the target, run %s to remove this link, then run %s to recreate it for the requested installation.",
		contracts.ShellCommand(classification.Link), contracts.ShellCommand(classification.Owner), remove, repair)
}

func executeDoctorFix(input doctorCommandInput, response doctor.Response) (doctorFixResult, *diag.Diag) {
	if len(response.Findings) == 1 && response.Findings[0].Action == "gateway-registry-row-from-receipt" {
		layout, err := versionroot.ForPlatformPath(input.PlatformRoot)
		if err != nil {
			return doctorFixResult{}, unsupportedPlatformLayout(input.PlatformRoot, err)
		}
		activeRoot, err := layout.Active()
		if err != nil {
			return doctorFixResult{}, unsupportedPlatformLayout(input.PlatformRoot, err)
		}
		active, err := receipt.Read(activeRoot)
		if err != nil {
			return doctorFixResult{}, asDiag(err)
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return doctorFixResult{}, asDiag(err)
		}
		registryPath := gateway.RegistryPath(home)
		origin := recordedGatewayURL(active)
		if active.Plan.Host == nil || origin == "" {
			reason := "the validated installation receipt has no Gateway address to restore"
			failure := (gateway.Registry{Path: registryPath, OperationRoot: input.PlatformRoot}).Unavailable(reason, nil,
				"the validated installation receipt has no Gateway address to restore",
				"inspect the active receipt before rebuilding the launcher Gateway index")
			return doctorFixResult{}, failure
		}
		registry := gateway.Registry{Path: registryPath, OperationRoot: input.PlatformRoot}
		if err := registry.Writer(gateway.DoctorFix).Register(activeRoot, origin); err != nil {
			return doctorFixResult{}, asDiag(err)
		}
		return doctorFixResult{OK: true, Operation: "doctor-fix", Findings: []doctor.Finding{},
			Repair: doctor.PlanRepair(nil), Snapshot: map[string]any{}, HostRestarted: false}, nil
	}
	return input.fixDoctor(response)
}

func renderDoctorPlatformChecks(checks []doctor.Check) string {
	var lines []string
	for _, check := range checks {
		if check.Slot != "" {
			lines = append(lines, fmt.Sprintf("Adapter %s: mode=%s implementation=%s", check.Slot, check.Mode, check.Implementation))
			if !check.OK {
				if check.Detail != "" {
					lines = append(lines, "Problem: "+check.Detail)
				}
				if check.Hint != "" {
					lines = append(lines, "Next: "+check.Hint)
				}
			}
		} else if check.ID == "adapters" {
			lines = append(lines, "Adapters: "+check.Detail)
			if check.Hint != "" {
				lines = append(lines, "Next: "+check.Hint)
			}
		}
	}
	return strings.Join(lines, "\n")
}
