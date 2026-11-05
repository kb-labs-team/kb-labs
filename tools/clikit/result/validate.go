package result

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/kb-labs/clikit/diag"
)

// DecodeResult validates a shared UX-result envelope. On success it decodes
// data into out. On failure it reconstructs a local diagnostic from the
// shared catalog. Remote message and hint text are discarded; only
// generated template values and locally observed request context survive.
func DecodeResult(content []byte, out any) (*diag.Diag, error) {
	return DecodeResultWithContext(content, out, RemoteFailureContext{})
}

// RemoteFailureContext contains locally observed request metadata. It is safe
// to attach to a reconstructed remote failure because it does not come from
// the response body or headers.
type RemoteFailureContext struct {
	RequestStage string
	HTTPStatus   int
}

// DecodeResultWithContext validates a UX-result envelope and annotates a
// reconstructed failure with the request stage and HTTP status observed by
// the caller. Remote message, hint, cause, actions, and docs are discarded;
// only generated catalog template values and validated correlation IDs from
// the response survive alongside locally observed request context.
func DecodeResultWithContext(content []byte, out any, context RemoteFailureContext) (*diag.Diag, error) {
	if err := ValidateMachineResult(content); err != nil {
		return nil, fmt.Errorf("invalid UX result envelope: %w", err)
	}
	var envelope struct {
		OK    bool            `json:"ok"`
		Data  json.RawMessage `json:"data"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(content, &envelope); err != nil {
		return nil, fmt.Errorf("invalid UX result envelope: %w", err)
	}
	if !envelope.OK {
		var failure struct {
			Code          string         `json:"code"`
			Area          string         `json:"area"`
			Stage         string         `json:"stage"`
			Severity      string         `json:"severity"`
			Retryable     bool           `json:"retryable"`
			CorrelationID string         `json:"correlationId"`
			Details       map[string]any `json:"details"`
		}
		if err := json.Unmarshal(envelope.Error, &failure); err != nil {
			return nil, fmt.Errorf("invalid UX failure envelope: %w", err)
		}
		meta := make(map[string]any, 3)
		if context.RequestStage != "" {
			meta["requestStage"] = context.RequestStage
		}
		if context.HTTPStatus != 0 {
			meta["httpStatus"] = context.HTTPStatus
		}
		if diag.IsValidCorrelationID(failure.CorrelationID) {
			meta["remoteCorrelationId"] = failure.CorrelationID
		}
		entry, ok := diag.LookupCatalog(failure.Code)
		if !ok || failure.Area != entry.Area || failure.Stage != entry.Stage || failure.Severity != entry.Severity || failure.Retryable != entry.Retryable {
			return gatewayProtocolFailure(meta, failure.Code), nil
		}
		templateValues := make(map[string]string, len(failure.Details))
		structuredDetails := make(map[string]any)
		for key, value := range failure.Details {
			if text, ok := value.(string); ok {
				templateValues[key] = text
			} else {
				structuredDetails[key] = value
			}
		}
		local, err := diag.FromCatalog(entry.Code, templateValues, diag.WithMeta(structuredDetails), diag.WithMeta(meta))
		if err != nil {
			var violation *diag.Diag
			if errors.As(err, &violation) {
				if fields, ok := violation.Meta["fields"].(string); ok {
					meta["fields"] = fields
				}
			}
			return gatewayProtocolFailure(meta, failure.Code), nil
		}
		return local, nil
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return nil, fmt.Errorf("invalid UX result data: %w", err)
	}
	return nil, nil
}

func gatewayProtocolFailure(meta map[string]any, remoteCode string) *diag.Diag {
	if remoteCode != "" {
		meta["remoteCode"] = remoteCode
	}
	return diag.New("KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE", "", diag.WithMeta(meta))
}

var catalogCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`)

// ValidateFixture validates a shared machine-result fixture.
func ValidateFixture(path string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return ValidateMachineResult(content)
}

// ValidateMachineResult checks the shared machine-result schema constraints.
func ValidateMachineResult(content []byte) error {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(content, &envelope); err != nil {
		return err
	}
	var ok bool
	if err := json.Unmarshal(envelope["ok"], &ok); err != nil {
		return fmt.Errorf("machine result must have a boolean ok field: %w", err)
	}
	if ok {
		if len(envelope) < 2 || len(envelope) > 3 || envelope["data"] == nil {
			return fmt.Errorf("success must contain ok, data, and optional meta")
		}
		for key := range envelope {
			if key != "ok" && key != "data" && key != "meta" {
				return fmt.Errorf("success contains unknown property %s", key)
			}
		}
		if _, exists := envelope["error"]; exists {
			return fmt.Errorf("success must not contain error")
		}
		if raw, exists := envelope["meta"]; exists {
			var meta map[string]json.RawMessage
			if err := json.Unmarshal(raw, &meta); err != nil || meta == nil {
				return fmt.Errorf("success meta must be an object")
			}
		}
		return nil
	}
	if len(envelope) < 2 || len(envelope) > 3 || envelope["error"] == nil {
		return fmt.Errorf("failure must contain ok, error, and optional meta")
	}
	for key := range envelope {
		if key != "ok" && key != "error" && key != "meta" {
			return fmt.Errorf("failure contains unknown property %s", key)
		}
	}
	if raw, exists := envelope["meta"]; exists {
		var meta map[string]json.RawMessage
		if err := json.Unmarshal(raw, &meta); err != nil || len(meta) != 1 || meta["stream"] == nil {
			return fmt.Errorf("failure meta must contain a stream terminal")
		}
		var stream map[string]json.RawMessage
		if err := json.Unmarshal(meta["stream"], &stream); err != nil || len(stream) != 2 || stream["terminal"] == nil || stream["exitCode"] == nil {
			return fmt.Errorf("failure stream must contain terminal and exitCode")
		}
		var terminal bool
		var exitCode int
		if json.Unmarshal(stream["terminal"], &terminal) != nil || !terminal || json.Unmarshal(stream["exitCode"], &exitCode) != nil || exitCode < 1 {
			return fmt.Errorf("failure stream must be terminal with a nonzero exit code")
		}
	}
	var failure map[string]json.RawMessage
	if err := json.Unmarshal(envelope["error"], &failure); err != nil {
		return err
	}
	required := []string{"code", "area", "stage", "severity", "retryable", "message", "hint", "correlationId"}
	for _, key := range required {
		if failure[key] == nil {
			return fmt.Errorf("failure error is missing %s", key)
		}
	}
	allowed := map[string]bool{
		"code": true, "area": true, "stage": true, "severity": true, "retryable": true,
		"message": true, "hint": true, "cause": true, "actions": true, "docs": true,
		"correlationId": true, "details": true,
	}
	for key := range failure {
		if !allowed[key] {
			return fmt.Errorf("failure error contains unknown property %s", key)
		}
	}
	for _, key := range []string{"code", "area", "stage", "severity", "message", "hint", "correlationId"} {
		var value string
		if err := json.Unmarshal(failure[key], &value); err != nil || strings.TrimSpace(value) == "" {
			return fmt.Errorf("failure error %s must be a non-empty string", key)
		}
	}
	var code string
	if err := json.Unmarshal(failure["code"], &code); err != nil || !catalogCodePattern.MatchString(code) || !strings.HasPrefix(code, "KB_") {
		return fmt.Errorf("failure code must be a stable KB_* catalog code")
	}
	var area, stage, severity string
	_ = json.Unmarshal(failure["area"], &area)
	_ = json.Unmarshal(failure["stage"], &stage)
	_ = json.Unmarshal(failure["severity"], &severity)
	if area != "runtime" && area != "install" && area != "host" && area != "auth" && area != "project" && area != "config" && area != "plugin" && area != "update" && area != "product" {
		return fmt.Errorf("failure area %q is not in the shared schema", area)
	}
	if stage != "preflight" && stage != "resolve" && stage != "apply" && stage != "verify" && stage != "recover" && stage != "start" && stage != "login" && stage != "add-project" && stage != "run" && stage != "extend" && stage != "update" && stage != "rollback" {
		return fmt.Errorf("failure stage %q is not in the shared schema", stage)
	}
	if severity != "error" && severity != "warning" {
		return fmt.Errorf("failure severity %q is not in the shared schema", severity)
	}
	var retryable bool
	if err := json.Unmarshal(failure["retryable"], &retryable); err != nil {
		return fmt.Errorf("failure error retryable must be boolean")
	}
	for _, key := range []string{"cause", "docs", "correlationId"} {
		if raw, exists := failure[key]; exists {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				return fmt.Errorf("failure error %s must be a string", key)
			}
		}
	}
	if raw, exists := failure["details"]; exists {
		var details map[string]any
		if err := json.Unmarshal(raw, &details); err != nil || details == nil {
			return fmt.Errorf("failure error details must be an object")
		}
	}
	return nil
}

// DecodeSuccessResult validates the shared UX-result envelope and decodes its
// success payload into out. Failure envelopes and unwrapped payloads are errors.
func DecodeSuccessResult(content []byte, out any) error {
	failure, err := DecodeResult(content, out)
	if err != nil {
		return err
	}
	if failure != nil {
		return failure
	}
	return nil
}
