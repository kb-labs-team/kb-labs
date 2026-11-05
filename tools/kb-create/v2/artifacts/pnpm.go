// Package artifacts contains V2's exact-artifact executor. It receives only
// immutable artifact versions from ResolvedInstallPlan; it never resolves npm
// tags, scans node_modules for product decisions, or imports legacy pm code.
package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/semrange"
	"gopkg.in/yaml.v3"
)

type Runner interface {
	Run(context.Context, io.Writer, string, ...string) error
}

type CommandRunner struct {
	environment  []string
	corepackHome string
	registry     string
	offline      bool
}

const externalCommandStderrTailBytes = 4096

type externalCommandFailure struct {
	exitCode   int
	stderrTail string
	cause      error
}

func (f *externalCommandFailure) Error() string { return f.cause.Error() }
func (f *externalCommandFailure) Unwrap() error { return f.cause }

func (r CommandRunner) Run(ctx context.Context, output io.Writer, name string, args ...string) error {
	var env []string
	if len(r.environment) > 0 {
		env = packageManagerEnvironment(os.Environ(), r.environment)
	}
	var executable string
	if name == "pnpm" {
		var node, script string
		var err error
		if r.corepackHome == "" {
			node, script, err = toolchain.PnpmExecutable()
		} else {
			node, script, err = toolchain.PnpmExecutableAt(r.corepackHome)
		}
		if err != nil {
			if r.corepackHome == "" {
				return err
			}
			source := r.registry
			if source == "" {
				source = "Corepack's default npm registry"
			}
			if !r.offline {
				var provision toolchain.Result
				provision, err = toolchain.Run(ctx, toolchain.Invocation{Tool: "corepack", Executable: "corepack", Args: []string{"install", "-g", "pnpm@" + toolchain.SupportedPnpm}, Env: env, Operation: toolchain.OperationPackageManager})
				if provision.Stdout != "" {
					_, _ = io.WriteString(output, provision.Stdout)
				}
				if provision.Stderr != "" {
					_, _ = io.WriteString(output, provision.Stderr)
				}
				if err == nil {
					node, script, err = toolchain.PnpmExecutableAt(r.corepackHome)
				}
			}
			if err != nil {
				return contracts.NewDiag(contracts.CodeApplyFailed, fmt.Sprintf("Could not provision pnpm %s from %s; check --registry.", toolchain.SupportedPnpm, source), "Check --registry and rerun the install command.", err)
			}
		}
		executable = node
		args = append([]string{script}, args...)
	} else {
		executable = name
	}
	result, err := toolchain.Run(ctx, toolchain.Invocation{Tool: name, Executable: executable, Args: args, Env: env, Operation: toolchain.OperationPackageManager})
	if result.Stdout != "" {
		_, _ = io.WriteString(output, result.Stdout)
	}
	if result.Stderr != "" {
		_, _ = io.WriteString(output, result.Stderr)
	}
	if err != nil {
		var commandFailure *toolchain.CommandError
		if errors.As(err, &commandFailure) {
			return &externalCommandFailure{exitCode: commandFailure.ExitCode, stderrTail: commandFailure.StderrTail, cause: err}
		}
		return err
	}
	return nil
}

func tailText(content []byte, limit int) string {
	if len(content) > limit {
		content = content[len(content)-limit:]
	}
	return strings.TrimRight(strings.ToValidUTF8(string(content), "�"), "\r\n")
}

func packageManagerEnvironment(base, overrides []string) []string {
	owned := map[string]struct{}{"pnpm_home": {}}
	for _, entry := range overrides {
		name, _, _ := strings.Cut(entry, "=")
		owned[strings.ToLower(name)] = struct{}{}
	}
	result := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if _, replaced := owned[strings.ToLower(name)]; !replaced {
			result = append(result, entry)
		}
	}
	return append(result, overrides...)
}

type Pnpm struct {
	Root               string
	CacheRoot          string
	PackageManagerRoot string
	Registry           string
	Offline            bool
	Client             *http.Client
	Runner             Runner
	// Log receives the complete package-manager transcript. It is deliberately
	// file-oriented: raw package-manager output must never pollute human or JSON
	// command output.
	Log io.Writer
}

