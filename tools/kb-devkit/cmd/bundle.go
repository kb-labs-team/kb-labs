package cmd

import (
	"fmt"
	clikitcommand "github.com/kb-labs/clikit/command"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var (
	bundleOut            string
	bundleDocker         bool
	bundleIncludeSources bool
	bundleProd           bool
)

var bundleCmd = &cobra.Command{
	Use:   "bundle <package-name-or-path>",
	Short: "Create a minimal Docker build context for a package",
	Long: `Resolves transitive workspace:* dependencies and emits a minimal build
context containing only the packages needed to build the target.

Equivalent to 'turbo prune --scope=<pkg>' for pnpm monorepos.

Output (default):
  pnpm-workspace.yaml  — pruned: only packages in the dependency closure
  <pkg>/package.json   — all needed package.json files (relative paths preserved)
  package.json         — root package.json
  pnpm-lock.yaml       — full root lockfile (pnpm ignores unused importers)

With --docker, output is split into two subdirectories for Docker layer caching:
  json/  — package.json files only (optimizes the dependency-install layer)
  full/  — full source of all closure packages (optimizes the build layer)

Examples:
  kb-devkit bundle @kb-labs/docs-site
  kb-devkit bundle sites/web/apps/docs --out /tmp/ctx
  kb-devkit bundle @kb-labs/docs-site --docker
  kb-devkit bundle @kb-labs/sdk --include-sources`,
	Args: cobra.ExactArgs(1),
	RunE: runBundle,
}

func init() {
	bundleCmd.Flags().StringVar(&bundleOut, "out", "", "output directory (default: .kb/bundle/<pkg-slug>)")
	bundleCmd.Flags().BoolVar(&bundleDocker, "docker", false, "split output into json/ and full/ for two-stage Docker builds")
	bundleCmd.Flags().BoolVar(&bundleIncludeSources, "include-sources", false, "copy source files of all packages in the closure")
	bundleCmd.Flags().BoolVar(&bundleProd, "prod", false, "exclude devDependencies from closure (for production Docker images)")
	rootCmd.AddCommand(bundleCmd)
}

func runBundle(cmd *cobra.Command, args []string) error {
	// loadWorkspace gives us the root path; DiscoverAll then reads every package from
	// pnpm-workspace.yaml without requiring devkit.yaml category classification —
	// bundle must work for all packages, even those not categorized in devkit.yaml
	// (e.g. Next.js apps under sites/*/apps/*).
	ws, cfg, err := loadWorkspace()
	if err != nil {
		return err
	}
	wsRoot := ws.Root

	allPkgs, err := workspace.DiscoverAll(wsRoot, cfg)
	if err != nil {
		return fmt.Errorf("discover workspace: %w", err)
	}

	// Resolve target package — by name or by relative path.
	target, err := resolvePackageFrom(allPkgs, wsRoot, args[0])
	if err != nil {
		return err
	}

	// Build pkgByName index for the whole workspace.
	pkgByName := make(map[string]workspace.Package, len(allPkgs))
	for _, p := range allPkgs {
		pkgByName[p.Name] = p
	}

	// BFS transitive closure of workspace:* deps.
	closure, err := buildClosure(target, pkgByName, bundleProd)
	if err != nil {
		return err
	}

	// Determine output directory.
	outDir := bundleOut
	if outDir == "" {
		outDir = filepath.Join(wsRoot, ".kb", "bundle", slugify(target.Name))
	}

	if bundleDocker {
		jsonDir := filepath.Join(outDir, "json")
		fullDir := filepath.Join(outDir, "full")

		if err := writeManifests(jsonDir, wsRoot, closure); err != nil {
			return err
		}
		if err := copyRootFiles(jsonDir, wsRoot); err != nil {
			return err
		}
		if err := writeManifests(fullDir, wsRoot, closure); err != nil {
			return err
		}
		if err := copyRootFiles(fullDir, wsRoot); err != nil {
			return err
		}
		if err := copySources(fullDir, closure); err != nil {
			return err
		}
		// Copy dist/ for all dependency packages (not the target itself).
		// The target's dist is produced by Docker build; deps are not rebuilt
		// inside Docker so their dist must be present for imports to resolve.
		deps := make([]workspace.Package, 0, len(closure)-1)
		for _, p := range closure {
			if p.Name != target.Name {
				deps = append(deps, p)
			}
		}
		if err := copyDists(fullDir, deps); err != nil {
			return err
		}
	} else {
		if err := writeManifests(outDir, wsRoot, closure); err != nil {
			return err
		}
		if err := copyRootFiles(outDir, wsRoot); err != nil {
			return err
		}
		if bundleIncludeSources {
			if err := copySources(outDir, closure); err != nil {
				return err
			}
		}
	}

	relPaths := make([]string, len(closure))
	for i, p := range closure {
		relPaths[i] = p.RelPath
	}

	if jsonMode {
		return JSONOut(map[string]any{
			"ok":       true,
			"target":   target.Name,
			"out":      outDir,
			"packages": relPaths,
			"count":    len(closure),
		})
	}

	o := newOutput()
	o.OK(fmt.Sprintf("Bundle ready: %s", outDir))
	clikitcommand.Printf("\n")
	o.KeyValue("target", target.Name)
	o.KeyValue("packages", fmt.Sprintf("%d in closure", len(closure)))
	clikitcommand.Printf("\n")
	for _, p := range closure {
		o.Bullet(p.RelPath, p.Name)
	}
	clikitcommand.Printf("\n")
	return nil
}

// resolvePackageFrom finds a Package by name or relative path in a flat package list.
func resolvePackageFrom(pkgs []workspace.Package, wsRoot, arg string) (workspace.Package, error) {
	// Try exact name match first.
	for _, p := range pkgs {
		if p.Name == arg {
			return p, nil
		}
	}

	// Try as a relative path.
	absPath := filepath.Join(wsRoot, filepath.Clean(arg))
	for _, p := range pkgs {
		if p.Dir == absPath {
			return p, nil
		}
	}

	return workspace.Package{}, fmt.Errorf("package %q not found in workspace (tried name and path)", arg)
}

// buildClosure returns the transitive workspace dependency closure for target,
// sorted by RelPath for deterministic output.
// If prod is true, devDependencies are excluded from the closure (for Docker images).
func buildClosure(target workspace.Package, pkgByName map[string]workspace.Package, prod bool) ([]workspace.Package, error) {
	visited := map[string]workspace.Package{target.Name: target}
	queue := []workspace.Package{target}

	depsFunc := engine.WorkspaceDeps
	if prod {
		depsFunc = engine.WorkspaceProdDeps
	}

	for len(queue) > 0 {
		pkg := queue[0]
		queue = queue[1:]

		depNames, err := depsFunc(pkg.Dir, pkgByName)
		if err != nil {
			return nil, err
		}
		for _, depName := range depNames {
			if _, seen := visited[depName]; !seen {
				dep := pkgByName[depName]
				visited[depName] = dep
				queue = append(queue, dep)
			}
		}
	}

	result := make([]workspace.Package, 0, len(visited))
	for _, p := range visited {
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].RelPath < result[j].RelPath
	})
	return result, nil
}

