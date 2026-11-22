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
	RequestedSpec   string `json:"requestedSpec"`
	PackageID       string `json:"packageId"`
	Version         string `json:"version"`
	ResolvedVersion string `json:"resolvedVersion"`
	PrimaryKind     string `json:"primaryKind"`
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
	if err := verifyManagedMarketplaceCoreGraph(active, stage, mutation, result); err != nil {
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
	noop, noopErr := managedMarketplaceInstallIsNoop(active, stage, mutation, result)
	if noopErr != nil {
		if cleanupErr := l.AbortManagedGeneration(stage); cleanupErr != nil {
			noopErr = errors.Join(noopErr, fmt.Errorf("remove invalid Marketplace stage: %w", cleanupErr))
		}
		return "", noopErr
	}
	if noop {
		if err := l.AbortManagedGeneration(stage); err != nil {
			return "", fmt.Errorf("remove no-op Marketplace candidate: %w", err)
		}
		return active, nil
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
	if result.Schema != 1 || result.Operation != ManagedMarketplaceInstall || len(result.Installed) != len(mutation.Specs) {
		return fmt.Errorf("Marketplace helper result does not prove all requested installs")
	}
	requestedSpecs := make(map[string]struct{}, len(mutation.Specs))
	for _, spec := range mutation.Specs {
		requestedSpecs[spec] = struct{}{}
	}
	type lockEntry struct {
		Version           string `json:"version"`
		ResolvedPath      string `json:"resolvedPath"`
		Integrity         string `json:"integrity"`
		Source            string `json:"source"`
		Enabled           *bool  `json:"enabled"`
		MarketplaceSource string `json:"marketplaceSource"`
		SignatureStatus   string `json:"signatureStatus"`
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
		if installed.PrimaryKind != "adapter" || installed.PackageID == "" || installed.Version == "" || installed.ResolvedVersion != installed.Version {
			return fmt.Errorf("Marketplace helper returned an invalid adapter install result")
		}
		requestedName, requestedVersion, ok := splitMarketplaceSpec(installed.RequestedSpec)
		if !ok || requestedName != installed.PackageID || (requestedVersion != "" && requestedVersion != installed.Version) {
			return fmt.Errorf("Marketplace helper result does not match requested spec %q", installed.RequestedSpec)
		}
		if _, requested := requestedSpecs[installed.RequestedSpec]; !requested {
			return fmt.Errorf("Marketplace helper reported an unrequested package spec %q", installed.RequestedSpec)
		}
		delete(requestedSpecs, installed.RequestedSpec)
		if err := install_spec.Validate(installed.PackageID + "@" + installed.Version); err != nil {
			return fmt.Errorf("Marketplace helper returned an invalid installed package identity: %w", err)
		}
		if _, duplicate := seen[installed.PackageID]; duplicate {
			return fmt.Errorf("Marketplace helper returned duplicate package identity %q", installed.PackageID)
		}
		seen[installed.PackageID] = struct{}{}
		entry, ok := lock.Adapters[installed.PackageID]
		if !ok || entry.Version != installed.Version || entry.ResolvedPath == "" || entry.Integrity == "" || filepath.IsAbs(entry.ResolvedPath) || entry.Source != "marketplace" || entry.Enabled == nil || !*entry.Enabled || (entry.MarketplaceSource != "npm" && entry.MarketplaceSource != "registry") || (entry.SignatureStatus != "verified" && entry.SignatureStatus != "unsigned") {
			return fmt.Errorf("staged Marketplace lock does not contain the reported adapter %q", installed.PackageID)
		}
		relativePath := filepath.FromSlash(entry.ResolvedPath)
		if !filepath.IsLocal(relativePath) || relativePath == "." {
			return fmt.Errorf("staged Marketplace package path for %q is not install-owned", installed.PackageID)
		}
		packagePath := filepath.Join(stage, relativePath)
		resolvedPackage, err := filepath.EvalSymlinks(packagePath)
		if err != nil {
			return fmt.Errorf("resolve staged adapter package %q: %w", installed.PackageID, err)
		}
		resolvedStage, err := filepath.EvalSymlinks(stage)
		if err != nil {
			return err
		}
		inside, err := contracts.PathWithin(resolvedStage, resolvedPackage)
		if err != nil || !inside || filepath.Clean(resolvedPackage) == filepath.Clean(resolvedStage) {
			return fmt.Errorf("staged adapter package %q resolves outside its candidate generation", installed.PackageID)
		}
		packageManifest, err := os.ReadFile(filepath.Join(resolvedPackage, "package.json"))
		if err != nil {
			return fmt.Errorf("read installed adapter package manifest %q: %w", installed.PackageID, err)
		}
		var actual struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			KB      struct {
				Adapter struct {
					Manifest string `json:"manifest"`
				} `json:"adapter"`
			} `json:"kb"`
		}
		if err := json.Unmarshal(packageManifest, &actual); err != nil || actual.Name != installed.PackageID || actual.Version != installed.Version {
			return fmt.Errorf("installed package manifest does not match adapter %q at version %s", installed.PackageID, installed.Version)
		}
		if actual.KB.Adapter.Manifest == "" || !filepath.IsLocal(filepath.FromSlash(actual.KB.Adapter.Manifest)) {
			return fmt.Errorf("installed adapter %q does not declare a contained manifest path", installed.PackageID)
		}
		manifestPath := filepath.Join(resolvedPackage, filepath.FromSlash(actual.KB.Adapter.Manifest))
		resolvedManifest, err := filepath.EvalSymlinks(manifestPath)
		if err != nil {
			return fmt.Errorf("resolve installed adapter manifest %q: %w", installed.PackageID, err)
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
	return nil
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
		entry, err := readManagedMarketplaceLockEntry(candidate, installed.PackageID)
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
		LockfileVersion string                  `yaml:"lockfileVersion"`
		Importers       map[string]lockImporter `yaml:"importers"`
	}
	lockData, err := os.ReadFile(filepath.Join(candidate, "pnpm-lock.yaml"))
	if err != nil {
		return fmt.Errorf("read candidate package-manager lock: %w", err)
	}
	if err := yaml.Unmarshal(lockData, &lock); err != nil || lock.LockfileVersion == "" {
		return fmt.Errorf("candidate package-manager lock is invalid")
	}
	importer, ok := lock.Importers["."]
	if !ok {
		return fmt.Errorf("candidate package-manager lock has no platform importer")
	}
	for name, specifier := range candidatePackage.Dependencies {
		if importer.Dependencies[name].Specifier != specifier || !managedLockVersionMatches(candidate, name, importer.Dependencies[name].Version) {
			return fmt.Errorf("candidate package-manager lock does not match dependency %q", name)
		}
	}
	for name, specifier := range candidatePackage.DevDependencies {
		if importer.DevDependencies[name].Specifier != specifier || !managedLockVersionMatches(candidate, name, importer.DevDependencies[name].Version) {
			return fmt.Errorf("candidate package-manager lock does not match dev dependency %q", name)
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

func managedLockVersionMatches(root, packageID, lockVersion string) bool {
	if lockVersion == "" {
		return false
	}
	// pnpm appends peer dependency context in parentheses. Compare the concrete
	// version against the package physically installed in this generation.
	resolved := strings.SplitN(lockVersion, "(", 2)[0]
	if strings.HasPrefix(resolved, "link:") {
		return false
	}
	manifest, err := os.ReadFile(filepath.Join(root, "node_modules", filepath.FromSlash(packageID), "package.json"))
	if err != nil {
		return false
	}
	var pkg struct{ Name, Version string }
	if json.Unmarshal(manifest, &pkg) != nil || pkg.Name != packageID || pkg.Version == "" {
		return false
	}
	return resolved == pkg.Version
}

type managedMarketplaceLockEntry struct {
	MarketplaceSource string `json:"marketplaceSource"`
}

func readManagedMarketplaceLockEntry(root, packageID string) (managedMarketplaceLockEntry, error) {
	data, err := os.ReadFile(filepath.Join(root, ".kb", "marketplace.lock"))
	if err != nil {
		return managedMarketplaceLockEntry{}, fmt.Errorf("read staged Marketplace lock: %w", err)
	}
	var lock struct {
		Adapters map[string]managedMarketplaceLockEntry `json:"adapters"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return managedMarketplaceLockEntry{}, fmt.Errorf("parse staged Marketplace lock: %w", err)
	}
	entry, ok := lock.Adapters[packageID]
	if !ok || (entry.MarketplaceSource != "npm" && entry.MarketplaceSource != "registry") {
		return managedMarketplaceLockEntry{}, fmt.Errorf("staged Marketplace lock has no supported source for adapter %q", packageID)
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
	// Execute the projection itself. A marker can describe the right target
	// while the launcher is broken or points elsewhere.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, projection, "--version")
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), executable.Version) {
		return fmt.Errorf("generation executable projection %s failed its version probe", commandName)
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

func managedMarketplaceInstallIsNoop(active, stage string, mutation ManagedMarketplaceMutation, result managedMarketplaceInstallResult) (bool, error) {
	if err := verifyManagedMarketplaceInstall(active, mutation, result); err != nil {
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
