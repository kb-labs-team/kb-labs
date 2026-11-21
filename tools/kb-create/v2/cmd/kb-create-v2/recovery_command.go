package v2cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/logs"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/swap"
	"github.com/kb-labs/create/v2/versionroot"
	"github.com/spf13/cobra"
)

type recoveryCommandResult struct {
	OK                        bool           `json:"ok"`
	Operation                 string         `json:"operation"`
	Snapshot                  map[string]any `json:"snapshot"`
	HostRestarted             bool           `json:"hostRestarted"`
	LogPath                   string         `json:"logPath"`
	ProjectRegistrationNotice string         `json:"projectRegistrationNotice,omitempty"`
	PreservedEntries          []string       `json:"preservedEntries,omitempty"`
	ShimAction                string         `json:"shimAction,omitempty"`
	ShimOwner                 string         `json:"shimOwner,omitempty"`
}

type uninstallCommandInput struct {
	PlatformRoot, Registry, Executable string
	Yes, JSON                          bool
	Command                            *cobra.Command
	Artifacts                          runtime.ArtifactInstaller
	ArtifactRunner                     artifacts.Runner
}
type rollbackCommandInput struct {
	PlatformRoot, Registry, Executable, Snapshot string
	Yes, JSON                                    bool
	Command                                      *cobra.Command
	Artifacts                                    runtime.ArtifactInstaller
	ArtifactRunner                               artifacts.Runner
}
type recoveryRuntimeInput struct {
	Registry, Executable string
	Artifacts            runtime.ArtifactInstaller
	ArtifactRunner       artifacts.Runner
}

func executeUninstall(ctx context.Context, input uninstallCommandInput) (recoveryCommandResult, *diag.Diag) {
	root := input.PlatformRoot
	if root == "" {
		return recoveryCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil)
	}
	commandArgs := []string{"kb-create", "uninstall", "--platform-root", root}
	if input.Registry != "" {
		commandArgs = append(commandArgs, "--registry", input.Registry)
	}
	if input.JSON {
		commandArgs = append(commandArgs, "--json")
	}
	commandArgs = append(commandArgs, "--yes")
	hint := "rerun `" + contracts.ShellCommand(commandArgs...) + "`"
	if failure := confirmDestructive(input.Yes, "This will remove platform root "+root+", its installed services, active receipt, and saved snapshots. Project files are kept. Continue? [y/N] ",
		hint, input.Command); failure != nil {
		return recoveryCommandResult{}, failure
	}
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr == nil {
		layoutErr = layout.ValidateStructure()
	}
	if layoutErr != nil {
		if layout != (versionroot.Layout{}) && layout.HasOwnershipMarker() {
			preserved, preserveErr := layout.PreservedEntries()
			if preserveErr != nil {
				return recoveryCommandResult{}, unsupportedPlatformLayout(root, preserveErr)
			}
			if removeErr := layout.RemoveOwned(); removeErr != nil {
				return recoveryCommandResult{}, unsupportedPlatformLayout(root, removeErr)
			}
			return recoveryCommandResult{OK: true, Operation: "uninstall", HostRestarted: false, PreservedEntries: preserved}, nil
		}
		return recoveryCommandResult{}, unsupportedPlatformLayout(root, layoutErr)
	}
	platformRoot := layout.PlatformRoot()
	shimClassification := shim.Classification{Kind: shim.ClassificationAbsent}
	if input.Executable != "" {
		var classifyErr error
		shimClassification, classifyErr = shim.Classify(input.Executable, platformRoot)
		if classifyErr != nil {
			return recoveryCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the kb command ownership could not be checked before uninstall", "inspect the launcher directory, then retry `"+contracts.ShellCommand("kb-create", "uninstall", "--platform-root", root, "--yes")+"`", classifyErr)
		}
	}
	shimOwner := shimClassification.Owner
	shimRemoval, removeShim := shimClassification.PrepareRemoval()
	active, err := receipt.Read(platformRoot)
	if err != nil {
		failure := contracts.NewDiag(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err)
		return recoveryCommandResult{}, failure
	}
	if active.InstallationID == "" {
		return recoveryCommandResult{}, unsupportedPlatformLayout(root, fmt.Errorf("active receipt has no installation identity"))
	}
	if layoutErr := layout.Validate(); layoutErr != nil {
		return recoveryCommandResult{}, unsupportedPlatformLayout(root, layoutErr)
	}
	registry := gateway.Registry{OperationRoot: root}
	if _, err := registry.Read(); err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	state, err := host.StateForRoot(root)
	if err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	release, err := state.AcquireOperation("uninstall")
	if err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	defer release()
	preservedEntries, err := layout.PreservedEntries()
	if err != nil {
		return recoveryCommandResult{}, unsupportedPlatformLayout(root, err)
	}
	result, failure := runRecoveryMutation(ctx, recoveryRuntimeInput{Registry: input.Registry, Executable: input.Executable, Artifacts: input.Artifacts, ArtifactRunner: input.ArtifactRunner}, root, state, "uninstall", "", true, func(ctx context.Context, deps runtime.Dependencies) (contracts.Snapshot, error) {
		return runtime.Uninstall(root, deps)
	})
	if failure != nil {
		return recoveryCommandResult{}, failure
	}
	shimAction := "absent"
	if removeShim {
		if err := shimRemoval.Remove(input.Executable); err != nil {
			return recoveryCommandResult{}, contracts.NewDiag("KB_INSTALL_APPLY_FAILED", "installation was removed but the kb command shim could not be removed", "remove the stale kb link from the launcher directory after checking its target", err)
		}
		shimAction = "removed"
	} else if shimClassification.Kind == shim.ClassificationOtherInstallation {
		shimAction = "left"
	} else if shimClassification.Kind == shim.ClassificationForeign {
		shimAction = "left-foreign"
	}
	if err := registry.Writer(gateway.Uninstall).RemoveInstallation(active.InstallationID); err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	return recoveryCommandResult{OK: true, Operation: "uninstall", Snapshot: snapshotSummary(result.Snapshot), HostRestarted: false, LogPath: result.LogPath,
		ShimAction: shimAction, ShimOwner: shimOwner, PreservedEntries: preservedEntries}, nil
}

