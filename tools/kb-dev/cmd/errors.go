package cmd

import (
	"github.com/kb-labs/clikit/diag"
)

func commandFailure(command string) error {
	return diag.New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.",
		diag.WithMeta(map[string]any{"command": command}))
}

func commandFailureWithData(command string, data any) error {
	return diag.New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.",
		diag.WithMeta(map[string]any{"command": command}), diag.WithData(data))
}
