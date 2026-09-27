// Package swap runs an operation that replaces the installed platform (update,
// rollback, repair, uninstall) around the host process: it stops the host, lets
// the operation swap the installation, restarts the host from the new state and,
// when the host does not come back, restores the previous state and restarts
// that. It is the launcher half of "update without manual steps" (ADR-0045):
// the operator never stops or starts anything by hand, and a broken release
// leaves the previous one running.
package swap

import (
	"context"
	"errors"
	"fmt"

	"github.com/kb-labs/create/v2/contracts"
)

// Host is the supervised host as this package needs it. Both calls act on the
// installation as it is at the time of the call: Resume reads the receipt
// afresh, so after a swap it starts the new version and after a restore the
// old one.
type Host interface {
	// Halt stops the supervised host and reports whether it was running.
	Halt(ctx context.Context) (wasRunning bool, err error)
	// Resume starts the host under the supervisor and returns once it is healthy.
	Resume(ctx context.Context) error
}

// Operation is one swap of the installation.
type Operation struct {
	// Name appears in messages: "update", "rollback", "repair" or "uninstall".
	Name string
	// PreviousVersion is the platform version being replaced, for messages.
	PreviousVersion string
	// Change performs the swap while the host is stopped. It returns the
	// recovery point (the snapshot taken before the change), also when it
	// fails. A failing Change must already have restored the installation to
	// what it was (lifecycle.Mutate does).
	Change func(ctx context.Context, wasRunning bool) (recoveryPoint string, err error)
	// Restore puts the installation back to the recovery point. It is used
	// only when Change succeeded but the resulting host does not start.
	Restore func(ctx context.Context, recoveryPoint string) error
	// KeepStopped leaves the host stopped after a successful Change
	// (uninstall: there is no host left to run).
	KeepStopped bool
}

// Outcome describes a completed operation.
type Outcome struct {
	// WasRunning is true when the host ran before the operation.
	WasRunning bool
	// RecoveryPoint is the snapshot that can undo the operation.
	RecoveryPoint string
}

// Run executes op around the host. Every error is a *contracts.LauncherError.
func Run(ctx context.Context, host Host, op Operation) (Outcome, error) {
	wasRunning, err := host.Halt(ctx)
	if err != nil {
		return Outcome{}, asLauncher(err)
	}
	outcome := Outcome{WasRunning: wasRunning}
	// Undoing a half-done swap must not be cancelled by the interrupt that
	// stopped the operation: leaving the host down is the worse outcome.
	recovery := context.WithoutCancel(ctx)
	recoveryPoint, changeErr := op.Change(ctx, wasRunning)
	outcome.RecoveryPoint = recoveryPoint
	if changeErr != nil {
		failure := contracts.NewLauncherError(contracts.CodeUpdateApplyFailed,
			fmt.Sprintf("The %s could not be applied; the previous version %s was restored.", op.Name, op.PreviousVersion),
			"Inspect the local log and the diagnostic dossier, fix the reported cause and run the command again.", changeErr)
		if wasRunning {
			if resumeErr := host.Resume(recovery); resumeErr != nil {
				failure.Details = map[string]string{"hostRestart": resumeErr.Error()}
			}
		}
		return outcome, failure
	}
	if op.KeepStopped || !wasRunning {
		return outcome, nil
	}
	resumeErr := host.Resume(ctx)
	if resumeErr == nil {
		return outcome, nil
	}
	// The new installation does not run. Undo the swap and bring the previous
	// version back, so the user is left with a working platform.
	if restoreErr := op.Restore(recovery, recoveryPoint); restoreErr != nil {
		return outcome, rollbackFailed(op, recoveryPoint, resumeErr, restoreErr)
	}
	if again := host.Resume(recovery); again != nil {
		return outcome, rollbackFailed(op, recoveryPoint, resumeErr, fmt.Errorf("the restored version does not start either: %w", again))
	}
	failure := contracts.NewLauncherError(contracts.CodeUpdateHostNotHealthy,
		fmt.Sprintf("The host did not become healthy after the %s; the previous version %s was restored.", op.Name, op.PreviousVersion),
		"Read the host log in the launcher state directory and report the correlationId.", resumeErr)
	failure.Details = map[string]string{"snapshot": recoveryPoint}
	return outcome, failure
}

func rollbackFailed(op Operation, recoveryPoint string, cause, restoreErr error) *contracts.LauncherError {
	failure := contracts.NewLauncherError(contracts.CodeRollbackFailed,
		fmt.Sprintf("The %s left the host down and the rollback did not succeed; the snapshot is at %s.", op.Name, recoveryPoint),
		"Restore the snapshot manually and report the correlationId.", errors.Join(cause, restoreErr))
	failure.Details = map[string]string{"snapshot": recoveryPoint}
	return failure
}

func asLauncher(err error) *contracts.LauncherError {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		return typed
	}
	return contracts.NewLauncherError("KB_RUNTIME_UNEXPECTED", "The launcher failed to process the request.", "Read the launcher log in the state directory.", err)
}
