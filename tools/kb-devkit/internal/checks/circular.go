package checks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// CircularResult maps package dir to issues detected from circular dependency analysis.
type CircularResult map[string][]Issue

// CircularEnabled reports whether any configured workspace category enables
// the shared circular dependency check.
func CircularEnabled(cfg *config.DevkitConfig) bool {
	if cfg == nil {
		return false
	}
	for _, category := range cfg.Workspace.Categories {
		preset, err := config.ResolvePreset(category.Category.Preset, cfg)
		if err == nil && preset.Deps.CheckCircular {
			return true
		}
	}
	return false
}

// DetectCircular runs Tarjan SCC on the full workspace dependency graph.
// It runs once and distributes results per-package.
func DetectCircular(pkgs []workspace.Package) CircularResult {
	// Build name → dir index.
	nameToDir := make(map[string]string, len(pkgs))
	dirSet := make(map[string]bool, len(pkgs))
	for _, p := range pkgs {
		nameToDir[p.Name] = p.Dir
		dirSet[p.Dir] = true
	}

	// Build adjacency list: dir → []dir (internal deps only).
	graph := make(map[string][]string, len(pkgs))
	for _, p := range pkgs {
		deps := readInternalDeps(p.Dir, nameToDir)
		graph[p.Dir] = deps
	}

	// Tarjan SCC.
	sccs := tarjan(graph)

	result := make(CircularResult)
	for _, scc := range sccs {
		if len(scc) < 2 {
			continue
		}
		// All nodes in this SCC are in a cycle.
		cycle := strings.Join(sccNames(scc, pkgs), " → ")
		for _, dir := range scc {
			result[dir] = append(result[dir], Issue{
				Check:    "circular",
				Severity: SeverityError,
				Message:  "circular dependency detected: " + cycle,
			})
		}
	}

	return result
}

func readInternalDeps(dir string, nameToDir map[string]string) []string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil
	}
	var pkg struct {
		Dependencies         map[string]string `json:"dependencies"`
		DevDependencies      map[string]string `json:"devDependencies"`
		OptionalDependencies map[string]string `json:"optionalDependencies"`
		PeerDependencies     map[string]string `json:"peerDependencies"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return nil
	}

	seen := make(map[string]struct{})
	var result []string
	for name := range pkg.Dependencies {
		if target, ok := nameToDir[name]; ok {
			seen[target] = struct{}{}
			result = append(result, target)
		}
	}
	for name := range pkg.DevDependencies {
		if target, ok := nameToDir[name]; ok {
			if _, dup := seen[target]; !dup {
				seen[target] = struct{}{}
				result = append(result, target)
			}
		}
	}
	for name := range pkg.OptionalDependencies {
		if target, ok := nameToDir[name]; ok {
			if _, dup := seen[target]; !dup {
				seen[target] = struct{}{}
				result = append(result, target)
			}
		}
	}
	for name := range pkg.PeerDependencies {
		if target, ok := nameToDir[name]; ok {
			if _, dup := seen[target]; !dup {
				result = append(result, target)
			}
		}
	}
	return result
}

func sccNames(dirs []string, pkgs []workspace.Package) []string {
	dirToName := make(map[string]string, len(pkgs))
	for _, p := range pkgs {
		dirToName[p.Dir] = p.Name
	}
	names := make([]string, 0, len(dirs))
	for _, d := range dirs {
		if n, ok := dirToName[d]; ok {
			names = append(names, n)
		} else {
			names = append(names, d)
		}
	}
	return names
}

// ─── Tarjan SCC ──────────────────────────────────────────────────────────────

type tarjanState struct {
	graph   map[string][]string
	index   map[string]int
	lowlink map[string]int
	onStack map[string]bool
	stack   []string
	counter int
	sccs    [][]string
}

func tarjan(graph map[string][]string) [][]string {
	s := &tarjanState{
		graph:   graph,
		index:   make(map[string]int),
		lowlink: make(map[string]int),
		onStack: make(map[string]bool),
	}
	for v := range graph {
		if _, visited := s.index[v]; !visited {
			s.strongconnect(v)
		}
	}
	return s.sccs
}

func (s *tarjanState) strongconnect(v string) {
	s.index[v] = s.counter
	s.lowlink[v] = s.counter
	s.counter++
	s.stack = append(s.stack, v)
	s.onStack[v] = true

	for _, w := range s.graph[v] {
		if _, visited := s.index[w]; !visited {
			s.strongconnect(w)
			if s.lowlink[w] < s.lowlink[v] {
				s.lowlink[v] = s.lowlink[w]
			}
		} else if s.onStack[w] {
			if s.index[w] < s.lowlink[v] {
				s.lowlink[v] = s.index[w]
			}
		}
	}

	if s.lowlink[v] == s.index[v] {
		var scc []string
		for {
			w := s.stack[len(s.stack)-1]
			s.stack = s.stack[:len(s.stack)-1]
			s.onStack[w] = false
			scc = append(scc, w)
			if w == v {
				break
			}
		}
		s.sccs = append(s.sccs, scc)
	}
}
