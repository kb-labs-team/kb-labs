package cache

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Manifest records the result of one (package, task) execution.
// It maps an input hash to: exit code, stdout, and output file refs.
// Output files are stored as SHA256 objects in ObjectStore — no copies.
type Manifest struct {
	InputHash string      `json:"inputHash"`
	ExitCode  int         `json:"exitCode"`
	Stdout    string      `json:"stdout,omitempty"`
	Stderr    string      `json:"stderr,omitempty"`
	Elapsed   string      `json:"elapsed"`
	Outputs   []OutputRef `json:"outputs"`
}

// OutputRef maps a relative file path to its SHA256 object key.
type OutputRef struct {
	Path   string  `json:"path"`           // relative to package dir
	Object string  `json:"object"`         // SHA256 hex → ObjectStore key
	Mode   *uint32 `json:"mode,omitempty"` // original permission bits; absent means an invalid legacy entry
}

// ManifestStore reads and writes Manifest files.
// Layout: <cacheRoot>/tasks/<pkg-slug>/<taskName>/<inputHash>.json
type ManifestStore struct {
	root string // same root as LocalStore (the shared store)
}

// NewManifestStore creates a ManifestStore backed by root.
func NewManifestStore(root string) *ManifestStore {
	return &ManifestStore{root: root}
}

func (ms *ManifestStore) manifestPath(pkg, task, inputHash string) string {
	slug := pkgSlug(pkg)
	return filepath.Join(ms.root, "tasks", slug, task, inputHash+".json")
}

// Get returns the manifest for (pkg, task, inputHash), or (nil, false) on miss.
func (ms *ManifestStore) Get(pkg, task, inputHash string) (*Manifest, bool) {
	path := ms.manifestPath(pkg, task, inputHash)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, false
	}
	return &m, true
}

// Put writes a manifest to disk atomically.
func (ms *ManifestStore) Put(pkg, task string, m *Manifest) error {
	path := ms.manifestPath(pkg, task, m.InputHash)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("manifest dir: %w", err)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	// The store is shared by concurrent builds of several worktrees. Stage in
	// the store's tmp directory (same filesystem) and rename, so a reader sees
	// either the previous manifest or this one in full, never a partial write.
	stagingDir := filepath.Join(ms.root, "tmp")
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		return fmt.Errorf("manifest staging dir: %w", err)
	}
	staged, err := os.CreateTemp(stagingDir, "manifest-")
	if err != nil {
		return fmt.Errorf("manifest stage: %w", err)
	}
	stagedPath := staged.Name()
	if _, err := staged.Write(data); err != nil {
		staged.Close()
		os.Remove(stagedPath)
		return fmt.Errorf("manifest write: %w", err)
	}
	if err := staged.Close(); err != nil {
		os.Remove(stagedPath)
		return fmt.Errorf("manifest write: %w", err)
	}
	if err := os.Chmod(stagedPath, 0o644); err != nil {
		os.Remove(stagedPath)
		return fmt.Errorf("manifest mode: %w", err)
	}
	if err := os.Rename(stagedPath, path); err != nil {
		os.Remove(stagedPath)
		return fmt.Errorf("manifest commit: %w", err)
	}
	return nil
}

// pkgSlug converts a package name like "@acme/core-types" to a
// filesystem-safe string "acme__core-types".
func pkgSlug(name string) string {
	name = strings.TrimPrefix(name, "@")
	name = strings.ReplaceAll(name, "/", "__")
	return name
}
