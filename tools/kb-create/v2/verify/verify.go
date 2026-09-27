// Package verify checks the invariants of an installation on disk before a
// receipt is committed: the generated runtime configuration exists and the plan
// carries a host the launcher can run. Whether that host actually starts is
// proven separately by a trial run (runtime.HostProbe), because it needs a
// process, not a file.
package verify

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kb-labs/create/v2/contracts"
)

// Run reads the generated runtime config and validates the plan's host.
func Run(plan contracts.ResolvedInstallPlan, now time.Time) (contracts.Verification, error) {
	config, err := os.ReadFile(filepath.Join(plan.Request.PlatformRoot, ".kb", "kb.config.jsonc"))
	if err != nil {
		return contracts.Verification{}, fmt.Errorf("read runtime config: %w", err)
	}
	if plan.Host == nil {
		return contracts.Verification{}, contracts.NewLauncherError(contracts.CodeHostSpecInvalid, "The resolved plan declares no host.", "Reinstall the platform with \"kb-create apply\".", nil)
	}
	if err := plan.Host.Validate(); err != nil {
		return contracts.Verification{}, contracts.NewLauncherError(contracts.CodeHostSpecInvalid, "The host specification is invalid: "+err.Error()+".", "Reinstall the platform with \"kb-create apply\".", err)
	}
	return contracts.Verification{ConfigSHA256: digest(config), HostHealthURL: plan.Host.HealthURL, ReadinessCheckedAt: now.UTC()}, nil
}

func digest(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