// pnpm refuses to run any dependency's install/postinstall script unless it
// is explicitly allow-listed, and treats even one unapproved script as a
// fatal error rather than a skip — so every package the exact-artifact set
// can pull in with a legitimate build step must be named here, not just the
// one that happens to be exercised by a given install. The standalone
// installed platform has no workspace manifest from which pnpm could inherit
// an existing approval, so this carries the same narrowly-scoped permissions
// the monorepo's own tooling already relies on into the executor invocation:
// better-sqlite3 (native binary, used by the shipped SQLite adapters),
// esbuild and unrs-resolver (native binaries pulled in transitively by
// tsup-based tooling).
//
// This is written into pnpm-workspace.yaml's `allowBuilds` map (the format
// `pnpm approve-builds --all` itself writes) rather than passed as a CLI
// `--allow-build=` flag: pnpm 11.4.0 (pinned in the E2E image and this
// repo's own packageManager field) mis-parses a comma-joined value as a
// single "name@version-union" spec — and therefore fails with pnpm's invalid
// version-union error — the moment the list has more than one
// entry and includes a scoped package (contains "@"). Confirmed directly
// against pnpm 11.4.0:
// the CLI flag breaks on this exact list (comma-joined or repeated), while
// this config file's `allowBuilds` map handles it cleanly.
var approvedNativeBuilds = []string{"better-sqlite3", "esbuild", "unrs-resolver"}

func (p Pnpm) Install(items []contracts.Artifact) error {
	verified, err := p.verifyTarballs(items)
	if err != nil {
		return err
	}
	return p.installVerified(items, verified)
}

func (p Pnpm) installVerified(items []contracts.Artifact, verified map[string][]byte) error {
	for _, item := range items {
		data, ok := verified[item.ID]
		if !ok {
			continue
		}
		path := filepath.Join(p.CacheRoot, "packages", item.SHA256+".tgz")
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return err
		}
	}
	if err := p.prepare(); err != nil {
		return err
	}
	if err := p.mergeMinimumReleaseAgeExclude(items); err != nil {
		return err
	}
	specs, err := p.specs(items)
	if err != nil {
		return err
	}
	if err := p.mergeSealedArtifactOverrides(items); err != nil {
		return err
	}
	if len(specs) == 0 {
		if err := p.materializeManifests(items); err != nil {
			return err
		}
		return p.verifyAndRecord(items)
	}
	if err := p.run("add", specs...); err != nil {
		return err
	}
	if err := p.materializeManifests(items); err != nil {
		return err
	}
	return p.verifyAndRecord(items)
}

func (p Pnpm) verifyTarballs(items []contracts.Artifact) (map[string][]byte, error) {
	verified := make(map[string][]byte)
	for _, item := range items {
		if item.IsBinary() || item.Tarball == "" {
			continue
		}
		if item.SHA256 == "" {
			return nil, fmt.Errorf("artifact %q tarball requires sha256", item.ID)
		}
		if p.CacheRoot == "" {
			return nil, fmt.Errorf("artifact %q tarball requires the install root shared cache", item.ID)
		}
		path := filepath.Join(p.CacheRoot, "packages", item.SHA256+".tgz")
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			if p.Offline {
				return nil, fmt.Errorf("offline package %s is absent from V2 cache", item.ID)
			}
			target := item.ResolvedURL
			if target == "" {
				return nil, fmt.Errorf("artifact %s lacks a resolved download URL", item.ID)
			}
			data, err = fetchArtifact(p.Client, item, target)
			if err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(data)); actual != item.SHA256 {
			if p.Offline {
				return nil, fmt.Errorf("package %s checksum mismatch in offline cache: expected %s, got %s", item.ID, item.SHA256, actual)
			}
			return nil, downloadFailure(item, item.ResolvedURL, fmt.Errorf("checksum mismatch: expected %s, got %s", item.SHA256, actual))
		}
		verified[item.ID] = data
	}
	return verified, nil
}