func executeRollback(ctx context.Context, input rollbackCommandInput) (recoveryCommandResult, *diag.Diag) {
	root := input.PlatformRoot
	if root == "" {
		return recoveryCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil)
	}
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr == nil {
		layoutErr = layout.Validate()
	}
	if layoutErr != nil {
		return recoveryCommandResult{}, unsupportedPlatformLayout(root, layoutErr)
	}
	state, err := host.StateForRoot(root)
	if err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	platformRoot := layout.PlatformRoot()
	if _, err := (secrets.Store{PlatformRoot: platformRoot}).BootstrapCompleted(); err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	if running := refuseForeignHost(root); running != nil {
		return recoveryCommandResult{}, running
	}
	commandArgs := []string{"kb-create", "rollback", "--platform-root", root}
	if input.Snapshot != "" {
		commandArgs = append(commandArgs, "--snapshot", input.Snapshot)
	}
	if input.JSON {
		commandArgs = append(commandArgs, "--json")
	}
	commandArgs = append(commandArgs, "--yes")
	commandLine := "rerun `" + contracts.ShellCommand(commandArgs...) + "`"
	if failure := confirmDestructive(input.Yes, "This will replace platform root "+root+" and its active receipt with a saved snapshot. Continue? [y/N] ", commandLine, input.Command); failure != nil {
		return recoveryCommandResult{}, failure
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		failure := contracts.NewDiag(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err)
		return recoveryCommandResult{}, failure
	}
	target := input.Snapshot
	if target == "" {
		target = active.SnapshotID
		if target == "" {
			return recoveryCommandResult{}, contracts.NewDiag(contracts.CodeUpdateNoSnapshot, "There is no snapshot to roll back to.", "Reinstall the previous version with \"kb-create apply\", or name a snapshot with --snapshot.", nil)
		}
	}
	release, err := state.AcquireOperation("rollback")
	if err != nil {
		return recoveryCommandResult{}, asDiag(err)
	}
	defer release()
	result, failure := runRecoveryMutation(ctx, recoveryRuntimeInput{Registry: input.Registry, Executable: input.Executable, Artifacts: input.Artifacts, ArtifactRunner: input.ArtifactRunner}, root, state, "rollback", target, false, func(_ context.Context, deps runtime.Dependencies) (contracts.Snapshot, error) {
		installer := deps.Artifacts
		return lifecycle.Mutate(platformRoot, platformRoot, layout.SnapshotsDir(), time.Now().UTC(), func() error {
			_, rollbackErr := runtime.Rollback(platformRoot, target, deps)
			return rollbackErr
		}, nil, restoreReceiptArtifacts(installer))
	})
	if failure != nil {
		return recoveryCommandResult{}, failure
	}
	registrationNotice := ""
	if restored, readErr := receipt.Read(platformRoot); readErr == nil {
		registrationNotice, err = completedBootstrapProjectNotice(restored, restored.Plan.Request.ProjectRoot, false)
		if err != nil {
			return recoveryCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
				"the project registration state could not be read", "check platform-root permissions, then rerun `"+contracts.ShellCommand("kb-create", "rollback", "--platform-root", root)+"`", err)
		}
	}
	if restored, readErr := receipt.Read(platformRoot); readErr == nil && restored.Plan.Host != nil {
		origin, originErr := gateway.OriginFromHealthURL(restored.Verification.HostHealthURL)
		if originErr != nil {
			return recoveryCommandResult{}, contracts.HostSpecDiagnostic("the restored Gateway address could not be recorded", "rerun `"+contracts.ShellCommand("kb-create", "rollback", "--platform-root", root, "--snapshot", target, "--yes")+"`", originErr.Error(), originErr)
		}
		if err := (gateway.Registry{OperationRoot: platformRoot}).Writer(gateway.Rollback).Register(platformRoot, origin); err != nil {
			return recoveryCommandResult{}, asDiag(err)
		}
	}
	return recoveryCommandResult{OK: true, Operation: "rollback", Snapshot: snapshotSummary(result.Snapshot), HostRestarted: result.WasRunning, LogPath: result.LogPath,
		ProjectRegistrationNotice: registrationNotice}, nil
}

