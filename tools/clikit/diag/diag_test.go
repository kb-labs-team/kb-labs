package diag

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestNewUsesCatalogHint(t *testing.T) {
	d := New("KB_RUNTIME_INPUT_INVALID", "The provided input is invalid.")
	entry, ok := LookupCatalog(d.Code)
	if !ok || d.Hint != entry.Hint {
		t.Fatalf("diagnostic = %+v, want the platform catalog hint", d)
	}
}

// case: S-224.2
func TestCorrelationIDFormat(t *testing.T) {
	id := NewCorrelationID()
	if !IsValidCorrelationID(id) {
		t.Fatalf("generated correlation ID %q does not use the platform format", id)
	}
	for _, invalid := range []string{"corr-short", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcdef0"} {
		if IsValidCorrelationID(invalid) {
			t.Errorf("IsValidCorrelationID(%q) = true, want false", invalid)
		}
	}
}

func TestWithHintSurvivesBoundaryNormalization(t *testing.T) {
	const want = "Use GET /v1/status, POST /v1/host/restart or POST /v1/update-request."
	d := FromErrorWithLogger(New("KB_RUNTIME_INPUT_INVALID", "Unknown control endpoint.", WithHint(want)), slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil)))
	if d.Hint != want {
		t.Fatalf("normalized hint = %q, want the specific next step %q", d.Hint, want)
	}
}

func TestDiagnosticCauseAndReasonRedactCredentialShapes(t *testing.T) {
	for _, secret := range []string{
		"request failed token=ghp_123456789abcdef",
		"connect https://deploy-user:super-secret@registry.example.test/v1",
		"GATEWAY_INTERNAL_SECRET=live-secret-value",
	} {
		d := New("KB_RUNTIME_INPUT_INVALID", "Request failed.", WithCause(secret), WithReason(secret))
		for field, value := range map[string]string{"cause": d.Cause, "reason": d.Reason} {
			if strings.Contains(value, "ghp_123456789abcdef") || strings.Contains(value, "super-secret") || strings.Contains(value, "live-secret-value") {
				t.Errorf("%s retained secret from %q: %q", field, secret, value)
			}
			if !strings.Contains(value, "[REDACTED]") {
				t.Errorf("%s was not redacted: %q", field, value)
			}
		}
	}
}

func TestDiagnosticJSONUsesCanonicalEnvelopeAndAcceptsNoPrivateShape(t *testing.T) {
	const hint = "Use GET /v1/status, POST /v1/host/restart or POST /v1/update-request."
	original := New("KB_RUNTIME_INPUT_INVALID", "Unknown control endpoint.", WithHint(hint), WithCause("safe detail"), WithCorrelationID("corr-test"))
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"code", "area", "stage", "severity", "retryable", "message", "hint", "cause", "correlationId"} {
		if _, exists := fields[field]; !exists {
			t.Errorf("canonical field %q missing from %s", field, data)
		}
	}
	var decoded Diag
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("canonical envelope did not decode: %v", err)
	}
	entry, _ := LookupCatalog("KB_RUNTIME_INPUT_INVALID")
	if decoded.Hint != entry.Hint || decoded.Cause != "safe detail" || decoded.CorrelationID != "corr-test" {
		t.Fatalf("decoded diagnostic = %+v", decoded)
	}
	if err := json.Unmarshal([]byte(`{"code":"KB_RUNTIME_INPUT_INVALID","message":"old private shape","reason":"old","meta":{}}`), &decoded); err == nil {
		t.Fatal("private diagnostic JSON shape was accepted")
	}
}

func TestDiagnosticJSONReconstructsCatalogTextFromDetails(t *testing.T) {
	var decoded Diag
	body := []byte(`{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"remote text","hint":"remote hint","details":{"permission":"plugins:manage"}}`)
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode catalog diagnostic: %v", err)
	}
	encoded, err := json.Marshal(&decoded)
	if err != nil {
		t.Fatalf("render reconstructed diagnostic: %v", err)
	}
	if strings.Contains(string(encoded), "remote text") || strings.Contains(string(encoded), "remote hint") || !strings.Contains(string(encoded), "plugins:manage") {
		t.Fatalf("reconstructed diagnostic = %s", encoded)
	}
	if err := json.Unmarshal([]byte(`{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"remote text","hint":"remote hint"}`), &decoded); err != nil {
		t.Fatalf("invalid remote catalog diagnostic should become a typed protocol diagnostic: %v", err)
	}
	if decoded.Code != "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE" || decoded.Meta["remoteCode"] != "KB_AUTH_FORBIDDEN" || decoded.Meta["fields"] != "permission" {
		t.Fatalf("invalid remote diagnostic = %+v, want protocol failure with missing permission", decoded)
	}
}

func TestDiagnosticJSONPreservesCatalogDeclaredRecoveryDetails(t *testing.T) {
	original := New("KB_UPDATE_HOST_NOT_HEALTHY", "The update recovery did not complete.",
		WithMeta(map[string]any{
			"version": "1.2.3", "recoveryStage": "restore last healthy root",
			"nextCommand":   "kb-create doctor --platform-root '/tmp/KB Labs'",
			"failureReason": "restore failed",
		}))
	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal recovery diagnostic: %v", err)
	}
	var decoded Diag
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode recovery diagnostic: %v", err)
	}
	for key, want := range map[string]string{
		"version": "1.2.3", "recoveryStage": "restore last healthy root",
		"nextCommand": "kb-create doctor --platform-root '/tmp/KB Labs'", "failureReason": "restore failed",
	} {
		if got := decoded.Meta[key]; got != want {
			t.Errorf("decoded detail %q = %v, want %q", key, got, want)
		}
	}
}

