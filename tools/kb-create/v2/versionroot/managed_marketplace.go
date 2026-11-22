package versionroot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/kb-labs/clikit/operationlock"
	"github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/marketplace/install_spec"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/semrange"
	"gopkg.in/yaml.v3"
)

type ManagedMarketplaceOperation string

const (
	ManagedMarketplaceInstall ManagedMarketplaceOperation = "install"
	ManagedMarketplaceUpdate  ManagedMarketplaceOperation = "update"
)

// ManagedMarketplaceMutation is the authority-bounded request accepted by the
// installed Marketplace helper. Roots, environment, scope, handlers, and
// permissions are derived by the Go owner and are never caller-provided.
type ManagedMarketplaceMutation struct {
	Operation          ManagedMarketplaceOperation `json:"operation"`
	Specs              []string                    `json:"specs,omitempty"`
	PackageIDs         []string                    `json:"packageIds,omitempty"`
	Dev                bool                        `json:"dev,omitempty"`
	packageIDsProvided bool
}

func (mutation *ManagedMarketplaceMutation) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields == nil {
		return fmt.Errorf("managed Marketplace mutation must be an object")
	}
	var operation ManagedMarketplaceOperation
	if rawOperation, ok := fields["operation"]; !ok || json.Unmarshal(rawOperation, &operation) != nil {
		return fmt.Errorf("managed Marketplace mutation operation is required")
	}
	allowed := map[string]struct{}{"operation": {}}
	switch operation {
	case ManagedMarketplaceInstall:
		allowed["specs"] = struct{}{}
		allowed["dev"] = struct{}{}
	case ManagedMarketplaceUpdate:
		allowed["packageIds"] = struct{}{}
	default:
		return fmt.Errorf("unsupported managed Marketplace operation %q", operation)
	}
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unsupported managed Marketplace mutation field %q", key)
		}
	}
	type wire ManagedMarketplaceMutation
	var decoded wire
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*mutation = ManagedMarketplaceMutation(decoded)
	_, mutation.packageIDsProvided = fields["packageIds"]
	return nil
}

// ManagedMarketplaceMutationResult carries the Marketplace API response fields
// after the candidate has been activated. Package roots are rewritten to the
// activated generation, never returned as stale staging paths.
type ManagedMarketplaceMutationResult struct {
	Installed  []ManagedMarketplaceInstallResult `json:"installed"`
	Warnings   []string                          `json:"warnings"`
	Scope      string                            `json:"scope"`
	ActiveRoot string                            `json:"-"`
}

type ManagedMarketplaceInstallResult struct {
	Spec            string   `json:"spec"`
	ID              string   `json:"id"`
	Version         string   `json:"version"`
	PrimaryKind     string   `json:"primaryKind"`
	Provides        []string `json:"provides"`
	PackageRoot     string   `json:"packageRoot"`
	Scope           string   `json:"scope"`
	Source          string   `json:"source"`
	SignatureStatus string   `json:"signatureStatus"`
}

// OperationLockPath is the per-installation kernel lock shared by generation
// activation and platform lifecycle writers. Keep lock ownership rooted in the
// installation container so callers cannot accidentally serialize on the
// version directory that changes during activation.
func (l Layout) OperationLockPath() string {
	return operationlock.Path(l.HostStateDir())
}

type managedMarketplaceInstallResult struct {
	Schema    int                              `json:"schema"`
	Operation ManagedMarketplaceOperation      `json:"operation"`
	Installed []managedMarketplaceInstallEntry `json:"installed"`
	Warnings  []string                         `json:"warnings"`
}

type managedMarketplaceInstallEntry struct {
	RequestedSpec   string `json:"requestedSpec"`
	PackageID       string `json:"packageId"`
	Version         string `json:"version"`
	ResolvedVersion string `json:"resolvedVersion"`
	PrimaryKind     string `json:"primaryKind"`
}

type managedPnpmLockSnapshot struct {
	Dependencies         map[string]string `yaml:"dependencies"`
	OptionalDependencies map[string]string `yaml:"optionalDependencies"`
}

type managedMarketplaceEnvRefs struct {
	Schema      int      `json:"schema"`
	Environment []string `json:"environment"`
}

type boundedProcessOutput struct {
	bytes.Buffer
	limit int
}

func (b *boundedProcessOutput) Write(data []byte) (int, error) {
	original := len(data)
	remaining := b.limit - b.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = b.Buffer.Write(data)
	}
	return original, nil
}

