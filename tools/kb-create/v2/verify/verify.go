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
	return RunWithConfigRoot(plan, now, plan.Request.PlatformRoot)
}

// RunWithConfigRoot verifies the staged plan against an explicitly selected
// immutable or shared config view without creating a writable state link in
// the staged version root.
func RunWithConfigRoot(plan contracts.ResolvedInstallPlan, now time.Time, configRoot string) (contracts.Verification, error) {
	if plan.ServiceGraph.Profile == "client" {
		if plan.Host != nil || len(plan.ServiceGraph.Services) != 0 {
			return contracts.Verification{}, contracts.HostSpecDiagnostic("The client profile must not declare a host or services.", "Use the client service profile from the release index.", "the client profile declares host services", nil)
		}
		if _, err := os.Stat(filepath.Join(configRoot, ".kb", "kb.config.jsonc")); !os.IsNotExist(err) {
			return contracts.Verification{}, fmt.Errorf("client profile must not write runtime config")
		}
		return contracts.Verification{ReadinessCheckedAt: now.UTC()}, nil
	}
	config, err := os.ReadFile(filepath.Join(configRoot, ".kb", "kb.config.jsonc"))
	if err != nil {
		return contracts.Verification{}, fmt.Errorf("read runtime config: %w", err)
	}
	if plan.Host == nil {
		return contracts.Verification{}, contracts.HostSpecDiagnostic("The resolved plan declares no host.", "Reinstall the platform with \"kb-create apply\".", "the resolved plan declares no host", nil)
	}
	if err := plan.Host.Validate(); err != nil {
		return contracts.Verification{}, contracts.HostSpecDiagnostic("The host specification is invalid: "+err.Error()+".", "Reinstall the platform with \"kb-create apply\".", err.Error(), err)
	}
	return contracts.Verification{ConfigSHA256: digest(config), HostHealthURL: plan.Host.HealthURL, ReadinessCheckedAt: now.UTC()}, nil
}

func digest(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
