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
	"regexp"
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
	ManagedMarketplaceInstall ManagedMarketplaceOperation = "install"
)

// ManagedMarketplaceMutation is the authority-bounded request accepted by the
// installed Marketplace helper. Roots, environment, scope, handlers, and
// permissions are derived by the Go owner and are never caller-provided.
type ManagedMarketplaceMutation struct {
	Operation ManagedMarketplaceOperation `json:"operation"`
	Specs     []string                    `json:"specs,omitempty"`
	Dev       bool                        `json:"dev,omitempty"`
}

type managedMarketplaceInstallResult struct {
	Schema    int                              `json:"schema"`
	Operation ManagedMarketplaceOperation      `json:"operation"`
	Installed []managedMarketplaceInstallEntry `json:"installed"`
}

type managedMarketplaceInstallEntry struct {
	PackageID   string `json:"packageId"`
	Version     string `json:"version"`
	PrimaryKind string `json:"primaryKind"`
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
	result, err := runMarketplaceStageHelper(ctx, l, active, stage, mutation)
	if err != nil {
		failure := fmt.Errorf("installed Marketplace stage helper failed: %w", err)
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			failure = errors.Join(failure, fmt.Errorf("remove failed Marketplace stage: %w", cleanupErr))
		}
		return "", failure
	}
	if err := verifyManagedMarketplaceInstall(stage, mutation, result); err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove invalid Marketplace stage: %w", cleanupErr))
		}
		return "", err
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
	if mutation.Operation != ManagedMarketplaceInstall {
		return fmt.Errorf("unsupported managed Marketplace operation %q", mutation.Operation)
	}
	if len(mutation.Specs) == 0 || len(mutation.Specs) > 32 {
		return fmt.Errorf("Marketplace install requires between 1 and 32 package specs")
	}
	for _, spec := range mutation.Specs {
		if err := install_spec.Validate(spec); err != nil {
			return fmt.Errorf("invalid Marketplace package spec: %w", err)
		}
	}
	return nil
}

func runMarketplaceStageHelper(ctx context.Context, layout Layout, configRoot, stage string, mutation ManagedMarketplaceMutation) (managedMarketplaceInstallResult, error) {
	packageJSON := filepath.Join(stage, "node_modules", "@kb-labs", "marketplace-app", "package.json")
	packageData, err := os.ReadFile(packageJSON)
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("installed Marketplace helper is unavailable in the candidate: %w", err)
	}
	helper := filepath.Join(stage, "node_modules", "@kb-labs", "marketplace-app", "dist", "bin.js")
	helperData, err := os.ReadFile(helper)
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("installed Marketplace helper entry is unavailable in the candidate: %w", err)
	}
	var helperMetadata struct {
		Name string `json:"name"`
		KB   struct {
			ManagedGenerationMutation int `json:"managedGenerationMutation"`
		} `json:"kb"`
	}
	if err := json.Unmarshal(packageData, &helperMetadata); err != nil || helperMetadata.Name != "@kb-labs/marketplace-app" || helperMetadata.KB.ManagedGenerationMutation != 1 || !bytes.Contains(helperData, []byte("--managed-generation-mutation")) {
		return managedMarketplaceInstallResult{}, fmt.Errorf("installed Marketplace helper lacks managed-generation mutation capability")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("resolve installed Node.js runtime: %w", err)
	}
	request, err := json.Marshal(mutation)
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	packageManagerRoot := contracts.PackageManagerStateDirectory(layout.Root)
	if err := os.MkdirAll(packageManagerRoot, 0o700); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	isolatedHome := filepath.Join(packageManagerRoot, "home")
	if err := os.MkdirAll(isolatedHome, 0o700); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if _, err := pinnedPackageManager(stage); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	corepack, err := exec.LookPath("corepack")
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("resolve Corepack for the pinned package manager: %w", err)
	}
	managedBin := filepath.Join(packageManagerRoot, "managed-bin")
	if err := os.MkdirAll(managedBin, 0o700); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	shim := filepath.Join(managedBin, "pnpm")
	shimData := []byte("#!/bin/sh\nexec " + shellQuote(corepack) + " pnpm \"$@\"\n")
	if err := os.WriteFile(shim, shimData, 0o700); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if err := syncFileAndDirectory(shim); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	command := exec.Command(node, helper, "--managed-generation-mutation")
	command.Dir = stage
	command.Env = managedMarketplaceEnvironment(configRoot, stage, packageManagerRoot, managedBin, isolatedHome, os.Environ())
	stdinReader, stdinWriter := io.Pipe()
	command.Stdin = stdinReader
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = io.Discard
	process, err := child.StartManaged(command, child.ProcessGroup, proc.ChildProcessObserver())
	if err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		return managedMarketplaceInstallResult{}, err
	}
	if err := layout.recordManagedStageOwner(stage, command.Process.Pid); err != nil {
		_ = stdinWriter.Close()
		waitErr := process.Wait(ctx)
		return managedMarketplaceInstallResult{}, errors.Join(err, waitErr)
	}
	_, writeErr := io.Copy(stdinWriter, bytes.NewReader(request))
	closeErr := stdinWriter.Close()
	waitErr := process.Wait(ctx)
	live, ownerErr := layout.managedStageOwnerLive(stage)
	if ownerErr != nil || live {
		return managedMarketplaceInstallResult{}, errors.Join(writeErr, closeErr, waitErr, ownerErr, fmt.Errorf("Marketplace helper process group remains live; candidate preserved at %s", stage))
	}
	if err := errors.Join(writeErr, closeErr, waitErr); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	var result managedMarketplaceInstallResult
	decoder := json.NewDecoder(&stdout)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("decode Marketplace helper result: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return managedMarketplaceInstallResult{}, fmt.Errorf("Marketplace helper returned trailing output")
	}
	return result, nil
}

