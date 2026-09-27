package v2cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/logs"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/swap"
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
func refuseRunningHost(state host.State) *contracts.LauncherError {
	pid, alive := supervisor.LivePID(state)
	if !alive {
		return nil
	}
	failure := contracts.NewLauncherError("KB_HOST_ALREADY_RUNNING", "The KB Labs host is already running.", "Use \"kb-create update\" to change an installed platform, or \"kb-create stop\" before a fresh apply.", nil)
	failure.Details = map[string]string{"supervisorPid": fmt.Sprint(pid)}
	return failure
}

// snapshotSummary is what the machine output says about a snapshot: never its
// captured files.
func snapshotSummary(snapshot contracts.Snapshot) map[string]any {
	return map[string]any{"id": snapshot.ID, "createdAt": snapshot.CreatedAt, "receiptId": snapshot.ReceiptID}
}

// runUpdate replaces the installed platform with the resolved plan around the
// host: the launcher stops the host, swaps the version, restarts the host from
// the new receipt and, when the new host does not come up, restores the
// previous version and restarts that. There are no manual steps.
func (i invocation) runUpdate(ctx context.Context, output *os.File, plan contracts.ResolvedInstallPlan, deps runtime.Dependencies, prober runtime.HostProbe, state host.State, correlationID, logPath string, outcome, errorCode *string) int {
	root := plan.Request.PlatformRoot
	if _, err := receipt.Read(root); err != nil {
		write(output, failure(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err))
		return 2
	}
	var updated contracts.InstallReceipt
	var snapshot contracts.Snapshot
	command := hostCommand{PlatformRoot: root, Executable: i.Executable, Version: buildVersion}
	result, err := swap.Run(ctx, lifecycleHost{command: command, state: state}, swap.Operation{
		Name:            "update",
		PreviousVersion: installedVersion(root),
		Change: func(ctx context.Context, wasRunning bool) (string, error) {
			changeDeps := deps
			if !wasRunning {
				// A running host is proven by its restart right after the swap;
				// a stopped one gets a trial run before the receipt is committed.
				changeDeps.Host = prober
			}
			var updateErr error
			updated, snapshot, updateErr = runtime.Update(ctx, plan, changeDeps)
			return snapshot.ID, updateErr
		},
		Restore: func(_ context.Context, id string) error {
			_, restoreErr := lifecycle.Rollback(root, id, deps.Artifacts.Restore)
			return restoreErr
		},
	})
	if err != nil {
		writeLauncherFailure(output, root, correlationID, logPath, asLauncherError(err), &plan)
		return 1
	}
	write(output, map[string]any{"ok": true, "operation": "update", "receipt": updated, "snapshot": snapshotSummary(snapshot), "hostRestarted": result.WasRunning, "logPath": logPath})
	*outcome, *errorCode = "success", ""
	return 0
}

// runRecovery is uninstall and rollback: both replace the installation, so both
// run around the host like an update.
func (i invocation) runRecovery(output *os.File) int {
	operation, root := i.Operation, i.PlatformRoot
	if root == "" {
		write(output, failure("KB_INSTALL_INPUT_REQUIRED", "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil))
		return 2
	}
	active, err := receipt.Read(root)
	if err != nil {
		write(output, failure(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err))
		return 2
	}
	target := i.Snapshot
	if operation == "rollback" && target == "" {
		// The receipt records the snapshot taken before the update that produced
		// it: rolling back without a named snapshot undoes the last update.
		target = active.SnapshotID
		if target == "" {
			write(output, failure(contracts.CodeUpdateNoSnapshot, "There is no snapshot to roll back to.", "Reinstall the previous version with \"kb-create apply\", or name a snapshot with --snapshot.", nil))
			return 1
		}
	}
	state, err := host.StateHome()
	if err != nil {
		write(output, map[string]any{"ok": false, "error": asLauncherError(err)})
		return 2
	}
	release, err := state.AcquireOperation(operation)
	if err != nil {
		write(output, map[string]any{"ok": false, "error": asLauncherError(err)})
		return 2
	}
	defer release()
	correlationID := fmt.Sprintf("%s-%d", operation, time.Now().UTC().UnixNano())
	transcript, err := logs.New(root, correlationID, nil)
	if err != nil {
		write(output, failure("KB_INSTALL_LOG_UNAVAILABLE", "could not create local operation log", "check that the platform root is writable", err))
		return 2
	}
	defer func() { _ = transcript.Close() }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	installer := artifacts.Composite{Packages: artifacts.Pnpm{Root: root, Registry: i.Registry, Log: transcript}, Binaries: artifacts.Binaries{Root: root}}
	deps := runtime.Dependencies{Artifacts: installer, CorrelationID: correlationID}
	command := hostCommand{PlatformRoot: root, Executable: i.Executable, Version: buildVersion}
	var snapshot contracts.Snapshot
	op := swap.Operation{
		Name:            operation,
		PreviousVersion: installedVersion(root),
		Restore: func(_ context.Context, id string) error {
			_, restoreErr := lifecycle.Rollback(root, id, installer.Restore)
			return restoreErr
		},
	}
	if operation == "uninstall" {
		op.KeepStopped = true
		op.Change = func(context.Context, bool) (string, error) {
			var uninstallErr error
			snapshot, uninstallErr = runtime.Uninstall(root, deps)
			return snapshot.ID, uninstallErr
		}
	} else {
		op.Change = func(context.Context, bool) (string, error) {
			// Snapshot what runs now, so a restored version that does not start
			// can be undone; a failing restore is undone by Mutate itself.
			var rollbackErr error
			snapshot, rollbackErr = lifecycle.Mutate(root, time.Now().UTC(), func() error {
				_, err := runtime.Rollback(root, target, deps)
				return err
			}, nil, installer.Restore)
			return snapshot.ID, rollbackErr
		}
	}
	result, err := swap.Run(ctx, lifecycleHost{command: command, state: state}, op)
	if err != nil {
		writeLauncherFailure(output, root, correlationID, transcript.Path(), asLauncherError(err), nil)
		return 1
	}
	write(output, map[string]any{"ok": true, "operation": operation, "snapshot": snapshotSummary(snapshot), "hostRestarted": result.WasRunning && operation != "uninstall", "logPath": transcript.Path()})
	return 0
}

// writeLauncherFailure emits a typed failure with its diagnostic dossier.
func writeLauncherFailure(output *os.File, platformRoot, correlationID, logPath string, launcherError *contracts.LauncherError, plan *contracts.ResolvedInstallPlan) {
	launcherError.CorrelationID = correlationID
	dossier := diagnostics.Dossier{CorrelationID: correlationID, Error: launcherError, Stage: launcherError.Stage, LogPath: logPath}
	if plan != nil {
		dossier.PlanHash, dossier.ReleaseDigest, dossier.ScenarioStateDigest = plan.PlanHash, plan.ReleaseDigest, plan.ScenarioStateDigest
	}
	path, dossierErr := diagnostics.Write(platformRoot, dossier, nil)
	if dossierErr != nil {
		write(output, failure("KB_INSTALL_DIAGNOSTIC_UNAVAILABLE", "The operation failed and the diagnostic dossier could not be written.", "inspect the local operation log", dossierErr))
		return
	}
	write(output, map[string]any{"ok": false, "error": launcherError, "logPath": logPath, "diagnosticPath": path})
}
