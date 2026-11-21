package versionroot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kb-labs/clikit/operationlock"
	"github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/marketplace/install_spec"
	"github.com/kb-labs/create/v2/receipt"
)

type ManagedMarketplaceOperation string

const (
	ManagedMarketplaceInstall   ManagedMarketplaceOperation = "install"
	ManagedMarketplaceUninstall ManagedMarketplaceOperation = "uninstall"
	ManagedMarketplaceUpdate    ManagedMarketplaceOperation = "update"
	ManagedMarketplaceEnable    ManagedMarketplaceOperation = "enable"
	ManagedMarketplaceDisable   ManagedMarketplaceOperation = "disable"
)

// ManagedMarketplaceMutation is the authority-bounded request accepted by the
// installed Marketplace helper. Roots, environment, scope, handlers, and
// permissions are derived by the Go owner and are never caller-provided.
type ManagedMarketplaceMutation struct {
	Operation  ManagedMarketplaceOperation `json:"operation"`
	Specs      []string                    `json:"specs,omitempty"`
	PackageIDs []string                    `json:"packageIds,omitempty"`
	PackageID  string                      `json:"packageId,omitempty"`
	Dev        bool                        `json:"dev,omitempty"`
}

// RunManagedMarketplaceMutation owns the cross-process installation lock for
// the full operation. The installed TypeScript Marketplace service performs
// package resolution, package graph changes, validation, Marketplace lock and
// manifest-cache writes inside a disposable stage. Only a successful helper
// exit and a second physical-tree validation can switch current.
func (l Layout) RunManagedMarketplaceMutation(ctx context.Context, runningRoot string, mutation ManagedMarketplaceMutation) (string, error) {
	if ctx == nil {
		return "", fmt.Errorf("managed Marketplace mutation context is required")
	}
	if err := validateManagedMarketplaceMutation(mutation); err != nil {
		return "", err
	}
	if strings.TrimSpace(runningRoot) == "" {
		return "", fmt.Errorf("physical running or active generation root is required for retention")
	}
	lock, err := operationlock.Acquire(operationlock.Path(l.HostStateDir()), "managed-marketplace-mutation")
	if err != nil {
		return "", fmt.Errorf("acquire installation operation lock: %w", err)
	}
	defer lock.Release()
	if err := ctx.Err(); err != nil {
		return "", err
	}

	active, err := l.Active()
	if err != nil {
		return "", err
	}
	runningRoot, err = l.resolveVersionPath(runningRoot)
	if err != nil {
		return "", fmt.Errorf("resolve protected running generation: %w", err)
	}
	if err := l.validateVersionPath(runningRoot); err != nil {
		return "", fmt.Errorf("validate protected running generation: %w", err)
	}
	activeReceipt, err := receipt.Read(active)
	if err != nil {
		return "", err
	}
	runningReceipt, err := receipt.Read(runningRoot)
	if err != nil {
		return "", err
	}
	if activeReceipt.InstallationID != runningReceipt.InstallationID {
		return "", fmt.Errorf("protected running generation belongs to a different installation")
	}

	stage, err := l.StageManagedGeneration()
	if err != nil {
		return "", fmt.Errorf("stage Marketplace mutation: %w", err)
	}
	if err := runMarketplaceStageHelper(ctx, l.Root, active, stage, mutation); err != nil {
		failure := fmt.Errorf("installed Marketplace stage helper failed: %w", err)
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			failure = errors.Join(failure, fmt.Errorf("remove failed Marketplace stage: %w", cleanupErr))
		}
		return "", failure
	}
	if err := ctx.Err(); err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove canceled Marketplace stage: %w", cleanupErr))
		}
		return "", err
	}
	activeAfterHelper, err := l.Active()
	if err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove uncommitted Marketplace stage: %w", cleanupErr))
		}
		return "", err
	}
	if filepath.Clean(activeAfterHelper) != filepath.Clean(active) {
		cleanupErr := l.AbortManagedGeneration(stage)
		failure := fmt.Errorf("active generation changed while the installation operation lock was held")
		if cleanupErr != nil {
			failure = errors.Join(failure, fmt.Errorf("remove stale Marketplace stage: %w", cleanupErr))
		}
		return "", failure
	}
	return l.ActivateManagedGeneration(stage, active, runningRoot)
}

