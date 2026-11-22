package host

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/versionroot"
)

type RestartStart func(context.Context, *ProcessRunner) (Info, error)

type RestartOutcome struct {
	Stopped StopResult
	Info    Info
	Runner  *ProcessRunner
}

func RestartWithRecovery(ctx context.Context, root string, previous *ProcessRunner, start RestartStart) (RestartOutcome, error) {
	stopped, err := previous.Stop(ctx)
	if err != nil {
		return RestartOutcome{}, recoveryFailure(root, root, "stop previous host", "", "", err, false)
	}
	active, err := NewRunner(root)
	if err != nil {
		return RestartOutcome{}, recoveryFailure(root, root, "load target host", "", "", err, false)
	}
	inheritMarketplaceOwner(previous, active)
	info, err := start(ctx, active)
	if err == nil {
		layout, layoutErr := versionroot.ForPlatformPath(root)
		if layoutErr != nil {
			return RestartOutcome{Stopped: stopped, Info: info, Runner: active}, layoutErr
		}
		if pruneErr := receipt.PruneSnapshots(layout.SnapshotsDir(), contracts.SnapshotRetention()); pruneErr != nil {
			return RestartOutcome{Stopped: stopped, Info: info, Runner: active}, contracts.NewDiag(contracts.CodeOperationFailed,
				"the new version is healthy but recovery snapshot retention could not be completed.",
				"Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)+"` to inspect disk permissions, then retry restart.", pruneErr)
		}
		return RestartOutcome{Stopped: stopped, Info: info, Runner: active}, nil
	}
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr != nil {
		return RestartOutcome{}, recoveryFailure(root, active.TreeRoot, "resolve version layout", "", "", layoutErr, false)
	}
	metadata, metadataErr := layout.UpdateMetadata()
	failedRoot, restoreErr := layout.RestorePrevious()
	if restoreErr != nil {
		return RestartOutcome{}, recoveryFailure(root, active.TreeRoot, "restore last healthy root", "", metadata.SnapshotID, restoreErr, false)
	}
	restored, runnerErr := NewRunner(root)
	if runnerErr != nil {
		return RestartOutcome{}, recoveryFailure(root, active.TreeRoot, "load restored host", failedRoot, metadata.SnapshotID, runnerErr, false)
	}
	inheritMarketplaceOwner(previous, restored)
	restoredInfo, startErr := start(ctx, restored)
	if startErr != nil {
		return RestartOutcome{}, recoveryFailure(root, active.TreeRoot, "start restored host", failedRoot, metadata.SnapshotID, startErr, false)
	}
	if metadataErr != nil {
		return RestartOutcome{Stopped: stopped, Info: restoredInfo, Runner: restored}, recoveryFailure(root, active.TreeRoot, "read update recovery metadata", failedRoot, "", metadataErr, true)
	}
	failure := contracts.NewDiag(contracts.CodeUpdateHostNotHealthy,
		fmt.Sprintf("The installed version failed its restart health check; snapshot %s was restored and the last healthy version was started.", metadata.SnapshotID),
		"Run `"+contracts.ShellCommand("kb-create", "status", "--platform-root", root)+"` to confirm the restored version is healthy.", nil)
	failure.Meta = map[string]any{"attemptedRoot": filepath.Clean(active.TreeRoot), "recoveryRoot": filepath.Clean(failedRoot), "recoveryStage": "restored-last-healthy",
		"version": restored.Identity.PlatformVersion, "runningVersion": restored.Identity.PlatformVersion, "snapshotId": metadata.SnapshotID, "logPath": filepath.Join(layout.InstallRoot(), metadata.LogPath),
		"nextCommand": contracts.ShellCommand("kb-create", "status", "--platform-root", root), "failureReason": "target host did not pass its health check"}
	return RestartOutcome{Stopped: stopped, Info: restoredInfo, Runner: restored}, failure
}

func inheritMarketplaceOwner(previous, next *ProcessRunner) {
	if previous == nil || next == nil || previous.Spec.Env == nil {
		return
	}
	ownerBinary := previous.Spec.Env[MarketplaceOwnerBinaryEnv]
	if ownerBinary == "" {
		return
	}
	if next.Spec.Env == nil {
		next.Spec.Env = make(map[string]string)
	}
	next.Spec.Env[MarketplaceOwnerBinaryEnv] = ownerBinary
}

func recoveryFailure(root, attemptedRoot, stage, recoveryRoot, snapshotID string, cause error, restoredHealthy bool) *diag.Diag {
	next := contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)
	message := "Restart recovery could not restore and start the last healthy version."
	if restoredHealthy {
		message = "The last healthy version was restored and started, but restart recovery metadata could not be read."
		next = contracts.ShellCommand("kb-create", "status", "--platform-root", root)
	}
	failure := contracts.NewDiag(contracts.CodeUpdateHostNotHealthy, message,
		"Run `"+next+"` to inspect the installed and running versions.", nil)
	failure.Meta = map[string]any{"recoveryStage": stage, "attemptedRoot": attemptedRoot, "recoveryRoot": recoveryRoot,
		"snapshotId": snapshotID, "nextCommand": next, "failureReason": cause.Error(), "restoredHealthy": restoredHealthy}
	return failure
}
