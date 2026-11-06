package v2cli

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
)

// case: PC-001.2
func TestApplyDossierKeepsPackageManagerFailureDetails(t *testing.T) {
	const secret = "registry-token-value"
	root := t.TempDir()
	logPath := root + "/installer/logs/apply-test.log"
	failure := contracts.NewDiag(contracts.CodeApplyFailed, "package manager failed", "inspect the local log",
		errors.New("pnpm add exact artifacts: exit status 47"))
	failure.Meta = map[string]any{
		"packageManagerExitCode":   "47",
		"packageManagerStderrTail": "registry request used " + secret,
	}

	result := applyDossier(root, "package-manager-failure", logPath, contracts.ResolvedInstallPlan{}, []string{secret}, failure)
	if result.Code != contracts.CodeApplyFailed || result.Meta["packageManagerExitCode"] != "47" ||
		result.Meta["packageManagerStderrTail"] != "registry request used [REDACTED]" || result.Meta["logPath"] != logPath {
		t.Fatalf("apply diagnostic = code %q details %#v", result.Code, result.Meta)
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
	if dossier.Error.Meta["packageManagerExitCode"] != "47" ||
		dossier.Error.Meta["packageManagerStderrTail"] != "registry request used [REDACTED]" {
		t.Fatalf("dossier dropped or leaked package-manager details: %#v", dossier.Error.Meta)
	}
}