type managedHelperFailure struct {
	Schema  int    `json:"schema"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

// RunManagedMarketplaceMutation owns the cross-process installation lock for
// the full operation. The installed TypeScript Marketplace service performs
// package resolution, package graph changes, validation, Marketplace lock and
// manifest-cache writes inside a disposable stage. Only a successful helper
// exit and a second physical-tree validation can switch current.
func (l Layout) RunManagedMarketplaceMutation(ctx context.Context, runningRoot string, mutation ManagedMarketplaceMutation) (ManagedMarketplaceMutationResult, error) {
	if ctx == nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("managed Marketplace mutation context is required")
	}
	if err := validateManagedMarketplaceMutation(mutation); err != nil {
		return ManagedMarketplaceMutationResult{}, err
	}
	if strings.TrimSpace(runningRoot) == "" {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("physical running or active generation root is required for retention")
	}
	lock, err := operationlock.Acquire(l.OperationLockPath(), "managed-marketplace-mutation")
	if err != nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("acquire installation operation lock: %w", err)
	}
	defer lock.Release()
	return l.runManagedMarketplaceMutationLocked(ctx, runningRoot, mutation)
}

// RunManagedMarketplaceMutationWithHeldLease is for an installation lifecycle
// transaction that already owns this process's kernel lease. It never drops
// or reacquires that lease, and refuses the call unless the exact install lock
// is held by this process.
func (l Layout) RunManagedMarketplaceMutationWithHeldLease(ctx context.Context, runningRoot string, mutation ManagedMarketplaceMutation) (result ManagedMarketplaceMutationResult, err error) {
	lease := operationlock.Held(l.OperationLockPath())
	if lease == nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("managed Marketplace mutation requires the current process to hold the installation operation lock")
	}
	err = lease.With(func() error {
		result, err = l.runManagedMarketplaceMutationLocked(ctx, runningRoot, mutation)
		return err
	})
	return result, err
}

func (l Layout) runManagedMarketplaceMutationLocked(ctx context.Context, runningRoot string, mutation ManagedMarketplaceMutation) (ManagedMarketplaceMutationResult, error) {
	if ctx == nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("managed Marketplace mutation context is required")
	}
	if err := validateManagedMarketplaceMutation(mutation); err != nil {
		return ManagedMarketplaceMutationResult{}, err
	}
	if strings.TrimSpace(runningRoot) == "" {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("physical running or active generation root is required for retention")
	}
	if err := ctx.Err(); err != nil {
		return ManagedMarketplaceMutationResult{}, err
	}

	active, err := l.Active()
	if err != nil {
		return ManagedMarketplaceMutationResult{}, err
	}
	runningRoot, err = l.resolveVersionPath(runningRoot)
	if err != nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("resolve protected running generation: %w", err)
	}
	if err := l.validateVersionPath(runningRoot); err != nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("validate protected running generation: %w", err)
	}
	activeReceipt, err := receipt.Read(active)
	if err != nil {
		return ManagedMarketplaceMutationResult{}, err
	}
	runningReceipt, err := receipt.Read(runningRoot)
	if err != nil {
		return ManagedMarketplaceMutationResult{}, err
	}
	if activeReceipt.InstallationID != runningReceipt.InstallationID {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("protected running generation belongs to a different installation")
	}
	if mutation.Operation == ManagedMarketplaceUpdate {
		if _, err := managedMarketplaceUpdateTargets(active, mutation); err != nil {
			return ManagedMarketplaceMutationResult{}, err
		}
	}

	stage, err := l.StageManagedGeneration()
	if err != nil {
		return ManagedMarketplaceMutationResult{}, fmt.Errorf("stage Marketplace mutation: %w", err)
	}
	result, err := runMarketplaceStageHelper(ctx, l, active, stage, mutation)
	if err != nil {
		failure := fmt.Errorf("installed Marketplace stage helper failed: %w", err)
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			failure = errors.Join(failure, fmt.Errorf("remove failed Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, failure
	}
	if err := verifyManagedMarketplaceMutation(active, stage, mutation, result); err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove invalid Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, err
	}
	if err := verifyManagedMarketplaceCoreGraph(active, stage, mutation, result); err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove invalid Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, err
	}
	entries, err := managedMarketplaceAPIEntries(stage, result)
	if err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove invalid Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, err
	}
	if err := ctx.Err(); err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove canceled Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, err
	}
	activeAfterHelper, err := l.Active()
	if err != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("remove uncommitted Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, err
	}
	if filepath.Clean(activeAfterHelper) != filepath.Clean(active) {
		cleanupErr := l.AbortManagedGeneration(stage)
		failure := fmt.Errorf("active generation changed while the installation operation lock was held")
		if cleanupErr != nil {
			failure = errors.Join(failure, fmt.Errorf("remove stale Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, failure
	}
	noop, noopErr := managedMarketplaceInstallIsNoop(active, stage, mutation, result)
	if noopErr != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			noopErr = errors.Join(noopErr, fmt.Errorf("remove invalid Marketplace stage: %w", cleanupErr))
		}
		return ManagedMarketplaceMutationResult{}, noopErr
	}
	activeRoot := active
	if noop {
		if err := l.AbortManagedGeneration(stage); err != nil {
			return ManagedMarketplaceMutationResult{}, fmt.Errorf("remove no-op Marketplace candidate: %w", err)
		}
	} else {
		activeRoot, err = l.ActivateManagedGeneration(stage, active, runningRoot)
		if err != nil {
			return ManagedMarketplaceMutationResult{}, err
		}
	}
	for index := range entries {
		entries[index].PackageRoot = filepath.Join(activeRoot, entries[index].PackageRoot)
	}
	warnings := result.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	return ManagedMarketplaceMutationResult{Installed: entries, Warnings: warnings, Scope: "platform", ActiveRoot: activeRoot}, nil
}

func managedMarketplaceAPIEntries(stage string, result managedMarketplaceInstallResult) ([]ManagedMarketplaceInstallResult, error) {
	type lockEntry struct {
		ResolvedPath      string   `json:"resolvedPath"`
		Version           string   `json:"version"`
		Provides          []string `json:"provides"`
		MarketplaceSource string   `json:"marketplaceSource"`
		SignatureStatus   string   `json:"signatureStatus"`
	}
	var lock struct {
		Plugins  map[string]lockEntry `json:"plugins"`
		Adapters map[string]lockEntry `json:"adapters"`
	}
	data, err := os.ReadFile(filepath.Join(stage, ".kb", "marketplace.lock"))
	if err != nil {
		return nil, fmt.Errorf("read staged Marketplace result: %w", err)
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, fmt.Errorf("parse staged Marketplace result: %w", err)
	}
	entries := make([]ManagedMarketplaceInstallResult, 0, len(result.Installed))
	for _, installed := range result.Installed {
		entry, ok := lock.Adapters[installed.PackageID]
		if installed.PrimaryKind == "plugin" {
			entry, ok = lock.Plugins[installed.PackageID]
		}
		if !ok || entry.Version != installed.Version || entry.ResolvedPath == "" {
			return nil, fmt.Errorf("staged Marketplace result is missing package %q", installed.PackageID)
		}
		provides := append([]string(nil), entry.Provides...)
		if len(provides) == 0 {
			provides = []string{installed.PrimaryKind}
		}
		entries = append(entries, ManagedMarketplaceInstallResult{
			Spec: installed.RequestedSpec, ID: installed.PackageID, Version: installed.Version,
			PrimaryKind: installed.PrimaryKind, Provides: provides, PackageRoot: filepath.FromSlash(entry.ResolvedPath),
			Scope: "platform", Source: entry.MarketplaceSource, SignatureStatus: entry.SignatureStatus,
		})
	}
	return entries, nil
}

func validateManagedMarketplaceMutation(mutation ManagedMarketplaceMutation) error {
	switch mutation.Operation {
	case ManagedMarketplaceInstall:
		if len(mutation.Specs) == 0 || len(mutation.Specs) > 32 || mutation.packageIDsProvided || len(mutation.PackageIDs) != 0 {
			return fmt.Errorf("Marketplace install requires between 1 and 32 package specs")
		}
		seen := map[string]struct{}{}
		for _, spec := range mutation.Specs {
			if err := install_spec.Validate(spec); err != nil {
				return fmt.Errorf("invalid Marketplace package spec: %w", err)
			}
			if _, duplicate := seen[spec]; duplicate {
				return fmt.Errorf("duplicate Marketplace install spec %q", spec)
			}
			seen[spec] = struct{}{}
		}
		return nil
	case ManagedMarketplaceUpdate:
		if len(mutation.Specs) != 0 || mutation.Dev {
			return fmt.Errorf("Marketplace adapter update accepts package IDs only")
		}
		if mutation.packageIDsProvided && mutation.PackageIDs == nil {
			return fmt.Errorf("Marketplace adapter update package IDs must be omitted or contain at least one ID")
		}
		if mutation.PackageIDs != nil && len(mutation.PackageIDs) == 0 {
			return fmt.Errorf("Marketplace adapter update package IDs must be omitted or contain at least one ID")
		}
		if len(mutation.PackageIDs) > 32 {
			return fmt.Errorf("Marketplace adapter update accepts at most 32 package IDs")
		}
		seen := map[string]struct{}{}
		for _, packageID := range mutation.PackageIDs {
			name, version, ok := splitMarketplaceSpec(packageID)
			if !ok || name != packageID || version != "" {
				return fmt.Errorf("invalid Marketplace package ID %q", packageID)
			}
			if _, duplicate := seen[packageID]; duplicate {
				return fmt.Errorf("duplicate Marketplace package ID %q", packageID)
			}
			seen[packageID] = struct{}{}
		}
		return nil
	default:
		return fmt.Errorf("unsupported managed Marketplace operation %q", mutation.Operation)
	}
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
	if err := json.Unmarshal(packageData, &helperMetadata); err != nil || helperMetadata.Name != "@kb-labs/marketplace-app" || helperMetadata.KB.ManagedGenerationMutation != 1 || !bytes.Contains(helperData, []byte("--managed-generation-mutation")) || !bytes.Contains(helperData, []byte("--managed-generation-mutation-env-refs")) {
		return managedMarketplaceInstallResult{}, fmt.Errorf("installed Marketplace helper lacks managed-generation mutation capability")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("resolve installed Node.js runtime: %w", err)
	}
	packageManagerRoot := contracts.PackageManagerStateDirectory(layout.Root)
	if err := ensureManagedDirectory(layout.Root, packageManagerRoot); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	isolatedHome := filepath.Join(packageManagerRoot, "home")
	if err := ensureManagedDirectory(layout.Root, isolatedHome); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	for _, directory := range []string{"pnpm-home", "xdg-cache", "xdg-data", "xdg-state", "pnpm-cache", "pnpm-store", "node-gyp"} {
		if err := ensureManagedDirectory(layout.Root, filepath.Join(packageManagerRoot, directory)); err != nil {
			return managedMarketplaceInstallResult{}, err
		}
	}
	corepackHome := filepath.Join(packageManagerRoot, "corepack")
	if err := ensureManagedDirectory(layout.Root, corepackHome); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	pnpmNode, pnpmScript, err := toolchain.PnpmExecutableAt(corepackHome)
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("resolve managed pnpm %s: %w", toolchain.SupportedPnpm, err)
	}
	artifactCache, err := layout.SharedRuntimePath(".kb/v2/cache")
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if err := ensureManagedDirectory(layout.Root, artifactCache); err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("validate shared artifact cache: %w", err)
	}
	artifactCache, err = filepath.EvalSymlinks(artifactCache)
	if err != nil {
		return managedMarketplaceInstallResult{}, fmt.Errorf("resolve shared artifact cache: %w", err)
	}
	managedBin := filepath.Join(stage, ".kb", "v2", ".managed-pnpm-bin")
	if err := ensureManagedCandidateDirectory(stage, managedBin); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	shim := filepath.Join(managedBin, "pnpm")
	shimData := []byte("#!/bin/sh\nexec " + shellQuote(pnpmNode) + " " + shellQuote(pnpmScript) + " \"$@\"\n")
	file, err := os.OpenFile(shim, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if _, err := file.Write(shimData); err != nil {
		_ = file.Close()
		return managedMarketplaceInstallResult{}, err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return managedMarketplaceInstallResult{}, err
	}
	if err := file.Close(); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if err := syncFileAndDirectory(shim); err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	command := exec.Command(node, helper, "--managed-generation-mutation")
	command.Dir = stage
	baseEnvironment := os.Environ()
	command.Env = append(managedMarketplaceEnvironment(configRoot, stage, packageManagerRoot, managedBin, isolatedHome, baseEnvironment), "KB_MANAGED_ARTIFACT_CACHE_ROOT="+artifactCache)
	expectedEnvRefs, err := managedMarketplaceCredentialRefs(configRoot)
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	envRefs, err := probeManagedMarketplaceEnvRefs(ctx, node, helper, stage, command.Env)
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if !sameMarketplaceCredentialRefs(expectedEnvRefs, envRefs.Environment) {
		return managedMarketplaceInstallResult{}, fmt.Errorf("installed Marketplace helper credential references do not match the active source configuration")
	}
	credentials, err := marketplaceCredentialValues(expectedEnvRefs, baseEnvironment)
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	request, err := json.Marshal(struct {
		Mutation    ManagedMarketplaceMutation `json:"mutation"`
		Environment map[string]string          `json:"environment"`
	}{Mutation: mutation, Environment: credentials})
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	if len(request) > 64*1024 {
		return managedMarketplaceInstallResult{}, fmt.Errorf("managed Marketplace request exceeds the size limit")
	}
	command.Env = append(managedMarketplaceEnvironment(configRoot, stage, packageManagerRoot, managedBin, isolatedHome, baseEnvironment), "KB_MANAGED_ARTIFACT_CACHE_ROOT="+artifactCache)
	stdinReader, stdinWriter := io.Pipe()
	command.Stdin = stdinReader
	var stdout bytes.Buffer
	var stderr boundedProcessOutput
	stderr.limit = 16 * 1024
	command.Stdout = &stdout
	command.Stderr = &stderr
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
	if err := removeManagedCandidateDirectory(stage, managedBin); err != nil {
		return managedMarketplaceInstallResult{}, errors.Join(writeErr, closeErr, waitErr, fmt.Errorf("remove private package-manager shim: %w", err))
	}
	if err := errors.Join(writeErr, closeErr, waitErr); err != nil {
		return managedMarketplaceInstallResult{}, errors.Join(decodeManagedHelperFailure(stderr.Bytes()), err)
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

func decodeManagedHelperFailure(data []byte) error {
	if len(data) == 0 || len(data) > 16*1024 {
		return nil
	}
	var failure managedHelperFailure
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&failure); err != nil || failure.Schema != 1 || failure.Code == "" || len(failure.Code) > 96 || failure.Message == "" || len(failure.Message) > 2048 || len(failure.Hint) > 1024 {
		return nil
	}
	for _, char := range failure.Code {
		if !((char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_') {
			return nil
		}
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return nil
	}
	if failure.Hint != "" {
		return fmt.Errorf("%s: %s. %s", failure.Code, failure.Message, failure.Hint)
	}
	return fmt.Errorf("%s: %s", failure.Code, failure.Message)
}

func verifyManagedMarketplaceInstall(stage string, mutation ManagedMarketplaceMutation, result managedMarketplaceInstallResult) error {
	return verifyManagedMarketplaceMutation(stage, stage, mutation, result)
}

func verifyManagedMarketplaceMutation(active, stage string, mutation ManagedMarketplaceMutation, result managedMarketplaceInstallResult) error {
	if result.Schema != 1 || result.Operation != mutation.Operation {
		return fmt.Errorf("Marketplace helper result does not match the requested operation")
	}
	requestedSpecs := make(map[string]struct{}, len(mutation.Specs))
	requestedIDs := make(map[string]string, len(mutation.PackageIDs))
	if mutation.Operation == ManagedMarketplaceInstall {
		if len(result.Installed) != len(mutation.Specs) {
			return fmt.Errorf("Marketplace helper result does not prove all requested installs")
		}
		for _, spec := range mutation.Specs {
			requestedSpecs[spec] = struct{}{}
		}
	} else {
		var err error
		requestedIDs, err = managedMarketplaceUpdateTargets(active, mutation)
		if err != nil {
			return err
		}
		if len(result.Installed) != len(requestedIDs) {
			return fmt.Errorf("Marketplace helper result does not prove all requested adapter updates")
		}
	}
	type lockEntry struct {
		Version           string   `json:"version"`
		ResolvedPath      string   `json:"resolvedPath"`
		Integrity         string   `json:"integrity"`
		Source            string   `json:"source"`
		Package           string   `json:"package"`
		PrimaryKind       string   `json:"primaryKind"`
		Provides          []string `json:"provides"`
		Enabled           *bool    `json:"enabled"`
		MarketplaceSource string   `json:"marketplaceSource"`
		SignatureStatus   string   `json:"signatureStatus"`
	}
	var lock struct {
		Schema   string               `json:"schema"`
		Plugins  map[string]lockEntry `json:"plugins"`
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
	activeAdapterEnabled := map[string]bool{}
	if mutation.Operation == ManagedMarketplaceUpdate {
		var activeLock struct {
			Adapters map[string]lockEntry `json:"adapters"`
		}
		activeData, readErr := os.ReadFile(filepath.Join(active, ".kb", "marketplace.lock"))
		if readErr != nil || json.Unmarshal(activeData, &activeLock) != nil {
			return fmt.Errorf("active Marketplace adapter lock is invalid for update")
		}
		for id, entry := range activeLock.Adapters {
			if entry.Enabled != nil {
				activeAdapterEnabled[id] = *entry.Enabled
			}
		}
	}
	for _, installed := range result.Installed {
		if (installed.PrimaryKind != "adapter" && installed.PrimaryKind != "plugin") || installed.PackageID == "" || installed.Version == "" || installed.ResolvedVersion != installed.Version {
			return fmt.Errorf("Marketplace helper returned an invalid plugin or adapter install result")
		}
		requestedName, requestedVersion, ok := splitMarketplaceSpec(installed.RequestedSpec)
		if !ok || requestedName != installed.PackageID || (requestedVersion != "" && requestedVersion != installed.Version) {
			return fmt.Errorf("Marketplace helper result does not match requested spec %q", installed.RequestedSpec)
		}
		if mutation.Operation == ManagedMarketplaceInstall {
			if _, requested := requestedSpecs[installed.RequestedSpec]; !requested {
				return fmt.Errorf("Marketplace helper reported an unrequested package spec %q", installed.RequestedSpec)
			}
			delete(requestedSpecs, installed.RequestedSpec)
		} else {
			if installed.PrimaryKind != "adapter" {
				return fmt.Errorf("managed Marketplace update may change adapters only")
			}
			installedVersion, requested := requestedIDs[installed.PackageID]
			if !requested {
				return fmt.Errorf("Marketplace helper reported an unrequested adapter update %q", installed.PackageID)
			}
			comparison, compareErr := semrange.Compare(installed.Version, installedVersion)
			if compareErr != nil || comparison <= 0 {
				return fmt.Errorf("Marketplace adapter update %q did not move forward from %s", installed.PackageID, installedVersion)
			}
			delete(requestedIDs, installed.PackageID)
		}
		if err := install_spec.Validate(installed.PackageID + "@" + installed.Version); err != nil {
			return fmt.Errorf("Marketplace helper returned an invalid installed package identity: %w", err)
		}
		if _, duplicate := seen[installed.PackageID]; duplicate {
			return fmt.Errorf("Marketplace helper returned duplicate package identity %q", installed.PackageID)
		}
		seen[installed.PackageID] = struct{}{}
		entry, ok := lock.Adapters[installed.PackageID]
		if installed.PrimaryKind == "plugin" {
			entry, ok = lock.Plugins[installed.PackageID]
		}
		if !ok || entry.Version != installed.Version || entry.ResolvedPath == "" || entry.Integrity == "" || filepath.IsAbs(entry.ResolvedPath) || entry.Source != "marketplace" || entry.Enabled == nil || (mutation.Operation == ManagedMarketplaceInstall && !*entry.Enabled) || (mutation.Operation == ManagedMarketplaceUpdate && activeAdapterEnabled[installed.PackageID] != *entry.Enabled) || (entry.MarketplaceSource != "npm" && entry.MarketplaceSource != "registry") || (mutation.Operation == ManagedMarketplaceUpdate && entry.MarketplaceSource != "npm") || (entry.SignatureStatus != "verified" && entry.SignatureStatus != "unsigned") {
			return fmt.Errorf("staged Marketplace lock does not contain the reported package %q", installed.PackageID)
		}
		if installed.PrimaryKind == "plugin" && (entry.Package != installed.PackageID || entry.PrimaryKind != "plugin") {
			return fmt.Errorf("staged Marketplace plugin lock entry does not match %q", installed.PackageID)
		}
		relativePath := filepath.FromSlash(entry.ResolvedPath)
		if !filepath.IsLocal(relativePath) || relativePath == "." {
			return fmt.Errorf("staged Marketplace package path for %q is not install-owned", installed.PackageID)
		}
		packagePath := filepath.Join(stage, relativePath)
		resolvedPackage, err := filepath.EvalSymlinks(packagePath)
		if err != nil {
			return fmt.Errorf("resolve staged package %q: %w", installed.PackageID, err)
		}
		resolvedStage, err := filepath.EvalSymlinks(stage)
		if err != nil {
			return err
		}
		inside, err := contracts.PathWithin(resolvedStage, resolvedPackage)
		if err != nil || !inside || filepath.Clean(resolvedPackage) == filepath.Clean(resolvedStage) {
			return fmt.Errorf("staged package %q resolves outside its candidate generation", installed.PackageID)
		}
		packageManifest, err := os.ReadFile(filepath.Join(resolvedPackage, "package.json"))
		if err != nil {
			return fmt.Errorf("read installed package manifest %q: %w", installed.PackageID, err)
		}
		var actual struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			KB      struct {
				Manifest string `json:"manifest"`
				Adapter  struct {
					Manifest string `json:"manifest"`
				} `json:"adapter"`
			} `json:"kb"`
		}
		if err := json.Unmarshal(packageManifest, &actual); err != nil || actual.Name != installed.PackageID || actual.Version != installed.Version {
			return fmt.Errorf("installed package manifest does not match adapter %q at version %s", installed.PackageID, installed.Version)
		}
		manifest := actual.KB.Adapter.Manifest
		if installed.PrimaryKind == "plugin" {
			manifest = actual.KB.Manifest
		}
		if manifest == "" || !filepath.IsLocal(filepath.FromSlash(manifest)) {
			return fmt.Errorf("installed package %q does not declare a contained manifest path", installed.PackageID)
		}
		manifestPath := filepath.Join(resolvedPackage, filepath.FromSlash(manifest))
		resolvedManifest, err := filepath.EvalSymlinks(manifestPath)
		if err != nil {
			return fmt.Errorf("resolve installed package manifest %q: %w", installed.PackageID, err)
		}
		manifestInside, err := contracts.PathWithin(resolvedPackage, resolvedManifest)
		if err != nil || !manifestInside {
			return fmt.Errorf("installed adapter manifest %q escapes its package", installed.PackageID)
		}
		manifestInfo, err := os.Stat(resolvedManifest)
		if err != nil || !manifestInfo.Mode().IsRegular() {
			return fmt.Errorf("installed adapter manifest %q is not a regular file", installed.PackageID)
		}
	}
	if len(requestedSpecs) != 0 {
		return fmt.Errorf("Marketplace helper omitted requested package spec %q", firstMarketplaceSpec(requestedSpecs))
	}
	if len(requestedIDs) != 0 {
		return fmt.Errorf("Marketplace helper omitted requested adapter update %q", firstMarketplaceUpdateTarget(requestedIDs))
	}
	return nil
}

func managedMarketplaceUpdateTargets(active string, mutation ManagedMarketplaceMutation) (map[string]string, error) {
	type lockEntry struct {
		Source            string `json:"source"`
		Version           string `json:"version"`
		MarketplaceSource string `json:"marketplaceSource"`
	}
	var lock struct {
		Schema   string               `json:"schema"`
		Plugins  map[string]lockEntry `json:"plugins"`
		Adapters map[string]lockEntry `json:"adapters"`
	}
	data, err := os.ReadFile(filepath.Join(active, ".kb", "marketplace.lock"))
	if err != nil {
		return nil, fmt.Errorf("read active Marketplace lock for adapter update: %w", err)
	}
	if err := json.Unmarshal(data, &lock); err != nil || lock.Schema != "kb.marketplace/3" {
		return nil, fmt.Errorf("active Marketplace lock is invalid for adapter update")
	}
	requested := make(map[string]string)
	if mutation.PackageIDs == nil {
		for id, entry := range lock.Adapters {
			if entry.Source == "marketplace" && entry.Version != "" {
				if entry.MarketplaceSource != "npm" {
					continue
				}
				if _, plugin := lock.Plugins[id]; plugin {
					return nil, fmt.Errorf("managed Marketplace update accepts installed Marketplace adapters only")
				}
				if _, err := semrange.ParseVersion(entry.Version); err != nil {
					return nil, fmt.Errorf("managed Marketplace adapter %q has an invalid installed version pin", id)
				}
				requested[id] = entry.Version
			}
		}
	} else {
		for _, id := range mutation.PackageIDs {
			entry, exists := lock.Adapters[id]
			if !exists || entry.Source != "marketplace" {
				return nil, fmt.Errorf("managed Marketplace update accepts installed Marketplace adapters only")
			}
			if entry.MarketplaceSource != "npm" {
				return nil, fmt.Errorf("managed Marketplace adapter update currently supports npm-backed adapters only; %q uses %q", id, entry.MarketplaceSource)
			}
			if _, plugin := lock.Plugins[id]; plugin {
				return nil, fmt.Errorf("managed Marketplace update accepts installed Marketplace adapters only")
			}
			if entry.Version == "" {
				return nil, fmt.Errorf("managed Marketplace adapter %q has no installed version pin", id)
			}
			if _, err := semrange.ParseVersion(entry.Version); err != nil {
				return nil, fmt.Errorf("managed Marketplace adapter %q has an invalid installed version pin", id)
			}
			requested[id] = entry.Version
		}
	}
	if len(requested) == 0 {
		return nil, fmt.Errorf("no installed Marketplace platform adapters are available to update")
	}
	return requested, nil
}

func splitMarketplaceSpec(spec string) (name, version string, ok bool) {
	if err := install_spec.Validate(spec); err != nil {
		return "", "", false
	}
	lastAt := strings.LastIndex(spec, "@")
	if lastAt > 0 && lastAt > strings.LastIndex(spec, "/") {
		return spec[:lastAt], spec[lastAt+1:], true
	}
	return spec, "", true
}

func verifyManagedMarketplaceCoreGraph(active, candidate string, mutation ManagedMarketplaceMutation, result managedMarketplaceInstallResult) error {
	type packageManifest struct {
		Name            string            `json:"name"`
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	readPackage := func(root string) (packageManifest, error) {
		data, err := os.ReadFile(filepath.Join(root, "package.json"))
		if err != nil {
			return packageManifest{}, err
		}
		var manifest packageManifest
		if err := json.Unmarshal(data, &manifest); err != nil {
			return packageManifest{}, err
		}
		if manifest.Dependencies == nil {
			manifest.Dependencies = map[string]string{}
		}
		if manifest.DevDependencies == nil {
			manifest.DevDependencies = map[string]string{}
		}
		return manifest, nil
	}
	activePackage, err := readPackage(active)
	if err != nil {
		return fmt.Errorf("read active platform package graph: %w", err)
	}
	candidatePackage, err := readPackage(candidate)
	if err != nil {
		return fmt.Errorf("read candidate platform package graph: %w", err)
	}
	if activePackage.Name == "" || activePackage.Name != candidatePackage.Name {
		return fmt.Errorf("candidate package graph changed the platform package identity")
	}
	requestedSources := map[string]string{}
	requestedVersions := map[string]string{}
	for _, installed := range result.Installed {
		entry, err := readManagedMarketplaceLockEntry(candidate, installed.PackageID, installed.PrimaryKind)
		if err != nil {
			return err
		}
		requestedSources[installed.PackageID] = entry.MarketplaceSource
		requestedVersions[installed.PackageID] = installed.Version
	}
	for name, version := range activePackage.Dependencies {
		if candidatePackage.Dependencies[name] != version {
			if requestedSources[name] != "npm" {
				return fmt.Errorf("candidate package graph changed existing dependency %q", name)
			}
		}
	}
	for name, version := range activePackage.DevDependencies {
		if candidatePackage.DevDependencies[name] != version {
			if requestedSources[name] != "npm" {
				return fmt.Errorf("candidate package graph changed existing dev dependency %q", name)
			}
		}
	}
	for name, source := range requestedSources {
		dependencySpecifier := candidatePackage.Dependencies[name]
		if dependencySpecifier == "" {
			dependencySpecifier = candidatePackage.DevDependencies[name]
		}
		if source == "npm" {
			if dependencySpecifier == "" {
				return fmt.Errorf("candidate package graph does not include npm adapter %q", name)
			}
			if !specifierContainsVersion(dependencySpecifier, requestedVersions[name]) {
				return fmt.Errorf("candidate package graph does not resolve requested adapter %q to %s", name, requestedVersions[name])
			}
		}
	}

	type lockDependency struct {
		Specifier string `yaml:"specifier"`
		Version   string `yaml:"version"`
	}
	type lockImporter struct {
		Dependencies    map[string]lockDependency `yaml:"dependencies"`
		DevDependencies map[string]lockDependency `yaml:"devDependencies"`
	}
	var lock struct {
		LockfileVersion string                             `yaml:"lockfileVersion"`
		Importers       map[string]lockImporter            `yaml:"importers"`
		Packages        map[string]any                     `yaml:"packages"`
		Snapshots       map[string]managedPnpmLockSnapshot `yaml:"snapshots"`
	}
	lockData, err := os.ReadFile(filepath.Join(candidate, "pnpm-lock.yaml"))
	if err != nil {
		return fmt.Errorf("read candidate package-manager lock: %w", err)
	}
	if err := yaml.Unmarshal(lockData, &lock); err != nil || lock.LockfileVersion == "" || lock.Packages == nil || lock.Snapshots == nil {
		return fmt.Errorf("candidate package-manager lock is invalid")
	}
	importer, ok := lock.Importers["."]
	if !ok {
		return fmt.Errorf("candidate package-manager lock has no platform importer")
	}
	for name, specifier := range candidatePackage.Dependencies {
		dependency := importer.Dependencies[name]
		if dependency.Specifier != specifier || !managedLockVersionMatches(candidate, name, specifier, dependency.Version) || !managedLockEntriesExist(lock.Packages, lock.Snapshots, name, dependency.Version) {
			return fmt.Errorf("candidate package-manager lock does not match dependency %q", name)
		}
	}
	for name, specifier := range candidatePackage.DevDependencies {
		dependency := importer.DevDependencies[name]
		if dependency.Specifier != specifier || !managedLockVersionMatches(candidate, name, specifier, dependency.Version) || !managedLockEntriesExist(lock.Packages, lock.Snapshots, name, dependency.Version) {
			return fmt.Errorf("candidate package-manager lock does not match dev dependency %q", name)
		}
	}
	// Verify the complete frozen-install resolution graph: every package
	// snapshot must have package metadata, and every locked transitive edge must
	// resolve to both a package record and a peer-aware snapshot.
	for key, snapshot := range lock.Snapshots {
		packageKey := strings.SplitN(key, "(", 2)[0]
		if !lockPackageExists(lock.Packages, packageKey) {
			return fmt.Errorf("candidate package-manager lock snapshot %q has no package record", key)
		}
		for name, version := range snapshot.Dependencies {
			if !managedLockEntriesExist(lock.Packages, lock.Snapshots, name, version) {
				return fmt.Errorf("candidate package-manager lock snapshot %q has unresolved dependency %q", key, name)
			}
		}
		for name, version := range snapshot.OptionalDependencies {
			if !managedLockEntriesExist(lock.Packages, lock.Snapshots, name, version) {
				return fmt.Errorf("candidate package-manager lock snapshot %q has unresolved optional dependency %q", key, name)
			}
		}
	}
	if err := validateManagedPnpmModules(candidate); err != nil {
		return err
	}

	for _, name := range []string{"@kb-labs/cli-bin", "@kb-labs/host-app"} {
		for _, root := range []string{active, candidate} {
			if err := validateManagedExecutableProjection(root, name); err != nil {
				return err
			}
		}
	}
	return nil
}

func lockPackageExists(packages map[string]any, key string) bool {
	for _, candidate := range []string{key, "/" + key} {
		record, ok := packages[candidate].(map[string]any)
		if !ok || record == nil {
			continue
		}
		resolution, ok := record["resolution"].(map[string]any)
		if !ok || resolution == nil {
			continue
		}
		for _, field := range []string{"integrity", "tarball", "repo", "directory"} {
			if value, ok := resolution[field].(string); ok && value != "" {
				return true
			}
		}
	}
	return false
}

func managedLockEntriesExist(packages map[string]any, snapshots map[string]managedPnpmLockSnapshot, packageID, lockVersion string) bool {
	if lockVersion == "" || strings.HasPrefix(lockVersion, "link:") {
		return false
	}
	resolvedName, resolvedVersion, ok := managedPnpmResolvedIdentity(packageID, lockVersion)
	if !ok {
		return false
	}
	packageKey := resolvedName + "@" + resolvedVersion
	peerSuffix := strings.TrimPrefix(lockVersion, strings.SplitN(lockVersion, "(", 2)[0])
	snapshotKey := resolvedName + "@" + resolvedVersion + peerSuffix
	snapshotKeys := []string{snapshotKey, "/" + snapshotKey}
	if !strings.Contains(lockVersion, "(") && snapshotKey == packageKey {
		snapshotKeys = append(snapshotKeys, packageKey, "/"+packageKey)
	}
	for _, candidate := range []string{packageKey, "/" + packageKey} {
		if !lockPackageExists(packages, candidate) {
			continue
		}
		for _, snapshotCandidate := range snapshotKeys {
			if _, snapshotOK := snapshots[snapshotCandidate]; snapshotOK {
				return true
			}
		}
	}
	return false
}

func managedLockVersionMatches(root, packageID, specifier, lockVersion string) bool {
	if lockVersion == "" {
		return false
	}
	expectedName, versionRange := packageID, specifier
	if strings.HasPrefix(specifier, "npm:") {
		aliasName, aliasRange, ok := parseManagedNPMAlias(strings.TrimPrefix(specifier, "npm:"))
		if !ok {
			return false
		}
		expectedName, versionRange = aliasName, aliasRange
	}
	resolvedName, resolvedVersion, ok := managedPnpmResolvedIdentity(packageID, lockVersion)
	if !ok || resolvedName != expectedName {
		return false
	}
	manifest, err := os.ReadFile(filepath.Join(root, "node_modules", filepath.FromSlash(packageID), "package.json"))
	if err != nil {
		return false
	}
	var pkg struct{ Name, Version string }
	if json.Unmarshal(manifest, &pkg) != nil || pkg.Name != expectedName || pkg.Version == "" {
		return false
	}
	return resolvedVersion == pkg.Version && specifierContainsVersion(versionRange, pkg.Version)
}

func parseManagedNPMAlias(specifier string) (string, string, bool) {
	separator := strings.LastIndex(specifier, "@")
	if separator <= strings.LastIndex(specifier, "/") {
		return "", "", false
	}
	name, versionRange := specifier[:separator], specifier[separator+1:]
	_, rangeErr := semrange.ParseRange(versionRange)
	if name == "" || versionRange == "" || install_spec.Validate(name) != nil || rangeErr != nil {
		return "", "", false
	}
	return name, versionRange, true
}

func managedPnpmResolvedIdentity(requestedPackage, lockVersion string) (string, string, bool) {
	base := strings.SplitN(lockVersion, "(", 2)[0]
	if strings.HasPrefix(base, "link:") || base == "" {
		return "", "", false
	}
	separator := strings.LastIndex(base, "@")
	if separator > strings.LastIndex(base, "/") {
		name, version := base[:separator], base[separator+1:]
		return name, version, name != "" && version != ""
	}
	if strings.Contains(base, "@") {
		return "", "", false
	}
	return requestedPackage, base, true
}

type managedMarketplaceLockEntry struct {
	MarketplaceSource string `json:"marketplaceSource"`
}

func readManagedMarketplaceLockEntry(root, packageID, primaryKind string) (managedMarketplaceLockEntry, error) {
	data, err := os.ReadFile(filepath.Join(root, ".kb", "marketplace.lock"))
	if err != nil {
		return managedMarketplaceLockEntry{}, fmt.Errorf("read staged Marketplace lock: %w", err)
	}
	var lock struct {
		Plugins  map[string]managedMarketplaceLockEntry `json:"plugins"`
		Adapters map[string]managedMarketplaceLockEntry `json:"adapters"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return managedMarketplaceLockEntry{}, fmt.Errorf("parse staged Marketplace lock: %w", err)
	}
	entry, ok := lock.Adapters[packageID]
	if primaryKind == "plugin" {
		entry, ok = lock.Plugins[packageID]
	}
	if !ok || (entry.MarketplaceSource != "npm" && entry.MarketplaceSource != "registry") {
		return managedMarketplaceLockEntry{}, fmt.Errorf("staged Marketplace lock has no supported source for package %q", packageID)
	}
	return entry, nil
}