func (p Pnpm) materializeManifests(items []contracts.Artifact) error {
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		if err := installed.Write(p.Root, item); err != nil {
			return err
		}
	}
	return nil
}
func (p Pnpm) Restore(items []contracts.Artifact) error {
	if err := p.prepare(); err != nil {
		return err
	}
	if err := p.mergeMinimumReleaseAgeExclude(items); err != nil {
		return err
	}
	if err := p.mergeSealedArtifactOverrides(items); err != nil {
		return err
	}
	if err := p.run("install"); err != nil {
		return err
	}
	if err := p.materializeManifests(items); err != nil {
		return err
	}
	return p.verifyAndRecord(items)
}

func (p Pnpm) verifyAndRecord(items []contracts.Artifact) error {
	verified, err := VerifyInstalledProvenance(p.Root, items)
	if err != nil {
		return err
	}
	return p.accept(verified)
}

func (p Pnpm) accept(verified VerifiedArtifactSet) error {
	if len(verified.Manifest().Packages) > 0 {
		return WriteInstalledProvenance(p.Root, verified.Manifest())
	}
	return nil
}
func (p Pnpm) Uninstall(items []contracts.Artifact) error {
	if err := p.prepare(); err != nil {
		return err
	}
	packages, err := packageNames(items)
	if err != nil {
		return err
	}
	if len(packages) == 0 {
		return nil
	}
	// Removing a package must use its manifest key, not its immutable tarball
	// spec. `specs` intentionally skips an already-installed artifact for the
	// idempotent install path; reusing it here previously made uninstall a
	// successful no-op for every installed package.
	return p.run("remove", packages...)
}

