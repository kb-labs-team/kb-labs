package cmd

import (
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/dev/internal/manager"
)

func commandFailure(command string) error {
	return diag.New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.",
		diag.WithMeta(map[string]any{"command": command}))
}

type serviceFailureAction struct {
	Service string `json:"service"`
	Action  string `json:"action"`
	Error   string `json:"error,omitempty"`
}

type serviceFailureData struct {
	Actions []serviceFailureAction `json:"actions,omitempty"`
	Hint    string                 `json:"hint,omitempty"`
}

// serviceCommandFailure retains manager-owned failure causes while excluding
// raw process logs, which may contain credentials or other sensitive output.
func serviceCommandFailure(command string, result *manager.Result) error {
	data := serviceFailureData{}
	var reasons []string
	if result != nil {
		data.Hint = diag.RedactText(result.Hint)
		for _, action := range result.Actions {
			if action.Action != "failed" {
				continue
			}
			errText := diag.RedactText(action.Error)
			data.Actions = append(data.Actions, serviceFailureAction{
				Service: action.Service,
				Action:  action.Action,
				Error:   errText,
			})
			reasons = append(reasons, action.Service+": "+errText)
		}
	}

	opts := []diag.Opt{
		diag.WithMeta(map[string]any{"command": command}),
		diag.WithData(data),
	}
	if len(reasons) > 0 {
		opts = append(opts, diag.WithCauseAndReason(strings.Join(reasons, "; ")))
	}
	if data.Hint != "" {
		opts = append(opts, diag.WithHint(data.Hint))
	}
	return diag.New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.", opts...)
}