func validateManagedMarketplaceMutation(mutation ManagedMarketplaceMutation) error {
	switch mutation.Operation {
	case ManagedMarketplaceInstall:
		if len(mutation.Specs) == 0 || len(mutation.PackageIDs) != 0 || mutation.PackageID != "" {
			return fmt.Errorf("Marketplace install requires package specs only")
		}
		for _, spec := range mutation.Specs {
			if err := install_spec.Validate(spec); err != nil {
				return fmt.Errorf("invalid Marketplace package spec: %w", err)
			}
		}
	case ManagedMarketplaceUninstall, ManagedMarketplaceUpdate:
		if len(mutation.Specs) != 0 || mutation.PackageID != "" {
			return fmt.Errorf("Marketplace %s accepts package IDs only", mutation.Operation)
		}
		for _, id := range mutation.PackageIDs {
			if err := validateMarketplaceID(id); err != nil {
				return err
			}
		}
	case ManagedMarketplaceEnable, ManagedMarketplaceDisable:
		if len(mutation.Specs) != 0 || len(mutation.PackageIDs) != 0 || mutation.PackageID == "" {
			return fmt.Errorf("Marketplace %s requires one package ID", mutation.Operation)
		}
		if err := validateMarketplaceID(mutation.PackageID); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported managed Marketplace operation %q", mutation.Operation)
	}
	return nil
}

func validateMarketplaceID(id string) error {
	if err := install_spec.Validate(id + "@0.0.0"); err != nil {
		return fmt.Errorf("invalid Marketplace package ID: %w", err)
	}
	return nil
}

func runMarketplaceStageHelper(ctx context.Context, installRoot, configRoot, stage string, mutation ManagedMarketplaceMutation) error {
	packageJSON := filepath.Join(stage, "node_modules", "@kb-labs", "marketplace-app", "package.json")
	if _, err := os.Stat(packageJSON); err != nil {
		return fmt.Errorf("installed Marketplace helper is unavailable in the candidate: %w", err)
	}
	helper := filepath.Join(stage, "node_modules", "@kb-labs", "marketplace-app", "dist", "bin.js")
	if _, err := os.Stat(helper); err != nil {
		return fmt.Errorf("installed Marketplace helper entry is unavailable in the candidate: %w", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return fmt.Errorf("resolve installed Node.js runtime: %w", err)
	}
	request, err := json.Marshal(mutation)
	if err != nil {
		return err
	}
	packageManagerRoot := contracts.PackageManagerStateDirectory(installRoot)
	if err := os.MkdirAll(packageManagerRoot, 0o700); err != nil {
		return err
	}
	command := exec.Command(node, helper, "--managed-generation-mutation")
	command.Dir = stage
	command.Env = managedMarketplaceEnvironment(installRoot, configRoot, stage, packageManagerRoot, os.Environ())
	command.Stdin = bytes.NewReader(request)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	process, err := child.StartManaged(command, child.ProcessGroup, proc.ChildProcessObserver())
	if err != nil {
		return err
	}
	return process.Wait(ctx)
}

func managedMarketplaceEnvironment(installRoot, configRoot, stage, packageManagerRoot string, base []string) []string {
	owned := map[string]struct{}{
		"kb_platform_root": {}, "kb_marketplace_config_root": {}, "kb_home": {},
		"corepack_home": {}, "pnpm_home": {}, "xdg_cache_home": {}, "xdg_data_home": {}, "xdg_state_home": {},
		"npm_config_cache": {}, "npm_config_store_dir": {}, "npm_config_devdir": {},
	}
	environment := make([]string, 0, len(base)+11)
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if _, protected := owned[strings.ToLower(name)]; !protected {
			environment = append(environment, entry)
		}
	}
	return append(environment,
		"KB_PLATFORM_ROOT="+stage,
		"KB_MARKETPLACE_CONFIG_ROOT="+configRoot,
		"KB_HOME="+contracts.KBHomeDirectory(installRoot),
		"COREPACK_HOME="+filepath.Join(packageManagerRoot, "corepack"),
		"PNPM_HOME="+filepath.Join(packageManagerRoot, "pnpm-home"),
		"XDG_CACHE_HOME="+filepath.Join(packageManagerRoot, "xdg-cache"),
		"XDG_DATA_HOME="+filepath.Join(packageManagerRoot, "xdg-data"),
		"XDG_STATE_HOME="+filepath.Join(packageManagerRoot, "xdg-state"),
		"npm_config_cache="+filepath.Join(packageManagerRoot, "pnpm-cache"),
		"npm_config_store_dir="+filepath.Join(packageManagerRoot, "pnpm-store"),
		"npm_config_devdir="+filepath.Join(packageManagerRoot, "node-gyp"),
	)
}