func specifierContainsVersion(specifier, resolvedVersion string) bool {
	version, err := semrange.ParseVersion(resolvedVersion)
	if err != nil {
		return false
	}
	rangeValue, err := semrange.ParseRange(specifier)
	return err == nil && rangeValue.Satisfies(version)
}

func validateManagedPnpmModules(root string) error {
	modulesPath := filepath.Join(root, "node_modules", ".modules.yaml")
	info, err := os.Lstat(modulesPath)
	if err != nil {
		return fmt.Errorf("candidate package-manager modules metadata is missing: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() == 0 || info.Size() > 4*1024*1024 {
		return fmt.Errorf("candidate package-manager modules metadata is not a bounded regular file")
	}
	data, err := os.ReadFile(modulesPath)
	if err != nil {
		return err
	}
	var metadata map[string]any
	if err := yaml.Unmarshal(data, &metadata); err != nil {
		return fmt.Errorf("candidate package-manager modules metadata is invalid: %w", err)
	}
	if metadata["layoutVersion"] == nil || metadata["storeDir"] == nil || metadata["virtualStoreDir"] == nil {
		return fmt.Errorf("candidate package-manager modules metadata omits required layout fields")
	}
	virtualStore, ok := metadata["virtualStoreDir"].(string)
	if !ok || virtualStore == "" {
		return fmt.Errorf("candidate package-manager virtual store path is invalid")
	}
	nodeModules := filepath.Join(root, "node_modules")
	virtualPath := virtualStore
	if !filepath.IsAbs(virtualPath) {
		virtualPath = filepath.Join(nodeModules, virtualPath)
	}
	virtualPath, err = filepath.EvalSymlinks(virtualPath)
	if err != nil {
		return fmt.Errorf("resolve candidate package-manager virtual store: %w", err)
	}
	inside, err := contracts.PathWithin(nodeModules, virtualPath)
	if err != nil || !inside {
		return fmt.Errorf("candidate package-manager virtual store escapes node_modules")
	}
	if info, err := os.Stat(virtualPath); err != nil || !info.IsDir() {
		return fmt.Errorf("candidate package-manager virtual store is unavailable")
	}
	return nil
}

func validateManagedExecutableProjection(root, packageID string) error {
	commandName := map[string]string{"@kb-labs/cli-bin": "kb", "@kb-labs/host-app": "kb-host"}[packageID]
	manifestPath := filepath.Join(root, "node_modules", filepath.FromSlash(packageID), "package.json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("generation executable package %q is unavailable: %w", packageID, err)
	}
	var executable struct {
		Name    string            `json:"name"`
		Version string            `json:"version"`
		Bin     map[string]string `json:"bin"`
	}
	if err := json.Unmarshal(manifestData, &executable); err != nil || executable.Name != packageID || executable.Version == "" {
		return fmt.Errorf("generation executable package %q is invalid", packageID)
	}
	binPath, ok := executable.Bin[commandName]
	if !ok || !filepath.IsLocal(filepath.FromSlash(binPath)) {
		return fmt.Errorf("generation executable package %q does not declare %s", packageID, commandName)
	}
	packageRoot := filepath.Join(root, "node_modules", filepath.FromSlash(packageID))
	resolvedPackage, err := filepath.EvalSymlinks(packageRoot)
	if err != nil {
		return fmt.Errorf("resolve generation executable package %q: %w", packageID, err)
	}
	resolvedEntry, err := filepath.EvalSymlinks(filepath.Join(packageRoot, filepath.FromSlash(binPath)))
	if err != nil {
		return fmt.Errorf("resolve generation executable %s: %w", commandName, err)
	}
	inside, err := contracts.PathWithin(root, resolvedPackage)
	if err != nil || !inside {
		return fmt.Errorf("generation executable package %q escapes its root", packageID)
	}
	inside, err = contracts.PathWithin(resolvedPackage, resolvedEntry)
	if err != nil || !inside {
		return fmt.Errorf("generation executable %s escapes its package", commandName)
	}
	projection := filepath.Join(root, "node_modules", ".bin", commandName)
	info, err := os.Lstat(projection)
	if err != nil {
		return fmt.Errorf("generation executable projection %s is missing: %w", commandName, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		resolvedProjection, err := filepath.EvalSymlinks(projection)
		if err != nil || filepath.Clean(resolvedProjection) != filepath.Clean(resolvedEntry) {
			return fmt.Errorf("generation executable projection %s does not target its declared package binary", commandName)
		}
	} else {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 || info.Size() == 0 || info.Size() > 1024*1024 {
			return fmt.Errorf("generation executable projection %s is not a bounded executable file", commandName)
		}
		data, err := os.ReadFile(projection)
		if err != nil {
			return err
		}
		const marker = "cmd-shim-target="
		markerIndex := bytes.Index(data, []byte(marker))
		if markerIndex < 0 {
			return fmt.Errorf("generation executable shim %s omits its package target", commandName)
		}
		lineEnd := bytes.IndexByte(data[markerIndex:], '\n')
		if lineEnd < 0 {
			lineEnd = len(data) - markerIndex
		}
		target := strings.TrimSpace(string(data[markerIndex+len(marker) : markerIndex+lineEnd]))
		if target == "" {
			return fmt.Errorf("generation executable shim %s has an empty package target", commandName)
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(projection), target)
		}
		resolvedTarget, err := filepath.EvalSymlinks(target)
		if err != nil || filepath.Clean(resolvedTarget) != filepath.Clean(resolvedEntry) {
			return fmt.Errorf("generation executable shim %s does not target its declared package binary", commandName)
		}
	}
	// Inspect regular shims without executing them: they are candidate files and
	// may contain shell commands. kb-host has no safe version/help mode.
	if info.Mode().IsRegular() {
		if err := validateManagedExecutableShim(projection, resolvedEntry); err != nil {
			return fmt.Errorf("generation executable projection %s has an invalid launcher: %w", commandName, err)
		}
	}
	return nil
}

func validateManagedExecutableShim(projection, resolvedEntry string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	data, err := os.ReadFile(projection)
	if err != nil {
		return err
	}
	if bytes.Count(data, []byte("exec node ")) != 1 {
		return fmt.Errorf("launcher is outside the safe Node shim shape")
	}
	if !bytes.HasPrefix(data, []byte("#!/bin/sh\n")) && !bytes.HasPrefix(data, []byte("#!/usr/bin/env sh\n")) {
		return fmt.Errorf("launcher is not a supported POSIX shell shim")
	}
	// sh -n parses syntax without executing commands, substitutions, or user code.
	syntax := exec.Command("/bin/sh", "-n", projection)
	if output, err := syntax.CombinedOutput(); err != nil {
		return fmt.Errorf("launcher shell syntax is invalid: %s", strings.TrimSpace(string(output)))
	}
	var targets []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			continue
		}
		if index := strings.Index(line, "exec node "); index >= 0 {
			parts := strings.Fields(line[index+len("exec node "):])
			if len(parts) == 0 {
				return fmt.Errorf("launcher node invocation has no entrypoint")
			}
			targets = append(targets, strings.Trim(parts[0], "\\\"'"))
		}
	}
	if len(targets) != 1 {
		return fmt.Errorf("launcher does not have one inspectable Node entrypoint")
	}
	target := strings.ReplaceAll(targets[0], "${basedir}", filepath.Dir(projection))
	target = strings.ReplaceAll(target, "$basedir", filepath.Dir(projection))
	if strings.Contains(target, "$") {
		return fmt.Errorf("launcher entrypoint uses unsupported shell expansion")
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(projection), target)
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(resolvedEntry) {
		return fmt.Errorf("launcher command does not invoke its declared package binary")
	}
	return nil
}

