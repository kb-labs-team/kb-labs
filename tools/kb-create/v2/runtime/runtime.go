// Package runtime is the autonomous V2 application boundary. It accepts an
// already resolved plan, applies exact artifacts, renders its projections,
// verifies the resolved service graph and only then commits a receipt.
package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/lifecycle"
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
type ServiceActivator interface {
	Ensure(platformRoot string, serviceIDs []string) error
}
type ServiceDeactivator interface {
	Stop(platformRoot string, serviceIDs []string) error
}

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

type Dependencies struct {
	Artifacts   ArtifactInstaller
	Status      verify.StatusProvider
	Activator   ServiceActivator
	Deactivator ServiceDeactivator
	Clock       Clock
	// CorrelationID is supplied by a frontend; it is persisted verbatim in the
	// receipt and must be safe to disclose in a diagnostic bundle.
	CorrelationID string
	Secrets       *secrets.Store
}

// Apply is the one V2 fresh-install operation. It deliberately has no
// dependency on legacy manifests, state or package scanning.
func Apply(plan contracts.ResolvedInstallPlan, deps Dependencies) (contracts.InstallReceipt, error) {
	if plan.Schema != contracts.ResolvedPlanSchema {
		return contracts.InstallReceipt{}, fmt.Errorf("apply resolved plan: unsupported schema %q", plan.Schema)
	}
	if deps.Artifacts == nil || deps.Status == nil {
		return contracts.InstallReceipt{}, fmt.Errorf("apply resolved plan: artifact installer and status provider are required")
	}
	if err := verifySecrets(plan, deps.Secrets); err != nil {
		return contracts.InstallReceipt{}, err
	}
	if err := deps.Artifacts.Install(plan.Artifacts); err != nil {
		return contracts.InstallReceipt{}, fmt.Errorf("apply exact artifacts: %w", err)
	}
	if _, err := render.Write(plan); err != nil {
		return contracts.InstallReceipt{}, fmt.Errorf("render resolved projections: %w", err)
	}
	if deps.Activator != nil {
		if err := deps.Activator.Ensure(plan.Request.PlatformRoot, serviceIDs(plan.ServiceGraph)); err != nil {
			_ = removeProjections(plan.Request.PlatformRoot)
			return contracts.InstallReceipt{}, fmt.Errorf("ensure resolved service graph: %w", err)
		}
	}
	now := now(deps.Clock)
	check, err := verify.Run(plan, deps.Status, now)
	if err != nil {
		// A fresh run has no prior receipt to restore. Remove only V2-owned
		// projections so an incomplete graph cannot masquerade as installed.
		_ = removeProjections(plan.Request.PlatformRoot)
		return contracts.InstallReceipt{}, fmt.Errorf("verify resolved service graph: %w", err)
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
func Update(plan contracts.ResolvedInstallPlan, deps Dependencies) (contracts.InstallReceipt, contracts.Snapshot, error) {
	if deps.Artifacts == nil || deps.Status == nil {
		return contracts.InstallReceipt{}, contracts.Snapshot{}, fmt.Errorf("update resolved plan: artifact installer and status provider are required")
	}
	var result contracts.InstallReceipt
	snapshot, err := lifecycle.Mutate(plan.Request.PlatformRoot, now(deps.Clock), func() error {
		var applyErr error
		result, applyErr = Apply(plan, deps)
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
// verified receipt. The snapshot remains in .kb/v2/snapshots so a failed
// operation can recover; a successful deletion leaves explicit recovery data
// rather than claiming user-authored project files are disposable.
func Uninstall(platformRoot string, deps Dependencies) (contracts.Snapshot, error) {
	if deps.Artifacts == nil || deps.Status == nil || deps.Activator == nil || deps.Deactivator == nil {
		return contracts.Snapshot{}, fmt.Errorf("uninstall: artifact installer, status provider, service activator and service deactivator are required")
	}
	uninstaller, ok := deps.Artifacts.(ArtifactUninstaller)
	if !ok {
		return contracts.Snapshot{}, fmt.Errorf("uninstall: artifact installer does not support removal")
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return contracts.Snapshot{}, fmt.Errorf("uninstall: read active receipt: %w", err)
	}
	ids := serviceIDs(active.Plan.ServiceGraph)
	return lifecycle.Mutate(platformRoot, now(deps.Clock), func() error {
		if err := deps.Deactivator.Stop(platformRoot, ids); err != nil {
			return err
		}
		// The installed kb-dev binary is itself an artifact being removed. Verify
		// that every service is stopped while that binary and its managed config
		// still exist; a lifecycle-level verification after artifact deletion
		// could no longer execute `kb-dev status`.
		observed, err := deps.Status.ServiceStatuses(platformRoot)
		if err != nil {
			return fmt.Errorf("verify stopped service graph: %w", err)
		}
		for _, service := range observed {
			if service.State != "dead" {
				return fmt.Errorf("uninstall left service %s in state %s", service.ID, service.State)
			}
		}
		if err := uninstaller.Uninstall(active.Plan.Artifacts); err != nil {
			return err
		}
		// Only V2-owned projections are removed. Project roots and any user
		// authored files remain outside this operation's authority.
		if err := removeProjections(platformRoot); err != nil {
			return err
		}
		return receipt.Delete(platformRoot)
	}, nil, func() error {
		if err := deps.Artifacts.Restore(); err != nil {
			return err
		}
		return deps.Activator.Ensure(platformRoot, ids)
	})
}

// Rollback restores an explicit V2 snapshot, reinstalls its exact lock state,
// and brings the receipt's recorded graph back to readiness before reporting
// success. It never infers a target from package tags or legacy state.
func Rollback(platformRoot, snapshotID string, deps Dependencies) (contracts.Snapshot, error) {
	if snapshotID == "" {
		return contracts.Snapshot{}, fmt.Errorf("rollback: snapshot ID is required")
	}
	if deps.Artifacts == nil || deps.Status == nil || deps.Activator == nil {
		return contracts.Snapshot{}, fmt.Errorf("rollback: artifact installer, status provider and service activator are required")
	}
	snapshot, err := lifecycle.Rollback(platformRoot, snapshotID, deps.Artifacts.Restore)
	if err != nil {
		return snapshot, err
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return snapshot, fmt.Errorf("rollback: read restored receipt: %w", err)
	}
	if err := deps.Activator.Ensure(platformRoot, serviceIDs(active.Plan.ServiceGraph)); err != nil {
		return snapshot, fmt.Errorf("rollback: ensure restored service graph: %w", err)
	}
	if _, err := verify.Run(active.Plan, deps.Status, now(deps.Clock)); err != nil {
		return snapshot, fmt.Errorf("rollback: verify restored service graph: %w", err)
	}
	return snapshot, nil
}

// DoctorFix applies only manifest-declared safe defaults under a snapshot, then
// re-ensures and verifies the receipt graph. Required user input is never
// guessed: callers receive an error before any write occurs.
func DoctorFix(platformRoot string, repair doctor.RepairPlan, deps Dependencies) (contracts.Snapshot, error) {
	if len(repair.RequiredInput) != 0 {
		return contracts.Snapshot{}, fmt.Errorf("doctor fix requires %d explicit input value(s)", len(repair.RequiredInput))
	}
	if deps.Status == nil || deps.Activator == nil {
		return contracts.Snapshot{}, fmt.Errorf("doctor fix: status provider and service activator are required")
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return contracts.Snapshot{}, fmt.Errorf("doctor fix: read active receipt: %w", err)
	}
	return lifecycle.Mutate(platformRoot, now(deps.Clock), func() error {
		if err := doctor.ApplyDefaults(platformRoot, repair); err != nil {
			return err
		}
		return deps.Activator.Ensure(platformRoot, serviceIDs(active.Plan.ServiceGraph))
	}, func() error {
		_, err := verify.Run(active.Plan, deps.Status, now(deps.Clock))
		return err
	}, nil)
}

func removeProjections(platformRoot string) error {
	for _, relative := range []string{".kb/kb.config.jsonc", ".kb/devservices.yaml"} {
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

func serviceIDs(graph contracts.ServiceGraph) []string {
	result := make([]string, 0, len(graph.Services))
	for _, service := range graph.Services {
		result = append(result, service.ID)
	}
	return result
}
