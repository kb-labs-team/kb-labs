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
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

// Schema must match core-discovery's MarketplaceLock schema
// (core/discovery/src/marketplace-lock.ts) — the TS reader rejects any
// other value outright.
const Schema = "kb.marketplace/2"

type Lock struct {
	Schema    string          `json:"schema"`
	Installed map[string]Item `json:"installed"`
}

type Item struct {
	Version      string   `json:"version"`
	Integrity    string   `json:"integrity"`
	ResolvedPath string   `json:"resolvedPath"`
	InstalledAt  string   `json:"installedAt"`
	Source       string   `json:"source"`
	PrimaryKind  string   `json:"primaryKind"`
	Provides     []string `json:"provides"`
	Enabled      bool     `json:"enabled"`
}

// WriteLock regenerates .kb/marketplace.lock at platformRoot from the exact
// artifacts a resolved plan installed. Only "plugin" and "adapter" kinds are
// discoverable registry entities; "platform" and "binary" artifacts are
// skipped, matching what the pre-cutover scanner reported.
//
// Entries carry no integrity hash. core-discovery only verifies it when
// non-empty (core/discovery/src/discovery-manager.ts), and every V2 artifact
// is already integrity-checked at resolve time against the sealed release
// index's SHA256 — re-asserting a second, differently-shaped hash here would
// just duplicate a check already done upstream.
//
// `provides` is set to the artifact's own kind. core-discovery does not
// actually read this field for routing: it re-derives the real entity kinds
// (cli-command, rest-route, ws-channel, ...) by loading each plugin's own
// manifest at scan time (extractEntityKinds in discovery-manager.ts). The
// lock only needs to name which packages exist and where.
func WriteLock(platformRoot string, artifacts []contracts.Artifact, now time.Time) error {
	existing, _ := readLock(platformRoot) // best-effort: preserve `enabled` across re-applies

	lock := Lock{Schema: Schema, Installed: make(map[string]Item)}
	installedAt := now.UTC().Format(time.RFC3339)
	for _, a := range artifacts {
		if a.Kind != "plugin" && a.Kind != "adapter" {
			continue
		}
		enabled := true
		if existing != nil {
			if prior, ok := existing.Installed[a.ID]; ok {
				enabled = prior.Enabled
			}
		}
		lock.Installed[a.ID] = Item{
			Version:      a.Version,
			ResolvedPath: "node_modules/" + a.Package,
			InstalledAt:  installedAt,
			Source:       "marketplace",
			PrimaryKind:  a.Kind,
			Provides:     []string{a.Kind},
			Enabled:      enabled,
		}
	}

	if len(lock.Installed) == 0 {
		return nil
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
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, target)
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
	return &lock, nil
}