func firstMarketplaceSpec(specs map[string]struct{}) string {
	ordered := make([]string, 0, len(specs))
	for spec := range specs {
		ordered = append(ordered, spec)
	}
	sort.Strings(ordered)
	if len(ordered) == 0 {
		return ""
	}
	return ordered[0]
}

func firstMarketplaceUpdateTarget(targets map[string]string) string {
	for target := range targets {
		return target
	}
	return ""
}

func managedMarketplaceInstallIsNoop(active, stage string, mutation ManagedMarketplaceMutation, result managedMarketplaceInstallResult) (bool, error) {
	// A byte-identical generation is only a no-op if the installed active
	// package itself is still valid. Otherwise this candidate may be repairing
	// a damaged package and must be activated even when metadata is unchanged.
	if err := verifyManagedMarketplaceInstall(active, mutation, result); err != nil {
		return false, nil
	}
	if err := verifyManagedMarketplaceMutation(active, stage, mutation, result); err != nil {
		return false, nil
	}
	for _, relative := range []string{"package.json", "pnpm-lock.yaml", "node_modules/.modules.yaml", ".kb/marketplace.lock"} {
		activeBytes, activeErr := os.ReadFile(filepath.Join(active, relative))
		stageBytes, stageErr := os.ReadFile(filepath.Join(stage, relative))
		if os.IsNotExist(activeErr) && os.IsNotExist(stageErr) {
			continue
		}
		if activeErr != nil || stageErr != nil {
			return false, errors.Join(activeErr, stageErr)
		}
		if !bytes.Equal(activeBytes, stageBytes) {
			return false, nil
		}
	}
	activeEntries, err := managedMarketplaceAPIEntries(active, result)
	if err != nil {
		return false, nil
	}
	stageEntries, err := managedMarketplaceAPIEntries(stage, result)
	if err != nil || len(activeEntries) != len(stageEntries) {
		return false, nil
	}
	for index := range activeEntries {
		activePackage := filepath.Join(active, activeEntries[index].PackageRoot)
		stagePackage := filepath.Join(stage, stageEntries[index].PackageRoot)
		equal, compareErr := managedMarketplacePackageTreesEqual(activePackage, stagePackage)
		if compareErr != nil {
			return false, compareErr
		}
		if !equal {
			return false, nil
		}
	}
	return true, nil
}

