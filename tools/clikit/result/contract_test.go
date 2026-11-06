package result

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
)

// ValidateFixture checks the shared fixtures using the same envelope shape
// that Render emits. The shared JSON Schema remains the canonical contract.
func TestSharedFixturesAndSchema(t *testing.T) {
	for _, path := range []string{
		"../../../core/platform/contracts/ux-result/fixtures/valid/success.json",
		"../../../core/platform/contracts/ux-result/fixtures/valid/failure.json",
	} {
		if err := ValidateFixture(path); err != nil {
			t.Errorf("fixture %s: %v", path, err)
		}
	}
	var schema struct {
		OneOf []json.RawMessage `json:"oneOf"`
	}
	b, err := os.ReadFile("../../../core/platform/contracts/ux-result/machine-result.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &schema); err != nil {
		t.Fatal(err)
	}
	if len(schema.OneOf) != 2 {
		t.Fatalf("shared schema has %d result branches, want success and failure", len(schema.OneOf))
	}
}

// case: S-203.1
func TestDecodeSuccessResultRequiresTheSharedEnvelope(t *testing.T) {
	var payload struct {
		Status string `json:"status"`
	}
	if err := DecodeSuccessResult([]byte(`{"ok":true,"data":{"status":"healthy"}}`), &payload); err != nil {
		t.Fatalf("DecodeSuccessResult(valid envelope): %v", err)
	}
	if payload.Status != "healthy" {
		t.Fatalf("payload status = %q, want healthy", payload.Status)
	}
	for _, body := range []string{
		`{"status":"healthy"}`,
		`{"ok":false,"error":{}}`,
	} {
		if err := DecodeSuccessResult([]byte(body), &payload); err == nil {
			t.Errorf("DecodeSuccessResult(%s) succeeded, want envelope error", body)
		}
	}
}

// case: S-224.2
func TestDecodeResultReturnsCataloguedFailureEnvelope(t *testing.T) {
	const gatewayCorrelationID = "0123456789abcdef0123456789abcdef"
	body := []byte(`{"ok":false,"error":{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"Gateway auth health is unavailable.","hint":"Run kb-create doctor --platform-root <root>.","correlationId":"` + gatewayCorrelationID + `","details":{"permission":"plugins:manage"}}}`)
	var payload struct {
		Status string `json:"status"`
	}
	failure, err := DecodeResult(body, &payload)
	if err != nil {
		t.Fatalf("DecodeResult(failure): %v", err)
	}
	expected, err := diag.FromCatalog("KB_AUTH_FORBIDDEN", map[string]string{"permission": "plugins:manage"})
	if err != nil {
		t.Fatal(err)
	}
	if failure == nil || failure.Code != expected.Code || failure.Message != expected.Message || failure.Hint != expected.Hint {
		t.Fatalf("failure = %#v, want contract-checked catalogued Gateway diagnostic", failure)
	}
	if failure.Meta["remoteCorrelationId"] != gatewayCorrelationID {
		t.Fatalf("remote correlation id = %#v, want %q", failure.Meta["remoteCorrelationId"], gatewayCorrelationID)
	}
}

// case: S-224.2
func TestDecodeResultWithContextDropsRemoteTextAndRejectsUnknownCodes(t *testing.T) {
	const password = "remote-password-marker"
	const token = "remote-token-marker"
	const gatewayCorrelationID = "fedcba9876543210fedcba9876543210"
	body := []byte(`{"ok":false,"error":{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"` + password + ` ` + token + `","hint":"` + token + ` ` + password + `","cause":"` + password + `","correlationId":"` + gatewayCorrelationID + `","details":{"permission":"plugins:manage"}}}`)
	var payload struct{}
	failure, err := DecodeResultWithContext(body, &payload, RemoteFailureContext{RequestStage: "register", HTTPStatus: 403})
	if err != nil {
		t.Fatalf("DecodeResultWithContext: %v", err)
	}
	if failure == nil || failure.Code != "KB_AUTH_FORBIDDEN" || failure.Meta["requestStage"] != "register" || failure.Meta["httpStatus"] != 403 {
		t.Fatalf("failure context = %#v", failure)
	}
	if failure.Meta["remoteCorrelationId"] != gatewayCorrelationID {
		t.Fatalf("remote correlation id = %#v, want %q", failure.Meta["remoteCorrelationId"], gatewayCorrelationID)
	}
	encoded, err := json.Marshal(failure)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{password, token} {
		if bytes.Contains(encoded, []byte(secret)) || bytes.Contains([]byte(failure.Message), []byte(secret)) || bytes.Contains([]byte(failure.Hint), []byte(secret)) {
			t.Fatalf("remote secret survived in reconstructed diagnostic: %s", encoded)
		}
	}
	if !bytes.Contains(encoded, []byte("Permission denied: plugins:manage")) || bytes.Contains(encoded, []byte("{permission}")) {
		t.Fatalf("catalog message did not render the remote template value: %s", encoded)
	}
	for _, details := range []string{`{}`, `{"permission":"  "}`} {
		invalid := []byte(`{"ok":false,"error":{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"remote","hint":"remote","correlationId":"` + gatewayCorrelationID + `","details":` + details + `}}`)
		broken, decodeErr := DecodeResultWithContext(invalid, &payload, RemoteFailureContext{})
		if decodeErr != nil || broken == nil || broken.Code != "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE" {
			t.Fatalf("missing or invalid remote template values = (%#v, %v)", broken, decodeErr)
		}
		if broken.Meta["remoteCode"] != "KB_AUTH_FORBIDDEN" {
			t.Fatalf("protocol diagnostic lost received code: %#v", broken.Meta)
		}
		if _, marshalErr := json.Marshal(broken); marshalErr != nil {
			t.Fatalf("protocol diagnostic failed to render: %v", marshalErr)
		}
	}
	undeclared := []byte(`{"ok":false,"error":{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"remote","hint":"remote","correlationId":"` + gatewayCorrelationID + `","details":{"permission":"plugins:manage","leak":"` + token + `"}}}`)
	broken, decodeErr := DecodeResultWithContext(undeclared, &payload, RemoteFailureContext{})
	if decodeErr != nil || broken == nil || broken.Code != "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE" ||
		broken.Meta["remoteCode"] != "KB_AUTH_FORBIDDEN" || broken.Meta["fields"] != "leak" {
		t.Fatalf("undeclared remote details = (%#v, %v), want protocol failure preserving code and field", broken, decodeErr)
	}
	unknown := []byte(`{"ok":false,"error":{"code":"KB_REMOTE_UNRECOGNIZED","area":"runtime","stage":"run","severity":"error","retryable":false,"message":"` + password + `","hint":"` + token + `","correlationId":"remote"}}`)
	failure, err = DecodeResultWithContext(unknown, &payload, RemoteFailureContext{RequestStage: "login", HTTPStatus: 401})
	if err != nil || failure == nil || failure.Code != "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE" || failure.Meta["requestStage"] != "login" || failure.Meta["httpStatus"] != 401 {
		t.Fatalf("unknown remote failure = (%#v, %v)", failure, err)
	}
	encoded, _ = json.Marshal(failure)
	if bytes.Contains(encoded, []byte(password)) || bytes.Contains(encoded, []byte(token)) {
		t.Fatalf("unknown remote failure leaked response text: %s", encoded)
	}
}

