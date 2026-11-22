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
	command.Env = managedMarketplaceEnvironment(configRoot, stage, packageManagerRoot, managedBin, isolatedHome, baseEnvironment)
	envRefs, err := probeManagedMarketplaceEnvRefs(ctx, node, helper, stage, command.Env)
	if err != nil {
		return managedMarketplaceInstallResult{}, err
	}
	credentials, err := marketplaceCredentialValues(envRefs.Environment, baseEnvironment)
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
	command.Env = managedMarketplaceEnvironment(configRoot, stage, packageManagerRoot, managedBin, isolatedHome, baseEnvironment)
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
	if err := removeManagedCandidateDirectory(stage, managedBin); err != nil {
		return managedMarketplaceInstallResult{}, errors.Join(writeErr, closeErr, waitErr, fmt.Errorf("remove private package-manager shim: %w", err))
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
	requestedSpecs := make(map[string]struct{}, len(mutation.Specs))
	for _, spec := range mutation.Specs {
		requestedSpecs[spec] = struct{}{}
	}
	type lockEntry struct {
		Version      string `json:"version"`
		ResolvedPath string `json:"resolvedPath"`
		Integrity    string `json:"integrity"`
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
		if !ok || entry.Version != installed.Version || entry.ResolvedPath == "" || entry.Integrity == "" || filepath.IsAbs(entry.ResolvedPath) {
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
		}
		if err := json.Unmarshal(packageManifest, &actual); err != nil || actual.Name != installed.PackageID || actual.Version != installed.Version {
			return fmt.Errorf("installed package manifest does not match adapter %q at version %s", installed.PackageID, installed.Version)
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
