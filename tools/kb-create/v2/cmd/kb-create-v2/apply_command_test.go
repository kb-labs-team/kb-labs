package v2cli

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
)

// case: PC-001.2
func TestApplyDossierKeepsPackageManagerFailureDetails(t *testing.T) {
	const secret = "synthetic-secret-sentinel"
	root := t.TempDir()
	logPath := root + "/installer/logs/apply-test.log"
	failure := contracts.NewDiag(contracts.CodeApplyFailed, "package manager failed", "inspect the local log",
		errors.New("pnpm add failed with value "+secret))
	failure.Meta = map[string]any{
		"packageManagerExitCode":   "47",
		"packageManagerStderrTail": strings.Repeat("x", 4090) + "TOKEN=" + secret + strings.Repeat("y", 4096-12),
	}

	result := applyDossier(root, "package-manager-failure", logPath, contracts.ResolvedInstallPlan{}, []string{secret}, failure)
	stderrTail := result.Meta["packageManagerStderrTail"].(string)
	if result.Code != contracts.CodeApplyFailed || result.Meta["packageManagerExitCode"] != "47" ||
		len(stderrTail) > 4096 || !strings.Contains(stderrTail, "[REDACTED]") ||
		strings.Contains(stderrTail, secret) || result.Meta["logPath"] != logPath {
		t.Fatalf("apply diagnostic = code %q details %#v", result.Code, result.Meta)
	}
	if strings.Contains(result.Cause, secret) || strings.Contains(result.Reason, secret) ||
		result.Cause != "pnpm add failed with value [REDACTED]" || result.Reason != result.Cause {
		t.Fatalf("apply cause was not value-redacted: cause=%q reason=%q", result.Cause, result.Reason)
	}
	envelope, err := diag.ToEnvelope(result)
	if err != nil {
		t.Fatal(err)
	}
	output, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), secret) || strings.Contains(envelope.Cause, secret) {
		t.Fatalf("CLI error envelope leaked synthetic secret: %s", output)
	}
	diagnosticPath, ok := result.Meta["diagnosticPath"].(string)
	if !ok {
		t.Fatalf("apply diagnostic omitted dossier path: %#v", result.Meta)
	}
	data, err := os.ReadFile(diagnosticPath)
	if err != nil {
		t.Fatal(err)
	}
	var dossier diagnostics.Dossier
	if err := json.Unmarshal(data, &dossier); err != nil {
		t.Fatal(err)
	}
	dossierTail, ok := dossier.Error.Meta["packageManagerStderrTail"].(string)
	if dossier.Error.Meta["packageManagerExitCode"] != "47" || !ok ||
		len(dossierTail) > 4096 || !strings.Contains(dossierTail, "[REDACTED]") || strings.Contains(dossierTail, secret) ||
		strings.Contains(dossier.Error.Cause, secret) || strings.Contains(string(data), secret) {
		t.Fatalf("dossier dropped or leaked package-manager details: %#v", dossier.Error.Meta)
	}
}