func (p Pnpm) run(command string, specs ...string) error {
	if p.Root == "" {
		return fmt.Errorf("V2 platform root is required")
	}
	args := []string{command, "--dir", p.Root, "--reporter=append-only"}
	if p.Offline {
		args = append(args, "--offline")
	}
	// remove works exclusively on the already-installed lockfile. Rechecking
	// minimum release age here rejects freshly published canary entries even
	// though no package is being fetched, which prevents an otherwise safe
	// uninstall. Keep the policy intact for install/restore; bypass it only
	// for this local cleanup operation.
	if command == "remove" {
		args = append(args, "--config.minimumReleaseAge=0")
	}
	// pnpm rejects --registry for remove, but pruning a dependency graph can
	// still need package metadata from the registry that supplied the install.
	// Keep that registry in config form so private release candidates can be
	// uninstalled without falling back to the public npm registry.
	if p.Registry != "" && command == "remove" {
		args = append(args, "--config.registry="+p.Registry)
	}
	args = append(args, specs...)
	if p.Registry != "" && command != "remove" {
		args = append(args, "--registry", p.Registry)
	}
	runner := p.Runner
	if runner == nil {
		if p.PackageManagerRoot == "" {
			return fmt.Errorf("pnpm package-manager state root is required")
		}
		runner = CommandRunner{environment: p.packageManagerEnvironment(), corepackHome: p.corepackHome(), registry: p.Registry, offline: p.Offline}
	}
	log := p.Log
	if log == nil {
		log = io.Discard
	}
	if err := runner.Run(context.Background(), log, "pnpm", args...); err != nil {
		var diagnostic *diag.Diag
		if errors.As(err, &diagnostic) {
			return diagnostic
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() < 0 {
			failure := contracts.NewDiag(contracts.CodePackageManagerKilled, "The package manager was killed, likely out of memory. The tuned install peaked at 992.3 MiB RSS (the unbounded run reached 1.14 GiB); this install requires 1.20 GiB available memory.", "Free memory, then rerun `kb-create install`.", err)
			failure.Meta = map[string]any{"requiredAvailableMemory": "1.20 GiB", "unboundedPeakMemory": "1.14 GiB", "tunedPeakMemory": "992.3 MiB"}
			return failure
		}
		var commandFailure *externalCommandFailure
		if errors.As(err, &commandFailure) {
			failure := contracts.NewDiag(contracts.CodeApplyFailed,
				"The package manager could not apply the exact artifacts.",
				"Read the installer log and fix the reported pnpm failure, then rerun `kb-create install`.",
				fmt.Errorf("pnpm %s exact artifacts: %w", command, err))
			failure.Meta = map[string]any{
				"packageManagerExitCode":   fmt.Sprint(commandFailure.exitCode),
				"packageManagerStderrTail": commandFailure.stderrTail,
			}
			return failure
		}
		return fmt.Errorf("pnpm %s exact artifacts: %w", command, err)
	}
	return nil
}

func (p Pnpm) packageManagerEnvironment() []string {
	root := p.PackageManagerRoot
	env := []string{
		"COREPACK_HOME=" + p.corepackHome(),
		"XDG_CACHE_HOME=" + filepath.Join(root, "xdg-cache"),
		"XDG_DATA_HOME=" + filepath.Join(root, "xdg-data"),
		"XDG_STATE_HOME=" + filepath.Join(root, "xdg-state"),
		"npm_config_cache=" + filepath.Join(root, "pnpm-cache"),
		"npm_config_devdir=" + filepath.Join(root, "node-gyp"),
		"npm_config_store_dir=" + filepath.Join(root, "pnpm-store"),
	}
	if p.Registry != "" {
		env = append(env, "COREPACK_NPM_REGISTRY="+p.Registry)
	}
	return env
}

func (p Pnpm) corepackHome() string { return filepath.Join(p.PackageManagerRoot, "corepack") }

func (p Pnpm) prepare() error {
	if p.Root == "" {
		return fmt.Errorf("V2 platform root is required")
	}
	if err := os.MkdirAll(p.Root, 0o750); err != nil {
		return err
	}
	if err := p.preparePackageJSON(); err != nil {
		return err
	}
	if err := p.prepareNpmrc(); err != nil {
		return err
	}
	return p.prepareWorkspaceYAML()
}

func (p Pnpm) prepareNpmrc() error {
	if p.Registry == "" {
		return nil
	}
	path := filepath.Join(p.Root, ".npmrc")
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(path, []byte("registry="+p.Registry+"\n"), 0o600)
}

func (p Pnpm) preparePackageJSON() error {
	path := filepath.Join(p.Root, "package.json")
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	// The launcher preflight deliberately supports the pnpm 11.x line, not one
	// particular patch release. Do not pin packageManager here: Corepack rejects
	// a supported newer pnpm when a generated project claims it must be exactly
	// 11.4.0, which made a later V2 update (and its rollback) impossible.
	data, _ := json.MarshalIndent(map[string]any{"name": "kb-platform", "private": true}, "", "  ")
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

// prepareWorkspaceYAML creates the base settings only when the file is absent.
// Plan release-age exclusions are merged separately on every install/restore,
// preserving pnpm and user entries from previous operations.
func (p Pnpm) prepareWorkspaceYAML() error {
	path := filepath.Join(p.Root, "pnpm-workspace.yaml")
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	var buf bytes.Buffer
	buf.WriteString("autoInstallPeers: false\n")
	buf.WriteString("childConcurrency: 1\n")
	buf.WriteString("networkConcurrency: 4\n")
	buf.WriteString("sideEffectsCache: false\n")
	buf.WriteString("allowBuilds:\n")
	for _, name := range approvedNativeBuilds {
		fmt.Fprintf(&buf, "  %q: true\n", name)
	}
	return os.WriteFile(path, buf.Bytes(), 0o600)
}

// mergeMinimumReleaseAgeExclude trusts only exact versions in the verified
// plan. This lets pnpm install freshly published sealed artifacts without
// weakening its release-age policy for dependencies resolved outside the plan.
func (p Pnpm) mergeMinimumReleaseAgeExclude(items []contracts.Artifact) error {
	path := filepath.Join(p.Root, "pnpm-workspace.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read pnpm workspace configuration: %w", err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("parse pnpm workspace configuration: %w", err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("pnpm workspace configuration must be a YAML mapping")
	}
	root := document.Content[0]
	var exclusions *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "minimumReleaseAgeExclude" {
			exclusions = root.Content[i+1]
			break
		}
	}
	if exclusions == nil {
		exclusions = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "minimumReleaseAgeExclude"}, exclusions)
	} else if exclusions.Kind != yaml.SequenceNode {
		return fmt.Errorf("pnpm workspace minimumReleaseAgeExclude must be a list")
	}
	versionsByPackage := make(map[string]map[string]struct{}, len(exclusions.Content)+len(items))
	retained := make([]string, 0, len(exclusions.Content))
	for _, entry := range exclusions.Content {
		if entry.Kind != yaml.ScalarNode || entry.Tag != "!!str" {
			return fmt.Errorf("pnpm workspace minimumReleaseAgeExclude entries must be strings")
		}
		packageName, versions, ok := exactReleaseAgeExclusion(entry.Value)
		if !ok {
			retained = append(retained, entry.Value)
			continue
		}
		addExactReleaseAgeVersions(versionsByPackage, packageName, versions...)
	}
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		if item.Package == "" || item.Version == "" {
			return fmt.Errorf("artifact %q must declare package and exact version", item.ID)
		}
		addExactReleaseAgeVersions(versionsByPackage, item.Package, item.Version)
	}
	packages := make([]string, 0, len(versionsByPackage))
	for packageName := range versionsByPackage {
		packages = append(packages, packageName)
	}
	sort.Strings(packages)
	for _, packageName := range packages {
		versions := make([]string, 0, len(versionsByPackage[packageName]))
		for version := range versionsByPackage[packageName] {
			versions = append(versions, version)
		}
		sort.Strings(versions)
		retained = append(retained, packageName+"@"+strings.Join(versions, " || "))
	}
	exclusions.Content = exclusions.Content[:0]
	for _, entry := range retained {
		exclusions.Content = append(exclusions.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: entry})
	}
	merged, err := yaml.Marshal(&document)
	if err != nil {
		return fmt.Errorf("encode pnpm workspace configuration: %w", err)
	}
	if err := os.WriteFile(path, merged, 0o600); err != nil {
		return fmt.Errorf("write pnpm workspace configuration: %w", err)
	}
	return nil
}

