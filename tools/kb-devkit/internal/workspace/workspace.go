// Package workspace discovers and classifies packages in the monorepo.
package workspace

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kb-labs/devkit/internal/cache"
	"github.com/kb-labs/devkit/internal/config"
)

// Package represents a single package in the monorepo.
type Package struct {
	Name        string // @acme/core-runtime
	Dir         string // absolute path
	Category    string // ts-lib, go-binary, site, ...
	ReleaseLane string // internal-tool; an empty value retains default gating membership
	Preset      string // node-lib, go-binary, ...
	Language    string // typescript, go
	RelPath     string // relative to workspace root
	BuildTarget bool   // whether the resolved devkit task graph defines a build task
	PnpmMember  bool   // whether pnpm-workspace.yaml declares this package
}

// Workspace holds all discovered packages and the root path.
type Workspace struct {
	Root       string
	Packages   []Package
	aggregates map[string][]string
	// byAbsPath is an O(1) lookup map: absolute file path → package.
	byAbsPath map[string]*Package
}

// New creates a Workspace by discovering and classifying packages.
func New(root string, cfg *config.DevkitConfig) (*Workspace, error) {
	pkgs, err := discoverPackages(root, cfg)
	if err != nil {
		return nil, fmt.Errorf("discover packages: %w", err)
	}

	ws := &Workspace{
		Root:       root,
		Packages:   pkgs,
		aggregates: discoverAggregates(pkgs),
		byAbsPath:  make(map[string]*Package),
	}

	// Resolve the build task through the same category/task model used by the scheduler.
	if cfg != nil {
		for i := range ws.Packages {
			if build, ok := cfg.Tasks["build"]; ok {
				ws.Packages[i].BuildTarget = !ws.IsAggregatePackage(ws.Packages[i].Name) && build.ResolveVariant(ws.Packages[i].Category) != nil
			}
		}
	}

	// Build reverse index: every file under a package dir maps to that package.
	// We only store the package dir itself as the key; callers use PackageByPath
	// which walks up the path to find the matching entry.
	for i := range ws.Packages {
		ws.byAbsPath[ws.Packages[i].Dir] = &ws.Packages[i]
	}

	return ws, nil
}

// AggregateChildren returns the workspace package names nested below packageName.
// The topology is derived once from the same discovered package list used by
// the scheduler, so checks and task resolution share one owner.
func (ws *Workspace) AggregateChildren(packageName string) []string {
	return append([]string(nil), ws.aggregates[packageName]...)
}

// IsAggregatePackage reports whether the package directory contains another
// discovered workspace package.
func (ws *Workspace) IsAggregatePackage(packageName string) bool {
	return len(ws.aggregates[packageName]) > 0
}

func discoverAggregates(packages []Package) map[string][]string {
	aggregates := make(map[string][]string)
	for _, parent := range packages {
		for _, child := range packages {
			if parent.Name == child.Name {
				continue
			}
			rel, err := filepath.Rel(parent.Dir, child.Dir)
			if err != nil || rel == "." || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				continue
			}
			aggregates[parent.Name] = append(aggregates[parent.Name], child.Name)
		}
	}
	for name := range aggregates {
		sort.Strings(aggregates[name])
	}
	return aggregates
}

// FilterByName returns packages matching any of the given names.
func (ws *Workspace) FilterByName(names []string) []Package {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	var result []Package
	for _, p := range ws.Packages {
		if set[p.Name] {
			result = append(result, p)
		}
	}
	return result
}

// FilterByCategory returns packages in the given category.
func (ws *Workspace) FilterByCategory(category string) []Package {
	var result []Package
	for _, p := range ws.Packages {
		if p.Category == category {
			result = append(result, p)
		}
	}
	return result
}

// PackageByPath returns the package that owns the given absolute file path.
// It walks upward from the path until it finds a known package dir.
func (ws *Workspace) PackageByPath(absPath string) (*Package, bool) {
	cur := absPath
	for {
		if pkg, ok := ws.byAbsPath[cur]; ok {
			return pkg, true
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return nil, false
}

// TrackedFileOwnership partitions Git-tracked paths with PackageByPath, the
// ownership rule also used by affected selection. Paths deleted from the
// working tree remain in the result.
func (ws *Workspace) TrackedFileOwnership() (unowned []string, owned map[string][]string, tracked map[string]cache.TrackedFile, err error) {
	command := exec.Command("git", "-C", ws.Root, "ls-files", "--stage", "-z")
	output, err := command.Output()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("list tracked workspace files: %w", err)
	}

	owned = make(map[string][]string, len(ws.Packages))
	tracked = make(map[string]cache.TrackedFile)
	for _, record := range strings.Split(string(output), "\x00") {
		if record == "" {
			continue
		}
		metadata, rel, found := strings.Cut(record, "\t")
		if !found {
			return nil, nil, nil, fmt.Errorf("parse tracked workspace entry %q: missing path separator", record)
		}
		var mode uint32
		var objectID, stage string
		if _, err := fmt.Sscanf(metadata, "%o %s %s", &mode, &objectID, &stage); err != nil {
			return nil, nil, nil, fmt.Errorf("parse tracked workspace metadata %q: %w", metadata, err)
		}
		if stage != "0" {
			return nil, nil, nil, fmt.Errorf("tracked workspace path %q has unresolved index stage %s", rel, stage)
		}
		absPath := filepath.Join(ws.Root, filepath.FromSlash(rel))
		tracked[filepath.Clean(absPath)] = cache.TrackedFile{Mode: mode, ObjectID: objectID}
		if pkg, ok := ws.PackageByPath(absPath); ok {
			owned[pkg.Name] = append(owned[pkg.Name], absPath)
		} else {
			unowned = append(unowned, absPath)
		}
	}
	sort.Strings(unowned)
	for name := range owned {
		sort.Strings(owned[name])
	}
	return unowned, owned, tracked, nil
}