func TestDiagnosticJSONRequiresAndRendersRunningHostNextCommand(t *testing.T) {
	const command = "kb-create stop --platform-root '/tmp/KB Labs'"
	original, err := FromCatalog("KB_HOST_ALREADY_RUNNING", map[string]string{"nextCommand": command})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Diag
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode running-host diagnostic: %v", err)
	}
	entry, _ := LookupCatalog("KB_HOST_ALREADY_RUNNING")
	wantHint := renderTemplate(entry.Hint, map[string]string{"nextCommand": command}, map[string]struct{}{"nextCommand": {}})
	if decoded.Hint != wantHint {
		t.Fatalf("decoded hint = %q, want %q", decoded.Hint, wantHint)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "details")
	missing, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(missing, &decoded); err != nil {
		t.Fatalf("invalid running-host envelope should become a typed protocol diagnostic: %v", err)
	}
	if decoded.Code != "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE" || decoded.Meta["remoteCode"] != "KB_HOST_ALREADY_RUNNING" || decoded.Meta["fields"] != "nextCommand" {
		t.Fatalf("invalid running-host diagnostic = %+v", decoded)
	}
}

func TestFromErrorLogsRawDetailsAndReturnsSafeCorrelatedDiag(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	d := FromErrorWithLogger(errors.New("secret internal failure"), logger)
	if d.Code != "KB_RUNTIME_UNEXPECTED" || d.CorrelationID == "" {
		t.Fatalf("diag = %+v, want unexpected code and correlation ID", d)
	}
	if strings.Contains(d.Message, "secret internal failure") {
		t.Fatalf("user-facing message leaked raw error: %q", d.Message)
	}
	for _, part := range []string{d.CorrelationID, "secret internal failure", "stack"} {
		if !strings.Contains(logs.String(), part) {
			t.Errorf("structured log missing %q: %s", part, logs.String())
		}
	}
}

func TestUncataloguedTypedFailureBecomesUnexpectedAtBoundary(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	d := FromErrorWithLogger(New("KB_RUNTIME_UNREGISTERED", "This code is missing from the catalog."), logger)
	if d.Code != "KB_RUNTIME_UNEXPECTED" || d.CorrelationID == "" {
		t.Fatalf("diag = %+v, want unexpected code and correlation ID", d)
	}
	if !strings.Contains(logs.String(), "correlationId") || !strings.Contains(logs.String(), "stack") {
		t.Fatalf("uncatalogued typed error was not logged with correlation and stack: %s", logs.String())
	}
}

func TestWrap_UnwrapChain(t *testing.T) {
	cause := errors.New("root cause")
	d := Wrap(cause, "KB_RUNTIME_UNEXPECTED", "The operation failed.", WithMeta(map[string]any{"k": "v"}))
	if !errors.Is(d, cause) {
		t.Error("errors.Is should find the wrapped cause")
	}
	if d.Meta["k"] != "v" {
		t.Errorf("meta = %v", d.Meta)
	}
}

func TestExitCodeUsesSharedTable(t *testing.T) {
	cases := []struct {
		name string
		d    *Diag
		want ExitStatus
	}{
		{"nil", nil, SuccessStatus()},
		{"invalid input", New("KB_RUNTIME_INPUT_INVALID", "invalid"), inputRefusalStatus()},
		{"operation failure", New("KB_RUNTIME_UNEXPECTED", "failed"), operationFailureStatus()},
	}
	for _, c := range cases {
		if got := ExitCode(c.d); got != c.want {
			t.Errorf("%s: ExitCode = %d, want %d", c.name, got.Code(), c.want.Code())
		}
	}
}

func TestProcessExitStatusPreservesPortableProcessCodes(t *testing.T) {
	for _, code := range []int{0, 1, 2, 3, 7, 128, 255} {
		status := ProcessExitStatus(code)
		if !status.IsSelected() || status.Code() != code {
			t.Errorf("ProcessExitStatus(%d) = selected %t, code %d", code, status.IsSelected(), status.Code())
		}
	}
	for _, code := range []int{-1, 256} {
		if got := ProcessExitStatus(code); got.Code() != 1 {
			t.Errorf("ProcessExitStatus(%d) = %d, want operation failure 1", code, got.Code())
		}
	}
}

func TestEveryCatalogEntryDeclaresCanonicalExitClass(t *testing.T) {
	for code, entry := range catalogEntries {
		want := operationFailureStatus()
		if entry.ProcessExitClass == ExitClassInputRefusal {
			want = inputRefusalStatus()
		} else if entry.ProcessExitClass != ExitClassOperationFailure {
			t.Errorf("%s has invalid exit class %q", code, entry.ProcessExitClass)
			continue
		}
		if got := ExitCode(New(code, "failure")); got != want {
			t.Errorf("ExitCode(%s) = %d, want %d from %s", code, got.Code(), want.Code(), entry.ProcessExitClass)
		}
	}
}

func TestDiag_AsError(t *testing.T) {
	var err error = New("KB_RUNTIME_INPUT_INVALID", "invalid")
	var d *Diag
	if !errors.As(err, &d) {
		t.Fatal("errors.As should extract *Diag")
	}
	if d.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Errorf("code = %q", d.Code)
	}
}