func exactReleaseAgeExclusion(value string) (string, []string, bool) {
	separator := strings.LastIndex(value, "@")
	if separator < 1 {
		return "", nil, false
	}
	packageName := value[:separator]
	versions := strings.Split(value[separator+1:], "||")
	for index, version := range versions {
		version = strings.TrimSpace(version)
		if _, err := semrange.ParseVersion(version); err != nil {
			return "", nil, false
		}
		versions[index] = version
	}
	return packageName, versions, true
}

func addExactReleaseAgeVersions(target map[string]map[string]struct{}, packageName string, versions ...string) {
	if target[packageName] == nil {
		target[packageName] = make(map[string]struct{}, len(versions))
	}
	for _, version := range versions {
		target[packageName][version] = struct{}{}
	}
}

// mergeSealedArtifactOverrides makes kb-create the owner of pnpm's single-copy
// rule. Each sealed package name must resolve to its exact cached archive,
// including when it appears as a transitive dependency of another artifact.
func (p Pnpm) mergeSealedArtifactOverrides(items []contracts.Artifact) error {
	path := filepath.Join(p.Root, "pnpm-workspace.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read pnpm workspace configuration: %w", err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("parse pnpm workspace configuration: %w", err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("pnpm workspace configuration must be a YAML mapping")
	}
	sealed := make(map[string]string, len(items))
	for _, item := range items {
		if item.IsBinary() || item.Tarball == "" {
			continue
		}
		if item.Package == "" || item.SHA256 == "" {
			return fmt.Errorf("sealed artifact %q must declare package and sha256 for pnpm override", item.ID)
		}
		sealed[item.Package] = "file:" + filepath.ToSlash(filepath.Join(p.CacheRoot, "packages", item.SHA256+".tgz"))
	}
	if len(sealed) == 0 {
		return nil
	}
	if p.CacheRoot == "" {
		return fmt.Errorf("sealed package overrides require the install root shared cache")
	}
	root := document.Content[0]
	var overrides *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "overrides" {
			overrides = root.Content[i+1]
			break
		}
	}
	if overrides == nil {
		overrides = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "overrides"}, overrides)
	} else if overrides.Kind != yaml.MappingNode {
		return fmt.Errorf("pnpm workspace overrides must be a mapping")
	}

	packageCachePrefix := "file:" + filepath.ToSlash(filepath.Join(p.CacheRoot, "packages")) + "/"
	for i := 0; i+1 < len(overrides.Content); {
		name := overrides.Content[i].Value
		value := overrides.Content[i+1]
		_, replace := sealed[name]
		managed := value.Kind == yaml.ScalarNode && (strings.HasPrefix(value.Value, "file:.kb/v2/cache/packages/") || strings.HasPrefix(value.Value, packageCachePrefix))
		if replace || managed {
			overrides.Content = append(overrides.Content[:i], overrides.Content[i+2:]...)
			continue
		}
		i += 2
	}
	for _, name := range sortedKeys(sealed) {
		overrides.Content = append(overrides.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: sealed[name]},
		)
	}
	merged, err := yaml.Marshal(&document)
	if err != nil {
		return fmt.Errorf("encode pnpm workspace configuration: %w", err)
	}
	if err := os.WriteFile(path, merged, 0o600); err != nil {
		return fmt.Errorf("write pnpm workspace configuration: %w", err)
	}
	return nil
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (p Pnpm) specs(items []contracts.Artifact) ([]string, error) {
	seen := make(map[string]struct{}, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		if item.Package == "" || item.Version == "" {
			return nil, fmt.Errorf("artifact %q must declare package and exact version", item.ID)
		}
		// Update is deliberately idempotent: pnpm add file:<tarball> can
		// rewrite an otherwise healthy lockfile and fail when the exact package
		// is already linked. Trust the installed package metadata, while still
		// installing missing or version-different artifacts.
		if p.installedExact(item.Package, item.Version) {
			continue
		}
		spec := item.Package + "@" + item.Version
		if item.Tarball != "" {
			path, err := p.tarball(item)
			if err != nil {
				return nil, err
			}
			spec = "file:" + path
		}
		if _, exists := seen[spec]; !exists {
			seen[spec] = struct{}{}
			result = append(result, spec)
		}
	}
	sort.Strings(result)
	return result, nil
}