func managedMarketplacePackageTreesEqual(left, right string) (bool, error) {
	resolvedLeft, err := filepath.EvalSymlinks(left)
	if err != nil {
		return false, err
	}
	resolvedRight, err := filepath.EvalSymlinks(right)
	if err != nil {
		return false, err
	}
	left, right = resolvedLeft, resolvedRight
	entries := func(root string) (map[string]string, error) {
		result := map[string]string{}
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if path == root {
				return nil
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			value := fmt.Sprintf("%s:%o", info.Mode().Type(), info.Mode().Perm())
			if info.Mode()&os.ModeSymlink != 0 {
				target, err := os.Readlink(path)
				if err != nil {
					return err
				}
				value += ":" + target
			} else if info.Mode().IsRegular() {
				file, err := os.Open(path)
				if err != nil {
					return err
				}
				digest := sha256.New()
				if _, err := io.Copy(digest, file); err != nil {
					_ = file.Close()
					return err
				}
				if err := file.Close(); err != nil {
					return err
				}
				value += ":" + hex.EncodeToString(digest.Sum(nil))
			}
			result[relative] = value
			return nil
		})
		return result, err
	}
	leftEntries, err := entries(left)
	if err != nil {
		return false, err
	}
	rightEntries, err := entries(right)
	if err != nil {
		return false, err
	}
	if len(leftEntries) != len(rightEntries) {
		return false, nil
	}
	for path, value := range leftEntries {
		if rightEntries[path] != value {
			return false, nil
		}
	}
	return true, nil
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func ensureManagedDirectory(root, target string) error {
	return ensureRealDirectoryPath(root, target, true)
}

