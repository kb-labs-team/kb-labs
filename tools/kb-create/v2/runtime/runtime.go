// Package runtime is the autonomous V2 application boundary. It accepts an
// already resolved plan, applies exact artifacts, renders its projections,
// verifies the resolved service graph and only then commits a receipt.
package runtime

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/lifecycle"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/render"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/verify"
)

type ArtifactInstaller interface {
	Install([]contracts.Artifact) error
	Restore() error
}
type ArtifactUninstaller interface {
	Uninstall([]contracts.Artifact) error
}

// HostProbe proves that the host a plan declares really starts: it runs the
// host once, waits until it is healthy and stops it again. It is optional
// because a caller that restarts the real host right after the operation (the
// update flow of a running installation) proves the same thing with that start.
type HostProbe interface {
	Probe(ctx context.Context, host contracts.HostSpec) error
}

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

type Dependencies struct {
	Artifacts ArtifactInstaller
	Host      HostProbe
	Clock     Clock
	// CorrelationID is supplied by a frontend; it is persisted verbatim in the
	// receipt and must be safe to disclose in a diagnostic bundle.
	CorrelationID string
	Secrets       *secrets.Store
}

// Apply is the one V2 fresh-install operation. It deliberately has no
// dependency on legacy manifests, state or package scanning.
func Apply(ctx context.Context, plan contracts.ResolvedInstallPlan, deps Dependencies) (contracts.InstallReceipt, error) {
	if plan.Schema != contracts.ResolvedPlanSchema {
		return contracts.InstallReceipt{}, fmt.Errorf("apply resolved plan: unsupported schema %q", plan.Schema)
	}
	if deps.Artifacts == nil {
		return contracts.InstallReceipt{}, fmt.Errorf("apply resolved plan: artifact installer is required")
	}
	if err := verifySecrets(plan, deps.Secrets); err != nil {
		return contracts.InstallReceipt{}, err
	}
	if deps.Secrets != nil {
		if err := deps.Secrets.BindEnvironments(plan.ConfigPatches); err != nil {
			return contracts.InstallReceipt{}, fmt.Errorf("bind secrets to service environment: %w", err)
		}
	}
	if err := deps.Artifacts.Install(plan.Artifacts); err != nil {
		return contracts.InstallReceipt{}, fmt.Errorf("apply exact artifacts: %w", err)
	}
	// core-discovery's plugin registry reads .kb/marketplace.lock, not the
	// resolved plan — without this, every installed plugin/adapter is on
	// disk but invisible to the running platform (empty registry at /ready).
	if err := marketplace.WriteLock(plan.Request.PlatformRoot, plan.Artifacts, now(deps.Clock)); err != nil {
		_ = removeProjections(plan.Request.PlatformRoot)
		return contracts.InstallReceipt{}, fmt.Errorf("write marketplace lock: %w", err)
	}
	if _, err := render.Write(plan); err != nil {
		return contracts.InstallReceipt{}, fmt.Errorf("render resolved projections: %w", err)
	}
	now := now(deps.Clock)
	check, err := verify.Run(plan, now)
	if err != nil {
		// A fresh run has no prior receipt to restore. Remove only V2-owned
		// projections so an incomplete installation cannot masquerade as installed.
		_ = removeProjections(plan.Request.PlatformRoot)
		return contracts.InstallReceipt{}, fmt.Errorf("verify installation: %w", err)
	}
	if deps.Host != nil {
		if err := deps.Host.Probe(ctx, *plan.Host); err != nil {
			_ = removeProjections(plan.Request.PlatformRoot)
			return contracts.InstallReceipt{}, fmt.Errorf("start the resolved host: %w", err)
		}
	}
	result := contracts.InstallReceipt{Schema: contracts.ReceiptSchema, ID: receiptID(plan.PlanHash, now), CreatedAt: now, CorrelationID: deps.CorrelationID, Plan: plan, Verification: check}
	if err := receipt.Write(plan.Request.PlatformRoot, result); err != nil {
		return contracts.InstallReceipt{}, fmt.Errorf("commit verified receipt: %w", err)
	}
	return result, nil
}

func verifySecrets(plan contracts.ResolvedInstallPlan, store *secrets.Store) error {
	if len(plan.Request.SecretInputs) == 0 {
		return nil
	}
	if store == nil {
		return fmt.Errorf("apply resolved plan: secret store is required for declared secret inputs")
	}
	for _, name := range plan.Request.SecretInputs {
		exists, err := store.Exists(name)
		if err != nil {
			return fmt.Errorf("check secret %s: %w", name, err)
		}
		if !exists {
			return fmt.Errorf("required secret input %s is not set", name)
		}
	}
	return nil
}

