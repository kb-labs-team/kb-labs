// Package runner executes custom checkers as shell commands.
// Contract: $1 = package dir, exit 0 = pass, exit 1 = fail,
// stdout may contain JSON []Issue (optional).
package runner

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/devkit/internal/checks"
)

// RunCustom executes a custom checker script for the given package directory.
// Returns any issues parsed from stdout, plus an error issue on failure.
func RunCustom(script, pkgDir string) ([]checks.Issue, error) {
	result, err := toolchain.Run(context.Background(), toolchain.Invocation{Tool: "sh", Executable: "sh", Args: []string{"-c", script + " " + pkgDir}, Dir: pkgDir, Operation: toolchain.OperationWorkspaceTask})

	// Try to parse stdout as JSON issues regardless of exit code.
	var issues []checks.Issue
	if result.Stdout != "" {
		if jsonErr := json.Unmarshal([]byte(result.Stdout), &issues); jsonErr != nil {
			// stdout is not JSON — treat as human-readable output.
		}
	}

	if err != nil {
		// Non-zero exit: add a synthetic error issue.
		msg := fmt.Sprintf("custom check %q failed: %v", script, err)
		if result.Stderr != "" {
			msg += "\n" + result.Stderr
		}
		issues = append(issues, checks.Issue{
			Check:    "custom:" + script,
			Severity: checks.SeverityError,
			Message:  msg,
		})
	}

	return issues, nil
}