func ensureManagedCandidateDirectory(stage, target string) error {
	return ensureRealDirectoryPath(stage, target, true)
}

func ensureRealDirectoryPath(root, target string, create bool) error {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed directory root is not a real directory")
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	if filepath.Clean(rootReal) != filepath.Clean(root) {
		return fmt.Errorf("managed directory root is not canonical")
	}
	relative, err := filepath.Rel(rootReal, target)
	if err != nil || !filepath.IsLocal(relative) {
		return fmt.Errorf("managed directory target escapes its owned root")
	}
	current := rootReal
	if relative == "." {
		return nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) && create {
			if err := os.Mkdir(current, 0o700); err != nil && !os.IsExist(err) {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed path component %s is not a real directory", current)
		}
	}
	return nil
}

func removeManagedCandidateDirectory(stage, target string) error {
	if err := ensureRealDirectoryPath(stage, target, false); err != nil {
		return err
	}
	return os.RemoveAll(target)
}

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

func marketplaceCredentialValues(names, base []string) (map[string]string, error) {
	if len(names) > 32 {
		return nil, fmt.Errorf("Marketplace config references too many environment variables")
	}
	values := make(map[string]string, len(names))
	baseValues := map[string]string{}
	for _, entry := range base {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			baseValues[name] = value
		}
	}
	seen := map[string]struct{}{}
	for _, name := range names {
		if !validMarketplaceCredentialName(name) {
			return nil, fmt.Errorf("Marketplace config references a prohibited environment variable")
		}
		if _, duplicate := seen[name]; duplicate {
			return nil, fmt.Errorf("Marketplace helper returned duplicate credential references")
		}
		seen[name] = struct{}{}
		value, ok := baseValues[name]
		if !ok {
			continue
		}
		if len(value) > 16*1024 {
			return nil, fmt.Errorf("Marketplace credential environment value exceeds the size limit")
		}
		values[name] = value
	}
	return values, nil
}

