package host

import (
	"fmt"

	"github.com/kb-labs/clikit/diag"
)

type ActiveWorkKind string

const (
	ActiveWorkWorkflow    ActiveWorkKind = "workflow"
	ActiveWorkJob         ActiveWorkKind = "job"
	ActiveWorkServiceJob  ActiveWorkKind = "service-job"
	ActiveWorkLongCommand ActiveWorkKind = "long-command"
)

type ActiveWorkItem struct {
	Kind          ActiveWorkKind `json:"kind"`
	ID            string         `json:"id"`
	OwningService string         `json:"owningService"`
}

func RestartWorkInFlight(items []ActiveWorkItem, interruptCommand string) (*diag.Diag, error) {
	if len(items) == 0 || interruptCommand == "" {
		return nil, fmt.Errorf("active-work refusal requires work items and an interrupt command")
	}
	for _, item := range items {
		if item.ID == "" || item.OwningService == "" || !validActiveWorkKind(item.Kind) {
			return nil, fmt.Errorf("active-work refusal contains an incomplete work item")
		}
	}
	return diag.FromCatalog("KB_RESTART_WORK_IN_FLIGHT", map[string]string{"interruptCommand": interruptCommand},
		diag.WithMeta(map[string]any{"items": items}))
}

func validActiveWorkKind(kind ActiveWorkKind) bool {
	switch kind {
	case ActiveWorkWorkflow, ActiveWorkJob, ActiveWorkServiceJob, ActiveWorkLongCommand:
		return true
	default:
		return false
	}
}