// Update creates a recovery snapshot before replacing the resolved artifact
// set. Any apply or graph-verification failure restores managed files, receipt
// and the package-manager lock state through ArtifactInstaller.Restore.
func Update(ctx context.Context, plan contracts.ResolvedInstallPlan, deps Dependencies) (contracts.InstallReceipt, contracts.Snapshot, error) {
	if deps.Artifacts == nil {
		return contracts.InstallReceipt{}, contracts.Snapshot{}, fmt.Errorf("update resolved plan: artifact installer is required")
	}
	var result contracts.InstallReceipt
	snapshot, err := lifecycle.Mutate(plan.Request.PlatformRoot, now(deps.Clock), func() error {
		var applyErr error
		result, applyErr = Apply(ctx, plan, deps)
		return applyErr
	}, nil, deps.Artifacts.Restore)
	if err != nil {
		return contracts.InstallReceipt{}, snapshot, err
	}
	result.SnapshotID = snapshot.ID
	if err := receipt.Write(plan.Request.PlatformRoot, result); err != nil {
		return contracts.InstallReceipt{}, snapshot, fmt.Errorf("attach recovery snapshot to receipt: %w", err)
	}
	return result, snapshot, nil
}

// Uninstall is intentionally narrow: it removes exactly the artifacts in the
// verified receipt. The host must already be stopped (the caller halts it): the
// installed host binary is one of the artifacts being removed. The snapshot
// remains in .kb/v2/snapshots so a failed operation can recover; a successful
// deletion leaves explicit recovery data rather than claiming user-authored
// project files are disposable.
func Uninstall(platformRoot string, deps Dependencies) (contracts.Snapshot, error) {
	if deps.Artifacts == nil {
		return contracts.Snapshot{}, fmt.Errorf("uninstall: artifact installer is required")
	}
	uninstaller, ok := deps.Artifacts.(ArtifactUninstaller)
	if !ok {
		return contracts.Snapshot{}, fmt.Errorf("uninstall: artifact installer does not support removal")
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return contracts.Snapshot{}, fmt.Errorf("uninstall: read active receipt: %w", err)
	}
	return lifecycle.Mutate(platformRoot, now(deps.Clock), func() error {
		if err := uninstaller.Uninstall(active.Plan.Artifacts); err != nil {
			return err
		}
		// Only V2-owned projections are removed. Project roots and any user
		// authored files remain outside this operation's authority.
		if err := removeProjections(platformRoot); err != nil {
			return err
		}
		return receipt.Delete(platformRoot)
	}, nil, deps.Artifacts.Restore)
}

// Rollback restores an explicit V2 snapshot and reinstalls its exact lock
// state. It never infers a target from package tags or legacy state, and it
// leaves the host to the caller (which restarts it from the restored receipt).
func Rollback(platformRoot, snapshotID string, deps Dependencies) (contracts.Snapshot, error) {
	if snapshotID == "" {
		return contracts.Snapshot{}, fmt.Errorf("rollback: snapshot ID is required")
	}
	if deps.Artifacts == nil {
		return contracts.Snapshot{}, fmt.Errorf("rollback: artifact installer is required")
	}
	snapshot, err := lifecycle.Rollback(platformRoot, snapshotID, deps.Artifacts.Restore)
	if err != nil {
		return snapshot, err
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return snapshot, fmt.Errorf("rollback: read restored receipt: %w", err)
	}
	if _, err := verify.Run(active.Plan, now(deps.Clock)); err != nil {
		return snapshot, fmt.Errorf("rollback: verify restored installation: %w", err)
	}
	return snapshot, nil
}

// DoctorFix applies only manifest-declared safe defaults under a snapshot, then
// verifies the receipt's installation. Required user input is never guessed:
// callers receive an error before any write occurs. The host reads its config
// at start, so the caller restarts it afterwards.
func DoctorFix(platformRoot string, repair doctor.RepairPlan, deps Dependencies) (contracts.Snapshot, error) {
	if len(repair.RequiredInput) != 0 {
		return contracts.Snapshot{}, fmt.Errorf("doctor fix requires %d explicit input value(s)", len(repair.RequiredInput))
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return contracts.Snapshot{}, fmt.Errorf("doctor fix: read active receipt: %w", err)
	}
	return lifecycle.Mutate(platformRoot, now(deps.Clock), func() error {
		return doctor.ApplyDefaults(platformRoot, repair)
	}, func() error {
		_, err := verify.Run(active.Plan, now(deps.Clock))
		return err
	}, nil)
}

func removeProjections(platformRoot string) error {
	for _, relative := range []string{".kb/kb.config.jsonc", ".kb/marketplace.lock"} {
		if err := os.Remove(filepath.Join(platformRoot, relative)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove managed projection %s: %w", relative, err)
		}
	}
	return nil
}

func now(clock Clock) time.Time {
	if clock == nil {
		return systemClock{}.Now()
	}
	return clock.Now().UTC()
}

func receiptID(planHash string, createdAt time.Time) string {
	if len(planHash) > 12 {
		planHash = planHash[:12]
	}
	return createdAt.Format("20060102T150405Z") + "-" + planHash
}
