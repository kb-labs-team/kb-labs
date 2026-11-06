package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/devkit/internal/checks"
	"github.com/kb-labs/devkit/internal/launchrail"
)

type input struct {
	WorkspaceRoot string `json:"workspaceRoot"`
	Check         string `json:"check"`
}

func main() {
	command.Exit(run(os.Stdin, os.Stderr))
}

func nextCommand(check string) string {
	if check == "" {
		return "Run `kb-devkit check` from the workspace root."
	}
	return fmt.Sprintf("Run `kb-devkit check --only %s` from the workspace root.", check)
}

func run(stdin io.Reader, stderr io.Writer) diag.ExitStatus {
	var request input
	if err := json.NewDecoder(stdin).Decode(&request); err != nil {
		d := diag.FromError(fmt.Errorf("read DevKit workspace check input: %w", err))
		d.Message = "The process launcher check could not read its workspace input."
		d.Hint = nextCommand(request.Check)
		return result.RenderDiag(stderr, stderr, d, result.ModeHuman)
	}
	if request.WorkspaceRoot == "" {
		d := diag.FromError(fmt.Errorf("workspace root is missing"))
		d.Message = "The process launcher check did not receive a workspace root."
		d.Hint = nextCommand(request.Check)
		return result.RenderDiag(stderr, stderr, d, result.ModeHuman)
	}
	findings, err := launchrail.Check(request.WorkspaceRoot)
	if err != nil {
		d := diag.FromError(fmt.Errorf("scan workspace Go files for process setup: %w", err))
		d.Message = "The process launcher check could not scan the workspace Go files."
		d.Hint = nextCommand(request.Check) + " Then fix the reported Go syntax error."
		return result.RenderDiag(stderr, stderr, d, result.ModeHuman)
	}
	issues := make([]checks.Issue, 0, len(findings))
	for _, finding := range findings {
		issues = append(issues, checks.Issue{
			Check: request.Check, Severity: checks.SeverityError,
			Message: fmt.Sprintf("OS process setup %s belongs in %s", finding.Name, strings.Join(launchrail.Owners(), " or ")),
			File:    finding.File, Line: finding.Line,
		})
	}
	if err := checks.WriteExternalCheckOutput(issues); err != nil {
		d := diag.FromError(fmt.Errorf("write process launcher check result: %w", err))
		d.Message = "The process launcher check could not write its result."
		d.Hint = nextCommand(request.Check)
		return result.RenderDiag(stderr, stderr, d, result.ModeHuman)
	}
	return diag.SuccessStatus()
}
