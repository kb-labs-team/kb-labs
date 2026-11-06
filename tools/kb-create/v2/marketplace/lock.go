// Package marketplace writes .kb/marketplace.lock after Apply installs exact
// artifacts. core-discovery (the plugin registry consumed by REST, gateway,
// workflow and oauth at runtime) reads that lock file to know which packages
// to scan — without it, every installed plugin/adapter is physically on disk
// but invisible to the running platform.
//
// The pre-V2 launcher wrote this file via a Node.js node_modules scanner
// (internal/scan, removed in the breaking cutover). V2 does not need to
// scan anything: contracts.Artifact already carries the exact package/kind
// resolved from the sealed release index, so the lock can be derived
// directly from the plan that was just applied.
package marketplace

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/versionroot"
)

// Schema must match core-discovery's MarketplaceLock schema
// (core/discovery/src/marketplace-lock.ts) — the TS reader rejects any
// other value outright.
const Schema = "kb.marketplace/3"

type Lock struct {
	Schema   string          `json:"schema"`
	Plugins  map[string]Item `json:"plugins"`
	Adapters map[string]Item `json:"adapters,omitempty"`
}

type Item struct {
	Version           string `json:"version"`
	Integrity         string `json:"integrity"`
	ResolvedPath      string `json:"resolvedPath,omitempty"`
	Package           string `json:"package,omitempty"`
	Source            string `json:"source"`
	MarketplaceSource string `json:"marketplaceSource,omitempty"`
	SignatureStatus   string `json:"signatureStatus,omitempty"`
	Enabled           bool   `json:"enabled"`
}

// WriteLock regenerates .kb/marketplace.lock at platformRoot from the exact
// artifacts a resolved plan installed. Only "plugin" and "adapter" kinds are
// discoverable registry entities; "platform" and "binary" artifacts are
// skipped, matching what the pre-cutover scanner reported.
//
// The platform lock is machine-local: it records its platform-relative path.
// Integrity matches core-discovery's package.json hash contract, not the
// artifact tarball digest in the resolved plan.
func WriteLock(platformRoot, existingRoot string, artifacts []contracts.Artifact, now time.Time) error {
	if existingRoot == "" {
		existingRoot = platformRoot
	}
	existing, err := readLock(existingRoot)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read existing marketplace lock at %s: %w", existingRoot, err)
	}

	lock := Lock{Schema: Schema, Plugins: make(map[string]Item), Adapters: make(map[string]Item)}
	if existing != nil {
		for id, item := range existing.Plugins {
			if item.Source != "platform" {
				lock.Plugins[id] = item
			}
		}
		for id, item := range existing.Adapters {
			if item.Source != "platform" {
				lock.Adapters[id] = item
			}
		}
	}
	_ = now // retained for call-site compatibility; lock declarations have no timestamp.
	for _, a := range artifacts {
		kind := a.Kind
		if a.Registry != "" {
			kind = a.Registry
		}
		if kind != "plugin" && kind != "adapter" {
			continue
		}
		integrity, err := packageIntegrity(platformRoot, a.Package)
		if err != nil {
			return fmt.Errorf("read installed package metadata for %s: %w", a.Package, err)
		}
		enabled := true
		if existing != nil {
			prior, ok := existing.Plugins[a.ID]
			if kind == "adapter" {
				prior, ok = existing.Adapters[a.ID]
			}
			if ok {
				enabled = prior.Enabled
			}
		}
		item := Item{
			Version:      a.Version,
			Integrity:    integrity,
			ResolvedPath: "node_modules/" + a.Package,
			Source:       "platform",
			Enabled:      enabled,
		}
		if kind == "adapter" {
			lock.Adapters[a.ID] = item
		} else {
			item.Package = a.Package
			lock.Plugins[a.ID] = item
		}
	}

	if len(lock.Plugins) == 0 && len(lock.Adapters) == 0 {
		return nil
	}
	if len(lock.Adapters) == 0 {
		lock.Adapters = nil
	}

	kbDir := filepath.Join(platformRoot, ".kb")
	if err := os.MkdirAll(kbDir, 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(lock, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	target := filepath.Join(kbDir, "marketplace.lock")
	return versionroot.AtomicWriteFile(target, data, 0o600)
}

// PreserveInstalledComponents adds active platform adapter identities to a
// new update request. Marketplace plugins remain owned by Marketplace and are
// carried forward in the Marketplace lock rather than resolved by the release
// index.
func PreserveInstalledComponents(platformRoot string, request *contracts.InstallRequest) (bool, error) {
	if request == nil {
		return false, fmt.Errorf("update request is required")
	}
	lock, err := readLock(platformRoot)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read active marketplace lock: %w", err)
	}
	changed := false
	adapters := make(map[string]struct{}, len(request.Adapters))
	for _, component := range request.Adapters {
		adapters[component.ID] = struct{}{}
	}
	adapterIDs := make([]string, 0, len(lock.Adapters))
	for id := range lock.Adapters {
		adapterIDs = append(adapterIDs, id)
	}
	sort.Strings(adapterIDs)
	for _, id := range adapterIDs {
		if _, exists := adapters[id]; exists {
			continue
		}
		request.Adapters = append(request.Adapters, contracts.ComponentRequest{ID: id})
		adapters[id] = struct{}{}
		changed = true
	}
	return changed, nil
}

func packageIntegrity(platformRoot, packageName string) (string, error) {
	if packageName == "" {
		return "", fmt.Errorf("package name is required")
	}
	packageJSON, err := os.ReadFile(filepath.Join(platformRoot, "node_modules", filepath.FromSlash(packageName), "package.json"))
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(packageJSON)
	return "sha256-" + base64.StdEncoding.EncodeToString(digest[:]), nil
}

func readLock(platformRoot string) (*Lock, error) {
	// #nosec G304 -- platformRoot is caller-controlled, not user input
	data, err := os.ReadFile(filepath.Join(platformRoot, ".kb", "marketplace.lock"))
	if err != nil {
		return nil, err
	}
	var lock Lock
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, err
	}
	if lock.Schema != Schema {
		return nil, fmt.Errorf("invalid marketplace lock schema %q", lock.Schema)
	}
	for id, entry := range lock.Plugins {
		if err := validateLockItem("plugin", id, entry); err != nil {
			return nil, err
		}
	}
	for id, entry := range lock.Adapters {
		if err := validateLockItem("adapter", id, entry); err != nil {
			return nil, err
		}
	}
	return &lock, nil
}

func validateLockItem(kind, id string, item Item) error {
	switch item.Source {
	case "platform":
		if kind == "plugin" && item.Package == "" {
			return fmt.Errorf("invalid marketplace lock %s %q: platform entries require a package", kind, id)
		}
	case "marketplace":
		if item.MarketplaceSource != "registry" && item.MarketplaceSource != "npm" {
			return fmt.Errorf("invalid marketplace lock %s %q: Marketplace entries require their resolved source", kind, id)
		}
		if item.SignatureStatus != "verified" && item.SignatureStatus != "unsigned" {
			return fmt.Errorf("invalid marketplace lock %s %q: Marketplace entries require signature status", kind, id)
		}
	case "local":
		if item.ResolvedPath == "" {
			return fmt.Errorf("invalid marketplace lock %s %q: local entries require a resolved path", kind, id)
		}
	default:
		return fmt.Errorf("invalid marketplace lock %s %q: unknown source %q", kind, id, item.Source)
	}
	return nil
}
