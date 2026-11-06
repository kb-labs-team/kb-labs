package diagnostics

import (
	"github.com/kb-labs/clikit/diag"
	"os"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func TestWriteRedactsEveryAttachableField(t *testing.T) {
	root := t.TempDir()
	path, err := Write(root, Dossier{CorrelationID: "c1", Stage: contracts.StageApply, Error: diag.New("KB_INSTALL_INPUT_REQUIRED", "input missing", diag.WithReason("token=secret"), diag.WithMeta(map[string]any{"registry": "https://secret@registry"})), Journal: []string{"secret"}, Logs: []string{"key secret"}}, []string{"secret"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "secret") || !strings.Contains(string(data), "[REDACTED]") {
		t.Fatalf("dossier leaked secret: %s", data)
	}
}

func TestWriteRequiresCorrelationID(t *testing.T) {
	if _, err := Write(t.TempDir(), Dossier{}, nil); err == nil {
		t.Fatal("expected correlation validation")
	}
}

func TestWriteRedactsCredentialFormInPackageManagerTail(t *testing.T) {
	const secret = "diagnostic-sentinel-credential"
	failure := diag.New("KB_INSTALL_APPLY_FAILED", "package manager failed", diag.WithMeta(map[string]any{
		"packageManagerStderrTail": "API_TOKEN=" + secret,
	}))
	path, err := Write(t.TempDir(), Dossier{CorrelationID: "failure", Error: failure}, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), secret) || !strings.Contains(string(data), "[REDACTED]") {
		t.Fatalf("dossier did not redact credential in package-manager tail: %s", data)
	}
}