func verifyManagedMarketplaceInstall(stage string, mutation ManagedMarketplaceMutation, result managedMarketplaceInstallResult) error {
	if result.Schema != 1 || result.Operation != ManagedMarketplaceInstall || len(result.Installed) != len(mutation.Specs) {
		return fmt.Errorf("Marketplace helper result does not prove all requested installs")
	}
	type lockEntry struct {
		Version      string `json:"version"`
		ResolvedPath string `json:"resolvedPath"`
	}
	var lock struct {
		Schema   string               `json:"schema"`
		Adapters map[string]lockEntry `json:"adapters"`
	}
	data, err := os.ReadFile(filepath.Join(stage, ".kb", "marketplace.lock"))
	if err != nil {
		return fmt.Errorf("read staged Marketplace lock: %w", err)
	}
	if err := json.Unmarshal(data, &lock); err != nil || lock.Schema != "kb.marketplace/3" {
		return fmt.Errorf("staged Marketplace lock is invalid")
	}
	seen := map[string]struct{}{}
	for _, installed := range result.Installed {
		if installed.PrimaryKind != "adapter" || installed.PackageID == "" || installed.Version == "" {
			return fmt.Errorf("Marketplace helper returned an invalid adapter install result")
		}
		if err := install_spec.Validate(installed.PackageID + "@" + installed.Version); err != nil {
			return fmt.Errorf("Marketplace helper returned an invalid installed package identity: %w", err)
		}
		if _, duplicate := seen[installed.PackageID]; duplicate {
			return fmt.Errorf("Marketplace helper returned duplicate package identity %q", installed.PackageID)
		}
		seen[installed.PackageID] = struct{}{}
		entry, ok := lock.Adapters[installed.PackageID]
		if !ok || entry.Version != installed.Version || entry.ResolvedPath == "" || filepath.IsAbs(entry.ResolvedPath) {
			return fmt.Errorf("staged Marketplace lock does not contain the reported adapter %q", installed.PackageID)
		}
		packagePath := filepath.Join(stage, filepath.FromSlash(entry.ResolvedPath))
		resolvedPackage, err := filepath.EvalSymlinks(packagePath)
		if err != nil {
			return fmt.Errorf("resolve staged adapter package %q: %w", installed.PackageID, err)
		}
		resolvedStage, err := filepath.EvalSymlinks(stage)
		if err != nil {
			return err
		}
		inside, err := contracts.PathWithin(resolvedStage, resolvedPackage)
		if err != nil || !inside {
			return fmt.Errorf("staged adapter package %q resolves outside its candidate generation", installed.PackageID)
		}
	}
	return nil
}

func pinnedPackageManager(stage string) (string, error) {
	data, err := os.ReadFile(filepath.Join(stage, "package.json"))
	if err != nil {
		return "", fmt.Errorf("read candidate package-manager pin: %w", err)
	}
	var manifest struct {
		PackageManager string `json:"packageManager"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", fmt.Errorf("decode candidate package-manager pin: %w", err)
	}
	if !regexp.MustCompile(`^pnpm@[0-9]+\.[0-9]+\.[0-9]+(?:\+sha[0-9a-fA-F]+)?$`).MatchString(manifest.PackageManager) {
		return "", fmt.Errorf("candidate package.json must declare an exact pnpm packageManager version")
	}
	return manifest.PackageManager, nil
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func managedMarketplaceEnvironment(configRoot, stage, packageManagerRoot, managedBin, isolatedHome string, base []string) []string {
	allowed := map[string]struct{}{"path": {}, "tmpdir": {}, "tmp": {}, "temp": {}, "lang": {}, "lc_all": {}, "lc_ctype": {}, "ssl_cert_file": {}, "ssl_cert_dir": {}}
	canonical := map[string]string{"path": "PATH", "tmpdir": "TMPDIR", "tmp": "TMP", "temp": "TEMP", "lang": "LANG", "lc_all": "LC_ALL", "lc_ctype": "LC_CTYPE", "ssl_cert_file": "SSL_CERT_FILE", "ssl_cert_dir": "SSL_CERT_DIR"}
	values := map[string]string{}
	for _, entry := range base {
		name, value, ok := strings.Cut(entry, "=")
		if _, safe := allowed[strings.ToLower(name)]; ok && safe {
			values[strings.ToLower(name)] = value
		}
	}
	values["path"] = managedBin + string(os.PathListSeparator) + values["path"]
	values["home"] = isolatedHome
	environment := make([]string, 0, len(values)+12)
	for name, value := range values {
		if envName, ok := canonical[name]; ok {
			environment = append(environment, envName+"="+value)
		}
	}
	return append(environment,
		"HOME="+isolatedHome,
		"KB_PLATFORM_ROOT="+stage,
		"KB_MARKETPLACE_CONFIG_ROOT="+configRoot,
		"KB_HOME="+isolatedHome,
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

func syncFileAndDirectory(path string) error {
	file, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