func packageNames(items []contracts.Artifact) ([]string, error) {
	seen := make(map[string]struct{}, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		if item.IsBinary() {
			continue
		}
		if item.Package == "" || item.Version == "" {
			return nil, fmt.Errorf("artifact %q must declare package and exact version", item.ID)
		}
		if _, exists := seen[item.Package]; exists {
			continue
		}
		seen[item.Package] = struct{}{}
		result = append(result, item.Package)
	}
	sort.Strings(result)
	return result, nil
}

func (p Pnpm) installedExact(pkg, version string) bool {
	data, err := os.ReadFile(filepath.Join(p.Root, "node_modules", filepath.FromSlash(pkg), "package.json"))
	if err != nil {
		return false
	}
	var manifest struct {
		Version string `json:"version"`
	}
	return json.Unmarshal(data, &manifest) == nil && manifest.Version == version
}

func (p Pnpm) tarball(item contracts.Artifact) (string, error) {
	if item.SHA256 == "" {
		return "", fmt.Errorf("artifact %q tarball requires sha256", item.ID)
	}
	if p.CacheRoot == "" {
		return "", fmt.Errorf("artifact %q tarball requires the install root shared cache", item.ID)
	}
	path := filepath.Join(p.CacheRoot, "packages", item.SHA256+".tgz")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if p.Offline {
			return "", fmt.Errorf("offline package %s is absent from V2 cache", item.ID)
		}
		target := item.ResolvedURL
		if target == "" {
			return "", fmt.Errorf("artifact %s lacks a resolved download URL", item.ID)
		}
		data, err = fetchArtifact(p.Client, item, target)
		if err != nil {
			return "", err
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(data)); actual != item.SHA256 {
			return "", downloadFailure(item, target, fmt.Errorf("checksum mismatch: expected %s, got %s", item.SHA256, actual))
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return "", err
		}
		if err := os.WriteFile(path+".tmp", data, 0o600); err != nil {
			return "", err
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	if actual := fmt.Sprintf("%x", sha256.Sum256(data)); actual != item.SHA256 {
		return "", fmt.Errorf("package %s checksum mismatch: expected %s, got %s", item.ID, item.SHA256, actual)
	}
	return path, nil
}
