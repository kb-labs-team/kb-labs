package v2cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
	"github.com/spf13/cobra"
)

const platformEnvelopeSchema = "../../../../../core/platform/src/error-envelope/error-envelope.schema.json"

func readPlatformEnvelopeSchema(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(platformEnvelopeSchema)
	if err != nil {
		t.Fatalf("read platform error-envelope schema: %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatalf("decode platform error-envelope schema: %v", err)
	}
	return schema
}

// This intentionally reads and applies the platform JSON Schema so the Go
// wire contract cannot drift behind a copied Go definition.
func validatePlatformSchema(schema map[string]any, value any, path string) error {
	if expected, ok := schema["type"].(string); ok {
		valid := false
		switch expected {
		case "object":
			_, valid = value.(map[string]any)
		case "array":
			_, valid = value.([]any)
		case "string":
			_, valid = value.(string)
		case "boolean":
			_, valid = value.(bool)
		case "number":
			_, valid = value.(float64)
		}
		if !valid {
			return fmt.Errorf("%s: expected schema type %s, got %T", path, expected, value)
		}
	}
	if choices, ok := schema["enum"].([]any); ok {
		match := false
		for _, choice := range choices {
			if choice == value {
				match = true
				break
			}
		}
		if !match {
			return fmt.Errorf("%s: value %v is outside schema enum %v", path, value, choices)
		}
	}
	if text, ok := value.(string); ok {
		if pattern, ok := schema["pattern"].(string); ok {
			matched, err := regexp.MatchString(pattern, text)
			if err != nil {
				return fmt.Errorf("%s: invalid schema pattern: %w", path, err)
			}
			if !matched {
				return fmt.Errorf("%s: value %q does not match %s", path, text, pattern)
			}
		}
		if min, ok := schema["minLength"].(float64); ok && float64(len(text)) < min {
			return fmt.Errorf("%s: string length %d is less than %v", path, len(text), min)
		}
	}
	if object, ok := value.(map[string]any); ok {
		properties, _ := schema["properties"].(map[string]any)
		if required, ok := schema["required"].([]any); ok {
			for _, raw := range required {
				key := raw.(string)
				if _, found := object[key]; !found {
					return fmt.Errorf("%s: required property %q is missing", path, key)
				}
			}
		}
		for key, child := range object {
			childSchema, known := properties[key].(map[string]any)
			if known {
				if err := validatePlatformSchema(childSchema, child, path+"."+key); err != nil {
					return err
				}
				continue
			}
			additional := schema["additionalProperties"]
			if allowed, ok := additional.(bool); ok && !allowed {
				return fmt.Errorf("%s: property %q is not allowed", path, key)
			}
			if childSchema, ok := additional.(map[string]any); ok {
				if err := validatePlatformSchema(childSchema, child, path+"."+key); err != nil {
					return err
				}
			}
		}
	}
	if items, ok := value.([]any); ok {
		if itemSchema, ok := schema["items"].(map[string]any); ok {
			for i, item := range items {
				if err := validatePlatformSchema(itemSchema, item, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func decodeEnvelope(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("decode emitted error envelope: %v", err)
	}
	return envelope
}

func assertPlatformEnvelope(t *testing.T, schema map[string]any, envelope map[string]any) {
	t.Helper()
	if err := validatePlatformSchema(schema, envelope, "error"); err != nil {
		t.Fatal(err)
	}
}

// case: S-203.2, S-203.3, S-203.7, S-203.11, S-203.13
func TestEmittedKbCreateDiagnosticsMatchPlatformErrorSchema(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	schema := readPlatformEnvelopeSchema(t)

	t.Run("command error", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		missingRoot := filepath.Join(t.TempDir(), "missing-platform")
		code := clikitcommand.Execute(newRootCommand(), []string{"doctor", "--platform-root", missingRoot, "--json"}, &stdout, &stderr)
		if code.Code() != 1 {
			t.Fatalf("doctor exit = %d, want 1; stdout=%s stderr=%s", code.Code(), stdout.String(), stderr.String())
		}
		var result struct {
			Error json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || len(result.Error) == 0 {
			t.Fatalf("doctor did not emit a failure envelope: %s (%v)", stdout.String(), err)
		}
		assertPlatformEnvelope(t, schema, decodeEnvelope(t, result.Error))
	})
	t.Run("unexpected command error", func(t *testing.T) {
		root := newRootCommand()
		for _, command := range root.Commands() {
			if command.Name() == "doctor" {
				command.RunE = func(*cobra.Command, []string) error {
					return runSafely(func() error { return errors.New("private Go error detail") })
				}
			}
		}
		var stdout, stderr bytes.Buffer
		code := clikitcommand.Execute(root, []string{"doctor", "--json"}, &stdout, &stderr)
		if code.Code() != 1 {
			t.Fatalf("unexpected doctor exit = %d, want 1; stdout=%s stderr=%s", code.Code(), stdout.String(), stderr.String())
		}
		var result struct {
			Error json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || len(result.Error) == 0 {
			t.Fatalf("unexpected doctor failure did not emit an envelope: %s (%v)", stdout.String(), err)
		}
		envelope := decodeEnvelope(t, result.Error)
		assertPlatformEnvelope(t, schema, envelope)
		if envelope["code"] != "KB_RUNTIME_UNEXPECTED" || envelope["correlationId"] == "" || strings.Contains(stdout.String(), "private Go error detail") {
			t.Fatalf("unexpected command envelope is unsafe or uncorrelated: %s", stdout.String())
		}
	})

	t.Run("control protocol errors and specific hints", func(t *testing.T) {
		identity, err := host.NewProcessIdentityToken()
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv(host.ProcessIdentityEnv, identity)
		server := &control.Server{State: host.State{Dir: t.TempDir()}, Version: "schema-test"}
		if err := server.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = server.Close() })
		request := func(method, path string, body io.Reader) map[string]any {
			t.Helper()
			req, err := http.NewRequest(method, "http://"+server.Address()+path, body)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+server.Token())
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var result struct {
				Error map[string]any `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			assertPlatformEnvelope(t, schema, result.Error)
			return result.Error
		}
		unknown := request(http.MethodGet, "/v1/nope", nil)
		if got, want := unknown["hint"], "Use GET /v1/status, POST /v1/host/restart or POST /v1/update-request."; got != want {
			t.Errorf("unknown endpoint hint = %v, want %q", got, want)
		}
		invalidUpdate := request(http.MethodPost, "/v1/update-request", strings.NewReader(`{"version":"1.0.0","channel":"stable"}`))
		if got, want := invalidUpdate["hint"], "Send exactly one of an exact version or a channel (stable, canary, experimental)."; got != want {
			t.Errorf("update request hint = %v, want %q", got, want)
		}
		if got, want := invalidUpdate["cause"], "exactly one of version and channel is required"; got != want {
			t.Errorf("update request cause = %v, want safe validation detail %q", got, want)
		}
		unauthorizedReq, err := http.NewRequest(http.MethodGet, "http://"+server.Address()+"/v1/status", nil)
		if err != nil {
			t.Fatal(err)
		}
		unauthorizedReq.Header.Set("Authorization", "Bearer invalid-token")
		unauthorizedResponse, err := http.DefaultClient.Do(unauthorizedReq)
		if err != nil {
			t.Fatal(err)
		}
		defer unauthorizedResponse.Body.Close()
		var unauthorizedBody struct {
			Error map[string]any `json:"error"`
		}
		if err := json.NewDecoder(unauthorizedResponse.Body).Decode(&unauthorizedBody); err != nil {
			t.Fatal(err)
		}
		assertPlatformEnvelope(t, schema, unauthorizedBody.Error)
		if got, want := unauthorizedBody.Error["hint"], "Read the current token from control.json in the install-root host-state directory reported by `kb-create doctor`."; got != want {
			t.Errorf("unauthorized hint = %v, want %q", got, want)
		}
	})

	t.Run("install JSONL terminal error", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		missingIndex := filepath.Join(t.TempDir(), "missing-release-index.json")
		code := clikitcommand.Execute(newRootCommand(), []string{"install", "--json", "--index", missingIndex}, &stdout, &stderr)
		if code.Code() != 2 {
			t.Fatalf("install exit = %d, want 2; stdout=%s stderr=%s", code.Code(), stdout.String(), stderr.String())
		}
		lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
		if len(lines) != 1 {
			t.Fatalf("install JSONL records = %d, want terminal error: %s", len(lines), stdout.String())
		}
		var failure struct {
			Error json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal([]byte(lines[0]), &failure); err != nil || len(failure.Error) == 0 {
			t.Fatalf("install did not emit a JSONL error record: %s (%v)", lines[0], err)
		}
		assertPlatformEnvelope(t, schema, decodeEnvelope(t, failure.Error))
		var terminal struct {
			OK    bool            `json:"ok"`
			Error json.RawMessage `json:"error"`
			Meta  struct {
				Stream struct {
					Terminal bool `json:"terminal"`
					ExitCode int  `json:"exitCode"`
				} `json:"stream"`
			} `json:"meta"`
		}
		if err := json.Unmarshal([]byte(lines[0]), &terminal); err != nil {
			t.Fatal(err)
		}
		if terminal.OK || len(terminal.Error) == 0 || !terminal.Meta.Stream.Terminal || terminal.Meta.Stream.ExitCode != 2 {
			t.Fatalf("install terminal record = %s", lines[0])
		}
		assertPlatformEnvelope(t, schema, decodeEnvelope(t, terminal.Error))
	})
}
