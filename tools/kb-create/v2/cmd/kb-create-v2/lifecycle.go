package v2cli

import (
	"context"
	"fmt"
	"reflect"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/versionroot"
)

// installedVersion is the platform version of the active receipt, for messages.
func installedVersion(platformRoot string) string {
	if active, err := receipt.Read(platformRoot); err == nil && active.Plan.ServiceGraph.PlatformVersion != "" {
		return active.Plan.ServiceGraph.PlatformVersion
	}
	return "unknown"
}

// refuseRunningHost stops a fresh apply from starting a trial run next to a
// supervised host: it would fail on the host's port with a misleading message.
// An installed platform is changed with update, which stops and restarts the host.
func refuseRunningHost(platformRoot string) *diag.Diag {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return contracts.NewDiag(contracts.CodeInputRequired, "The installation path is invalid.", "Pass the install root used by this installation, then rerun the command.", err)
	}
	platformRoot = layout.InstallRoot()
	rootState, err := host.StateForRoot(platformRoot)
	if err != nil {
		return contracts.NewDiag(contracts.CodeInputRequired, "The platform path is invalid.", "Pass the platform root used by this installation, then rerun the command.", err)
	}
	record, alive := activeLauncher(rootState)
	if !alive {
		return nil
	}
	installationID, identityErr := versionroot.InstallationIDForPath(platformRoot)
	if identityErr != nil || record.InstallationID != installationID {
		return supervisor.Refusal(record, platformRoot)
	}
	command := contracts.ShellCommand("kb-create", "status", "--platform-root", platformRoot)
	failure := contracts.NewDiag(contracts.CodeHostAlreadyRunning, "The KB Labs host is already running.", "Use `"+command+"` to inspect it.", nil)
	failure.Meta = map[string]any{"pid": fmt.Sprint(record.PID), "platformRoot": record.PlatformRoot, "nextCommand": command}
	return failure
}

func reusableApplyHost(plan contracts.ResolvedInstallPlan, platformRoot string) (*contracts.InstallReceipt, *diag.Diag) {
	if plan.Host == nil {
		return nil, nil
	}
	if refusal := refuseRunningHost(platformRoot); refusal == nil {
		return nil, nil
	} else if refusal.Code != contracts.CodeHostAlreadyRunning {
		return nil, refusal
	}
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return nil, unsupportedPlatformLayout(platformRoot, err)
	}
	activeRoot := layout.PlatformRoot()
	active, err := receipt.Read(activeRoot)
	if err != nil {
		return nil, asDiag(err)
	}
	runner, err := host.NewRunner(activeRoot)
	if err != nil {
		return nil, asDiag(err)
	}
	status, err := runner.Status(context.Background())
	if err != nil {
		return nil, asDiag(err)
	}
	if status.State != host.StateRunning || !status.Healthy || status.ReceiptID != active.ID ||
		active.Plan.Host == nil || plan.Host.Command != active.Plan.Host.Command ||
		!reflect.DeepEqual(plan.Host.Args, active.Plan.Host.Args) || plan.Host.HealthURL != active.Plan.Host.HealthURL ||
		!reflect.DeepEqual(plan.ServiceGraph, active.Plan.ServiceGraph) {
		return nil, host.RootConflict(active.Plan.Request.PlatformRoot, status.PID)
	}
	return &active, nil
}

func refuseForeignHost(platformRoot string) *diag.Diag {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return contracts.NewDiag(contracts.CodeInputRequired, "The installation path is invalid.", "Pass the install root used by this installation, then rerun the command.", err)
	}
	platformRoot = layout.InstallRoot()
	rootState, err := host.StateForRoot(platformRoot)
	if err != nil {
		return contracts.NewDiag(contracts.CodeInputRequired, "The platform path is invalid.", "Pass the platform root used by this installation, then rerun the command.", err)
	}
	record, alive := activeLauncher(rootState)
	if !alive {
		return nil
	}
	installationID, identityErr := versionroot.InstallationIDForPath(platformRoot)
	if identityErr == nil && record.InstallationID == installationID {
		return nil
	}
	return supervisor.Refusal(record, platformRoot)
}

func activeLauncher(state host.State) (supervisor.Record, bool) {
	if active, ok := host.ActiveHost(state); ok {
		return supervisor.Record{PID: active.PID, InstallationID: active.InstallationID, PlatformRoot: active.PlatformRoot}, true
	}
	return supervisor.ReadRecord(state)
}

// snapshotSummary is what the machine output says about a snapshot: never its
// captured files.
func snapshotSummary(snapshot contracts.Snapshot) map[string]any {
	return map[string]any{"id": snapshot.ID, "createdAt": snapshot.CreatedAt, "receiptId": snapshot.ReceiptID}
}

func operationDiagnostic(root, correlationID, logPath string, failure *diag.Diag, plan *contracts.ResolvedInstallPlan) *diag.Diag {
	failure.CorrelationID = correlationID
	dossier := diagnostics.Dossier{CorrelationID: correlationID, Error: failure, Stage: contracts.StageApply, LogPath: logPath}
	if plan != nil {
		dossier.PlanHash, dossier.ReleaseDigest, dossier.ScenarioStateDigest = plan.PlanHash, plan.ReleaseDigest, plan.ScenarioStateDigest
	}
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr != nil {
		return contracts.NewDiag("KB_INSTALL_DIAGNOSTIC_UNAVAILABLE", "The operation failed and the diagnostic dossier could not be written.", "inspect the local operation log", layoutErr)
	}
	path, err := diagnostics.Write(layout.FailureDossiersDir(), dossier, nil)
	if err != nil {
		return contracts.NewDiag("KB_INSTALL_DIAGNOSTIC_UNAVAILABLE", "The operation failed and the diagnostic dossier could not be written.", "inspect the local operation log", err)
	}
	if failure.Meta == nil {
		failure.Meta = map[string]any{}
	}
	failure.Meta["logPath"], failure.Meta["diagnosticPath"] = logPath, path
	return failure
}