// writeManifests writes the pruned pnpm-workspace.yaml and all package.json files.
func writeManifests(outDir, wsRoot string, closure []workspace.Package) error {
	// Build and write pnpm-workspace.yaml.
	relPaths := make([]string, len(closure))
	for i, p := range closure {
		relPaths[i] = p.RelPath
	}

	// Keep workspace-level pnpm settings (overrides, allowBuilds, auditConfig,
	// etc.) when pruning package globs. The lockfile still contains those
	// settings, so dropping them makes frozen installs fail with a config
	// mismatch inside Docker bundles.
	workspaceConfig := make(map[string]interface{})
	workspacePath := filepath.Join(wsRoot, "pnpm-workspace.yaml")
	if source, err := os.ReadFile(workspacePath); err == nil {
		if err := yaml.Unmarshal(source, &workspaceConfig); err != nil {
			return fmt.Errorf("parse %s: %w", workspacePath, err)
		}
	}
	workspaceConfig["packages"] = relPaths
	data, err := yaml.Marshal(workspaceConfig)
	if err != nil {
		return fmt.Errorf("marshal pnpm-workspace.yaml: %w", err)
	}
	if err := writeFile(filepath.Join(outDir, "pnpm-workspace.yaml"), data); err != nil {
		return err
	}

	// Copy each package's package.json, preserving relative paths.
	for _, p := range closure {
		src := filepath.Join(p.Dir, "package.json")
		dst := filepath.Join(outDir, p.RelPath, "package.json")
		if err := copyFile(dst, src); err != nil {
			return fmt.Errorf("copy %s/package.json: %w", p.RelPath, err)
		}
	}
	return nil
}

