package v2cli

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/versionroot"
)

func pendingRestart(active contracts.InstallReceipt, running host.Status, root string) *contracts.PendingRestart {
	if running.State != host.StateRunning || running.ReceiptID == "" {
		return nil
	}
	activeRoot := ""
	if layout, err := versionroot.ForPlatformPath(root); err == nil {
		activeRoot, _ = layout.Active()
	}
	generationChanged := running.TreeRoot != "" && activeRoot != "" &&
		filepath.Clean(running.TreeRoot) != filepath.Clean(activeRoot)
	if active.ID == running.ReceiptID && !generationChanged {
		return nil
	}
	version := active.Plan.ServiceGraph.PlatformVersion
	services := make([]contracts.PendingRestartService, 0, len(running.ServiceIDs))
	for _, id := range running.ServiceIDs {
		services = append(services, contracts.PendingRestartService{ID: id, RunningVersion: running.PlatformVersion})
	}
	pending := &contracts.PendingRestart{Services: services, InstalledVersion: version,
		Command: contracts.ShellCommand("kb-create", "restart", "--platform-root", root)}
	if generationChanged && active.ID == running.ReceiptID {
		pending.InstalledGeneration = filepath.Base(activeRoot)
		pending.RunningGeneration = filepath.Base(running.TreeRoot)
	}
	return pending
}

func renderPendingRestart(pending *contracts.PendingRestart) string {
	if pending == nil {
		return ""
	}
	services := make([]string, 0, len(pending.Services))
	for _, service := range pending.Services {
		services = append(services, fmt.Sprintf("%s (running %s)", service.ID, service.RunningVersion))
	}
	if pending.InstalledGeneration != "" {
		return fmt.Sprintf("Pending restart: %s; installed %s (generation %s; running generation %s). Run %s",
			strings.Join(services, ", "), pending.InstalledVersion, pending.InstalledGeneration,
			pending.RunningGeneration, pending.Command)
	}
	return fmt.Sprintf("Pending restart: %s; installed %s. Run %s", strings.Join(services, ", "), pending.InstalledVersion, pending.Command)
}

func pendingRestartValue(value any) *contracts.PendingRestart {
	pending, _ := value.(*contracts.PendingRestart)
	return pending
}
