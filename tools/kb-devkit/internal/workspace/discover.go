package workspace

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/devkit/internal/config"
)

const defaultMaxDepth = 3

// DiscoverAll returns all packages declared in pnpm-workspace.yaml (or package.json workspaces),
// without requiring devkit.yaml categories. Packages that have no matching category are included
// with an empty Category field. Useful for tools like bundle that need the full workspace graph.
// Respects workspace.exclude and workspace.maxDepth from cfg when cfg is provided.
func DiscoverAll(root string, cfg *config.DevkitConfig) ([]Package, error) {
	dirs, err := resolveWorkspaceDirs(root, cfg)
	if err != nil {
		return nil, err
	}
	var result []Package
	for _, dir := range dirs.all {
		rel, _ := filepath.Rel(root, dir)
		name := readPackageName(dir)
		result = append(result, Package{
			Name:       name,
			Dir:        dir,
			RelPath:    rel,
			PnpmMember: dirs.pnpm[dir],
		})
	}
	return result, nil
}

// discoverPackages expands pnpm-workspace.yaml patterns efficiently.
//
// Algorithm: instead of globbing the entire filesystem, we expand wildcards
// level-by-level using os.ReadDir. This is O(dirs_per_level × depth) instead
// of O(total_files_in_workspace).
//
// Pattern semantics (pnpm-workspace.yaml subset):
//
//	"platform/*/packages/**"  → expand * with ReadDir at each level
//	"infra/kb-labs-devkit"    → literal path, stat package.json directly
//
// Recursion depth for ** is controlled by cfg.Workspace.MaxDepth (default 3).
func discoverPackages(root string, cfg *config.DevkitConfig) ([]Package, error) {
	dirs, err := resolveWorkspaceDirs(root, cfg)
	if err != nil {
		return nil, err
	}
	packages := classifyPackages(root, dirs.all, cfg)
	for i := range packages {
		packages[i].PnpmMember = dirs.pnpm[packages[i].Dir]
	}
	return packages, nil
}

type resolvedPackageDirs struct {
	all  []string
	pnpm map[string]bool
}

// collectPackageDirs resolves the full list of package directories from workspace
// patterns, respecting excludes and maxDepth from cfg.
func resolveWorkspaceDirs(root string, cfg *config.DevkitConfig) (resolvedPackageDirs, error) {
	var patterns []string
	var err error
	if cfg != nil && len(cfg.Workspace.Discovery) > 0 {
		patterns = cfg.Workspace.Discovery
	} else {
		patterns, err = readPnpmWorkspace(root)
		if err != nil {
			patterns, err = readPackageJSONWorkspaces(root)
			if err != nil {
				return resolvedPackageDirs{}, err
			}
		}
	}

	maxDepth := defaultMaxDepth
	if cfg != nil && cfg.Workspace.MaxDepth > 0 {
		maxDepth = cfg.Workspace.MaxDepth
	}

	seen := make(map[string]bool)
	pnpmMembers := make(map[string]bool)
	var pkgDirs []string

	for _, pattern := range patterns {
		// Skip negation patterns (e.g. "!plugins/fixtures/*") — exclusions are
		// handled by workspace.exclude in cfg; negation patterns in pnpm-workspace.yaml
		// are applied via isExcluded below.
		if strings.HasPrefix(pattern, "!") {
			continue
		}
		dirs := expandPattern(root, pattern, maxDepth)
		for _, dir := range dirs {
			if cfg != nil && isExcluded(root, dir, cfg.Workspace.Exclude) {
				continue
			}
			pnpmMembers[dir] = true
			if seen[dir] {
				continue
			}
			seen[dir] = true
			pkgDirs = append(pkgDirs, dir)
		}
	}

	// Category match patterns are also package declarations. Discover packages
	// covered by those patterns even when pnpm intentionally excludes them,
	// such as candidate-only fixtures with their own build tasks.
	if cfg != nil {
		for _, nc := range cfg.Workspace.Categories {
			for _, pattern := range nc.Category.Match {
				for _, dir := range expandPattern(root, pattern, maxDepth) {
					if seen[dir] || isExcluded(root, dir, cfg.Workspace.Exclude) {
						continue
					}
					seen[dir] = true
					pkgDirs = append(pkgDirs, dir)
				}
			}
		}
	}

	return resolvedPackageDirs{all: pkgDirs, pnpm: pnpmMembers}, nil
}

// expandPattern expands a single pnpm-workspace pattern into concrete package dirs.
// A package dir is any directory containing a package.json file.
func expandPattern(root, pattern string, maxDepth int) []string {
	// Normalize: strip trailing slash and trailing /**
	pattern = strings.TrimSuffix(pattern, "/")
	isRecursive := strings.HasSuffix(pattern, "/**")
	if isRecursive {
		pattern = strings.TrimSuffix(pattern, "/**")
	}

	segments := strings.Split(pattern, "/")
	candidates := expandSegments(root, segments)

	isWildcard := strings.ContainsAny(pattern, "*?")

	var result []string
	for _, dir := range candidates {
		if isRecursive {
			// Recursive glob — only dirs with package.json are packages.
			result = append(result, collectPackageDirs(dir, maxDepth)...)
		} else if isWildcard {
			// Wildcard pattern — only include dirs that have a package.json.
			if hasPackageJSON(dir) {
				result = append(result, dir)
			}
		} else {
			// Literal path — the user explicitly named this directory.
			// Accept it if it exists, regardless of package.json presence.
			// This allows Go binaries, Makefiles-only projects, etc.
			if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
				result = append(result, dir)
			}
		}
	}
	return result
}