func validMarketplaceCredentialName(name string) bool {
	if name == "" || strings.ContainsAny(name, "=\x00") || strings.EqualFold(name, "PATH") || strings.EqualFold(name, "HOME") || strings.EqualFold(name, "NODE_OPTIONS") || strings.EqualFold(name, "SHELL") {
		return false
	}
	upper := strings.ToUpper(name)
	if strings.HasPrefix(upper, "NPM_CONFIG_") || strings.HasPrefix(upper, "COREPACK_") || strings.HasPrefix(upper, "PNPM_") {
		return false
	}
	switch upper {
	case "KB_PLATFORM_ROOT", "KB_MARKETPLACE_CONFIG_ROOT", "KB_HOME", "KB_INSTALL_ROOT", "NODE_PATH", "NODE_V8_COVERAGE", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV", "ENV", "IFS", "CDPATH":
		return false
	}
	for index, char := range name {
		if !((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char == '_' || (index > 0 && char >= '0' && char <= '9')) {
			return false
		}
	}
	return true
}

func probeManagedMarketplaceEnvRefs(ctx context.Context, node, helper, stage string, environment []string) (managedMarketplaceEnvRefs, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.Command(node, helper, "--managed-generation-mutation-env-refs")
	command.Dir = stage
	command.Env = environment
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = io.Discard
	if err := child.Run(probeCtx, command, proc.ChildProcessObserver()); err != nil {
		return managedMarketplaceEnvRefs{}, fmt.Errorf("read configured Marketplace credential references: %w", err)
	}
	var result managedMarketplaceEnvRefs
	decoder := json.NewDecoder(&output)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil || result.Schema != 1 || len(result.Environment) > 32 {
		return managedMarketplaceEnvRefs{}, fmt.Errorf("Marketplace credential reference response is invalid")
	}
	return result, nil
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
