// Package artifacts contains V2's exact-artifact executor. It receives only
// immutable artifact versions from ResolvedInstallPlan; it never resolves npm
// tags, scans node_modules for product decisions, or imports legacy pm code.
package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"

	"github.com/kb-labs/create/v2/contracts"
)

type Runner interface {
	Run(context.Context, io.Writer, string, ...string) error
}

type commandRunner struct{}

func (commandRunner) Run(ctx context.Context, output io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = output, output
	return cmd.Run()
}

type Pnpm struct {
	Root     string
	Registry string
	Offline  bool
	Client   *http.Client
	Runner   Runner
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
// tsup-based tooling), and @kb-labs/devkit (a benign, non-fatal `|| true`
// postinstall that generates local tsup config — see infra/devkit/package.json).
//
// This is written into pnpm-workspace.yaml's `allowBuilds` map (the format
// `pnpm approve-builds --all` itself writes) rather than passed as a CLI
// `--allow-build=` flag: pnpm 11.4.0 (pinned in the E2E image and this
// repo's own packageManager field) mis-parses a comma-joined value as a
// single "name@version-union" spec — and therefore fails with
// ERR_PNPM_INVALID_VERSION_UNION — the moment the list has more than one
// entry AND at least one is scoped (contains "@"), which every combination
// including @kb-labs/devkit hits. Confirmed directly against pnpm 11.4.0:
// the CLI flag breaks on this exact list (comma-joined or repeated), while
// this config file's `allowBuilds` map handles it cleanly.
var approvedNativeBuilds = []string{"better-sqlite3", "esbuild", "unrs-resolver", "@kb-labs/devkit"}

func (p Pnpm) Install(items []contracts.Artifact) error {
	if err := p.prepare(); err != nil {
		return err
	}
	specs, err := p.specs(items)
	if err != nil {
		return err
	}
	if len(specs) == 0 {
		return nil
	}
	return p.run("add", specs...)
}
func (p Pnpm) Restore() error {
	if err := p.prepare(); err != nil {
		return err
	}
	return p.run("install")
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
	args = append(args, specs...)
	if p.Registry != "" {
		args = append(args, "--registry", p.Registry)
	}
	runner := p.Runner
	if runner == nil {
		runner = commandRunner{}
	}
	log := p.Log
	if log == nil {
		log = io.Discard
	}
	if err := runner.Run(context.Background(), log, "pnpm", args...); err != nil {
		return fmt.Errorf("pnpm %s exact artifacts: %w", command, err)
	}
	return nil
}

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
	return p.prepareWorkspaceYAML()
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

// prepareWorkspaceYAML only writes when the file is absent, same guard as
// preparePackageJSON: pnpm itself rewrites this file during install (e.g. it
// appends entries to minimumReleaseAgeExclude), so unconditionally
// regenerating it on every apply would discard pnpm's own additions from a
// prior run. A project bootstrapped by an older kb-create version (before
// this file existed) still gets it written on its next apply, since the
// file won't exist yet there either.
func (p Pnpm) prepareWorkspaceYAML() error {
	path := filepath.Join(p.Root, "pnpm-workspace.yaml")
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	var buf bytes.Buffer
	buf.WriteString("allowBuilds:\n")
	for _, name := range approvedNativeBuilds {
		fmt.Fprintf(&buf, "  %q: true\n", name)
	}
	return os.WriteFile(path, buf.Bytes(), 0o600)
}

func (p Pnpm) specs(items []contracts.Artifact) ([]string, error) {
	seen := make(map[string]struct{}, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		if item.Kind == "binary" {
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
		if item.Kind == "binary" {
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
	path := filepath.Join(p.Root, ".kb", "v2", "cache", "packages", item.SHA256+".tgz")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if p.Offline {
			return "", fmt.Errorf("offline package %s is absent from V2 cache", item.ID)
		}
		client := p.Client
		if client == nil {
			client = http.DefaultClient
		}
		response, getErr := client.Get(item.Tarball)
		if getErr != nil {
			return "", fmt.Errorf("download package %s: %w", item.ID, getErr)
		}
		data, err = io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
			return "", fmt.Errorf("download package %s: status %d: %v", item.ID, response.StatusCode, err)
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
	if fmt.Sprintf("%x", sha256.Sum256(data)) != item.SHA256 {
		return "", fmt.Errorf("package %s checksum mismatch", item.ID)
	}
	return path, nil
}