// expandSegments resolves path segments level-by-level.
// A segment of "*" expands to all subdirectories at that level.
// All other segments are treated as literals.
func expandSegments(root string, segments []string) []string {
	current := []string{root}

	for _, seg := range segments {
		if seg == "" {
			continue
		}
		if seg == "*" {
			var next []string
			for _, dir := range current {
				entries, err := os.ReadDir(dir)
				if err != nil {
					continue
				}
				for _, e := range entries {
					if e.IsDir() && !isHidden(e.Name()) {
						next = append(next, filepath.Join(dir, e.Name()))
					}
				}
			}
			current = next
		} else {
			// Literal segment.
			var next []string
			for _, dir := range current {
				candidate := filepath.Join(dir, seg)
				if info, err := os.Stat(candidate); err == nil && info.IsDir() {
					next = append(next, candidate)
				}
			}
			current = next
		}
	}

	return current
}

// collectPackageDirs finds all directories containing package.json up to maxDepth levels deep.
func collectPackageDirs(root string, maxDepth int) []string {
	var result []string
	collectPackageDirsInto(root, 0, maxDepth, &result)
	return result
}

func collectPackageDirsInto(dir string, depth, maxDepth int, result *[]string) {
	if depth > maxDepth {
		return
	}

	if hasPackageJSON(dir) {
		*result = append(*result, dir)
		// Don't recurse into package subdirs (monorepo packages aren't nested).
		return
	}

	if depth == maxDepth {
		return
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	for _, e := range entries {
		if !e.IsDir() || isHidden(e.Name()) || isSkipped(e.Name()) {
			continue
		}
		collectPackageDirsInto(filepath.Join(dir, e.Name()), depth+1, maxDepth, result)
	}
}

// isExcluded returns true if dir matches any of the exclude patterns.
func isExcluded(root, dir string, excludePatterns []string) bool {
	if len(excludePatterns) == 0 {
		return false
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil {
		return false
	}
	for _, pat := range excludePatterns {
		if matchPattern(pat, rel) {
			return true
		}
	}
	return false
}

func hasPackageJSON(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "package.json"))
	return err == nil
}

func isHidden(name string) bool {
	return strings.HasPrefix(name, ".")
}

// isSkipped returns true for directories we never need to recurse into.
func isSkipped(name string) bool {
	switch name {
	case "node_modules", "dist", ".git", "__pycache__", ".turbo", "coverage":
		return true
	}
	return false
}

// classifyPackages maps each package dir to a category+preset.
func classifyPackages(root string, dirs []string, cfg *config.DevkitConfig) []Package {
	var result []Package
	for _, dir := range dirs {
		rel, _ := filepath.Rel(root, dir)
		name := readPackageName(dir)

		// Apply workspace.include filter (if any): rel must match at least one pattern.
		if len(cfg.Workspace.Include) > 0 {
			matched := false
			for _, pat := range cfg.Workspace.Include {
				if matchPattern(pat, rel) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}

		// Apply workspace.exclude filter: skip if rel matches any pattern.
		excluded := false
		for _, pat := range cfg.Workspace.Exclude {
			if matchPattern(pat, rel) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}

		category, preset, language, releaseLane := classify(rel, cfg)
		if category == "" {
			continue // uncategorized — skip silently
		}

		result = append(result, Package{
			Name:        name,
			Dir:         dir,
			Category:    category,
			ReleaseLane: releaseLane,
			Preset:      preset,
			Language:    language,
			RelPath:     rel,
		})
	}
	return result
}

// classify returns category/preset/language for a relative package path.
// Categories are evaluated in declaration order — first match wins.
func classify(relPath string, cfg *config.DevkitConfig) (category, preset, language, releaseLane string) {
	if cfg == nil || len(cfg.Workspace.Categories) == 0 {
		return "", "", "", ""
	}

	for _, nc := range cfg.Workspace.Categories {
		for _, pattern := range nc.Category.Match {
			if matchPattern(pattern, relPath) {
				lang := nc.Category.Language
				if lang == "" {
					lang = inferLanguage(nc.Category.Preset)
				}
				return nc.Name, nc.Category.Preset, lang, nc.Category.ReleaseLane
			}
		}
	}
	return "", "", "", ""
}

// matchPattern matches a pnpm-style glob pattern against a relative path.
// Supports: literal segments, *, ** (suffix only).
func matchPattern(pattern, relPath string) bool {
	// Normalize pattern.
	pattern = strings.TrimSuffix(pattern, "/")
	isRecursive := strings.HasSuffix(pattern, "/**")
	if isRecursive {
		pattern = strings.TrimSuffix(pattern, "/**")
	}

	// Build a simple matcher segment by segment.
	patSegs := strings.Split(pattern, "/")
	pathSegs := strings.Split(relPath, "/")

	if isRecursive {
		// Pattern prefix must match the start of relPath.
		if len(pathSegs) < len(patSegs) {
			return false
		}
		return matchSegments(patSegs, pathSegs[:len(patSegs)])
	}

	// Exact segment count match.
	if len(patSegs) != len(pathSegs) {
		return false
	}
	return matchSegments(patSegs, pathSegs)
}

func matchSegments(pattern, path []string) bool {
	for i, seg := range pattern {
		if seg == "*" {
			continue // matches any single segment
		}
		if seg != path[i] {
			return false
		}
	}
	return true
}

func inferLanguage(preset string) string {
	if preset == "go-binary" {
		return "go"
	}
	return "typescript"
}