type recoveryMutationResult struct {
	Snapshot   contracts.Snapshot
	WasRunning bool
	LogPath    string
}

func restoreReceiptArtifacts(installer interface {
	Restore(contracts.ResolvedInstallPlan, contracts.ResolvedInstallPlan) error
}) lifecycle.PackageRestore {
	return installer.Restore
}

func runRecoveryMutation(ctx context.Context, input recoveryRuntimeInput, root string, state host.State, operation string, target string, keepStopped bool,
	change func(context.Context, runtime.Dependencies) (contracts.Snapshot, error)) (recoveryMutationResult, *diag.Diag) {
	layout, err := versionroot.ForPlatformPath(root)
	if err != nil {
		return recoveryMutationResult{}, unsupportedPlatformLayout(root, err)
	}
	platformRoot := layout.PlatformRoot()
	activeRoot, err := layout.Active()
	if err != nil {
		return recoveryMutationResult{}, unsupportedPlatformLayout(root, err)
	}
	correlationID := fmt.Sprintf("%s-%d", operation, time.Now().UTC().UnixNano())
	transcript, err := logs.New(layout.OperationLogsDir(), correlationID, nil)
	if err != nil {
		return recoveryMutationResult{}, contracts.NewDiag("KB_INSTALL_LOG_UNAVAILABLE", "could not create local operation log", "check that the platform root is writable", err)
	}
	defer transcript.Close()
	var installer runtime.ArtifactInstaller = input.Artifacts
	if installer == nil {
		activeReceipt, receiptErr := receipt.Read(platformRoot)
		if receiptErr != nil {
			return recoveryMutationResult{}, asDiag(receiptErr)
		}
		activeRelease, verifyErr := catalog.DecodeVerified(activeReceipt.Plan.ReleaseCatalog)
		if verifyErr != nil {
			return recoveryMutationResult{}, indexFailure(verifyErr, contracts.ShellCommand("kb-create", operation, "--platform-root", platformRoot))
		}
		registry := input.Registry
		if registry == "" {
			registry = activeReceipt.Plan.Registry
		}
		executor, executorErr := newArtifactExecutor(layout, activeRoot, registry, false, transcript, input.ArtifactRunner,
			activeRelease, nil, platformRoot)
		if executorErr != nil {
			return recoveryMutationResult{}, asDiag(executorErr)
		}
		installer = executor
	}
	deps := runtime.Dependencies{Artifacts: installer, CorrelationID: correlationID}
	command := hostCommand{PlatformRoot: root, Executable: input.Executable, Version: buildVersion}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var snapshot contracts.Snapshot
	operationSpec := swap.Operation{Name: operation, PreviousVersion: installedVersion(platformRoot), KeepStopped: keepStopped,
		Change: func(changeCtx context.Context, _ bool) (string, error) {
			var changeErr error
			snapshot, changeErr = change(changeCtx, deps)
			return snapshot.ID, changeErr
		},
		Restore: func(_ context.Context, id string) error {
			_, restoreErr := lifecycle.Rollback(platformRoot, layout.SnapshotsDir(), id, restoreReceiptArtifacts(installer))
			return restoreErr
		},
	}
	result, err := swap.Run(ctx, lifecycleHost{command: command, state: state}, operationSpec)
	if err != nil {
		return recoveryMutationResult{}, operationDiagnostic(root, correlationID, transcript.Path(), asDiag(err), nil)
	}
	return recoveryMutationResult{Snapshot: snapshot, WasRunning: result.WasRunning, LogPath: transcript.Path()}, nil
}

func confirmDestructive(yes bool, prompt, hint string, command *cobra.Command) *diag.Diag {
	if yes {
		return nil
	}
	_, failure := clikitcommand.FromCommand(command).Confirm(prompt, hint)
	if failure != nil {
		return failure
	}
	return nil
}