// case: S-203.2
func TestDecodeResultPreservesCataloguedStructuredDetails(t *testing.T) {
	body := []byte(`{"ok":false,"error":{"code":"KB_AUTH_SESSION_REVOKED","area":"auth","stage":"run","severity":"error","retryable":false,"message":"remote message","hint":"remote hint","correlationId":"0123456789abcdef0123456789abcdef","details":{"gatewayUrl":"https://gateway.test","reason":"revoked"}}}`)
	var payload struct{}
	failure, err := DecodeResult(body, &payload)
	if err != nil || failure == nil {
		t.Fatalf("DecodeResult = (%#v, %v)", failure, err)
	}
	if failure.Code != "KB_AUTH_SESSION_REVOKED" || failure.Meta["reason"] != "revoked" || failure.Meta["gatewayUrl"] != "https://gateway.test" {
		t.Fatalf("decoded structured details = %#v", failure.Meta)
	}
	if strings.Contains(failure.Message, "remote message") || strings.Contains(failure.Hint, "remote hint") {
		t.Fatalf("remote prose survived: %#v", failure)
	}
}

// case: S-224.2
func TestDecodeResultDropsInvalidRemoteCorrelationIDs(t *testing.T) {
	for _, correlationID := range []string{"corr-short", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcdef0"} {
		body := []byte(`{"ok":false,"error":{"code":"KB_AUTH_FORBIDDEN","area":"auth","stage":"run","severity":"error","retryable":false,"message":"remote","hint":"remote","correlationId":"` + correlationID + `"}}`)
		var payload struct{}
		failure, err := DecodeResult(body, &payload)
		if err != nil || failure == nil {
			t.Fatalf("DecodeResult(%q) = (%#v, %v)", correlationID, failure, err)
		}
		if _, exists := failure.Meta["remoteCorrelationId"]; exists {
			t.Fatalf("invalid remote correlation id %q was retained: %#v", correlationID, failure.Meta)
		}
	}
}

func TestDecodeResultRejectsMalformedFailureEnvelope(t *testing.T) {
	var payload struct{}
	if failure, err := DecodeResult([]byte(`{"ok":false,"error":{"code":"KB_NOT_CATALOGUED","message":"bad","hint":"retry"}}`), &payload); err == nil || failure != nil {
		t.Fatalf("DecodeResult(malformed failure) = (%#v, %v), want validation error", failure, err)
	}
}

// case: S-203.1, S-203.2, S-224.2
func TestRenderResultsMatchSharedContract(t *testing.T) {
	var success bytes.Buffer
	Render(&success, Success("done", nil), ModeJSON)
	if err := ValidateMachineResult(success.Bytes()); err != nil {
		t.Errorf("rendered success: %v", err)
	}
	var failure, human bytes.Buffer
	diagnostic := diag.New("KB_RUNTIME_UNEXPECTED", "The operation failed.", diag.WithCorrelationID("fedcba9876543210fedcba9876543210"), diag.WithMeta(map[string]any{"remoteCorrelationId": "0123456789abcdef0123456789abcdef"}))
	RenderDiag(&failure, &human, diagnostic, ModeJSON)
	RenderDiag(&bytes.Buffer{}, &human, diagnostic, ModeHuman)
	if err := ValidateMachineResult(failure.Bytes()); err != nil {
		t.Errorf("rendered failure: %v", err)
	}
	var envelope struct {
		Error struct {
			CorrelationID string         `json:"correlationId"`
			Details       map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(failure.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Error.CorrelationID != "fedcba9876543210fedcba9876543210" ||
		envelope.Error.Details["remoteCorrelationId"] != "0123456789abcdef0123456789abcdef" ||
		!bytes.Contains(human.Bytes(), []byte("remote correlationId: 0123456789abcdef0123456789abcdef")) {
		t.Fatalf("rendered diagnostic omitted or conflated correlation IDs: json=%s human=%s", failure.Bytes(), human.Bytes())
	}
}