// copyRootFiles copies root package.json, pnpm-lock.yaml, and tsconfig files.
// Also copies tsconfig.base.json from every top-level category directory present in outDir,
// because packages extend these via relative paths (e.g. ../../tsconfig.base.json).
func copyRootFiles(outDir, wsRoot string) error {
	if err := copyFile(filepath.Join(outDir, "package.json"), filepath.Join(wsRoot, "package.json")); err != nil {
		return fmt.Errorf("copy root package.json: %w", err)
	}

	lockSrc := filepath.Join(wsRoot, "pnpm-lock.yaml")
	if _, err := os.Stat(lockSrc); err == nil {
		if err := copyFile(filepath.Join(outDir, "pnpm-lock.yaml"), lockSrc); err != nil {
			return fmt.Errorf("copy pnpm-lock.yaml: %w", err)
		}
	}

	// Copy tsconfig.base.json from workspace root and from every top-level
	// category directory that appears in the bundle (core/, plugins/, shared/, etc.).
	tsconfigName := "tsconfig.base.json"

	// Root-level tsconfig.base.json
	if src := filepath.Join(wsRoot, tsconfigName); fileExists(src) {
		if err := copyFile(filepath.Join(outDir, tsconfigName), src); err != nil {
			return fmt.Errorf("copy %s: %w", tsconfigName, err)
		}
	}

	// Category-level tsconfig.base.json — walk top-level dirs in outDir
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		src := filepath.Join(wsRoot, e.Name(), tsconfigName)
		if fileExists(src) {
			dst := filepath.Join(outDir, e.Name(), tsconfigName)
			if err := copyFile(dst, src); err != nil {
				return fmt.Errorf("copy %s/%s: %w", e.Name(), tsconfigName, err)
			}
		}
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// copySources recursively copies source files for all closure packages.
// Skips node_modules, dist, .next, .turbo, .cache, and *.log files.
func copySources(outDir string, closure []workspace.Package) error {
	skip := map[string]bool{
		"node_modules": true,
		"dist":         true,
		".next":        true,
		".turbo":       true,
		".cache":       true,
	}

	for _, p := range closure {
		srcRoot := p.Dir
		dstRoot := filepath.Join(outDir, p.RelPath)

		err := filepath.Walk(srcRoot, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			rel, err := filepath.Rel(srcRoot, path)
			if err != nil {
				return err
			}

			// Skip ignored directories.
			if info.IsDir() {
				if skip[info.Name()] {
					return filepath.SkipDir
				}
				return nil
			}

			// Skip log files.
			if strings.HasSuffix(info.Name(), ".log") {
				return nil
			}

			dst := filepath.Join(dstRoot, rel)
			return copyFile(dst, path)
		})
		if err != nil {
			return fmt.Errorf("copy sources for %s: %w", p.RelPath, err)
		}
	}
	return nil
}

// copyDists copies the dist/ directory for each package that has one.
// Used in --docker mode to ensure dependency build artifacts are available
// inside the Docker builder layer (deps are not rebuilt inside Docker).
func copyDists(outDir string, pkgs []workspace.Package) error {
	for _, p := range pkgs {
		distSrc := filepath.Join(p.Dir, "dist")
		if _, err := os.Stat(distSrc); os.IsNotExist(err) {
			continue // no dist/ — skip silently
		}
		distDst := filepath.Join(outDir, p.RelPath, "dist")
		err := filepath.Walk(distSrc, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(distSrc, path)
			if err != nil {
				return err
			}
			if info.IsDir() {
				return nil
			}
			return copyFile(filepath.Join(distDst, rel), path)
		})
		if err != nil {
			return fmt.Errorf("copy dist for %s: %w", p.RelPath, err)
		}
	}
	return nil
}

// copyFile copies a single file, creating parent directories as needed.
func copyFile(dst, src string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

// writeFile writes bytes to a file, creating parent directories as needed.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// slugify converts a package name to a filesystem-safe slug.
// "@kb-labs/docs-site" → "docs-site", "docs-site" → "docs-site"
func slugify(name string) string {
	// Strip @scope/ prefix for scoped packages.
	if strings.HasPrefix(name, "@") {
		if i := strings.LastIndex(name, "/"); i >= 0 {
			return name[i+1:]
		}
	}
	return name
}
