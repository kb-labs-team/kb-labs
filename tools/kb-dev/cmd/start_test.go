package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	clikitresult "github.com/kb-labs/clikit/result"
	"github.com/kb-labs/dev/internal/manager"
)

func TestStartFailureDataPreservesActionAndRedactsSecrets(t *testing.T) {
	secret := "fixture-internal-secret-value"
	result := &manager.Result{
		OK: false,
		Actions: []manager.Action{{
			Service:          "gateway",
			Action:           "failed",
			ErrorCode:        manager.ActionErrorHealthCheckFailed,
			HealthReason:     manager.HealthFailureTimeout,
			LastProbeReason:  manager.HealthFailureHTTPStatus,
			HealthStatusCode: 503,
			Error:            "gateway failed while using " + secret,
			LogsTail: []string{
				"GATEWAY_INTERNAL_SECRET=" + secret,
				"gateway stopped before readiness",
			},
		}},
		Hint: "check logs",
	}
	data := safeStartResult(result, func(service string) string {
		return "/tmp/fixture/logs/" + service + ".log"
	})
	diagnostic := diag.FromError(commandFailureWithData("kb-dev start", data))
	diagnostic.Binary = "kb-dev"
	serialized, err := json.Marshal(clikitresult.FailureEnvelope(diagnostic))
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	text := string(serialized)
	if strings.Contains(text, secret) {
		t.Fatalf("structured start failure leaked a configured secret: %s", text)
	}
	if strings.Contains(text, "gateway failed while using") || strings.Contains(text, "gateway stopped before readiness") {
		t.Fatalf("structured start failure included arbitrary process text: %s", text)
	}
	if !strings.Contains(text, `"errorCode":"health_check_failed"`) ||
		!strings.Contains(text, `"healthReason":"timeout"`) ||
		!strings.Contains(text, `"lastProbeReason":"http_status"`) ||
		!strings.Contains(text, `"healthStatusCode":503`) ||
		!strings.Contains(text, `"logPath":"/tmp/fixture/logs/gateway.log"`) ||
		!strings.Contains(text, `"code":"KB_RUNTIME_COMMAND_FAILED"`) {
		t.Fatalf("structured start failure lost its useful action details: %s", text)
	}
}

func TestStartFailureDataDropsUnknownHealthDiagnostics(t *testing.T) {
	result := &manager.Result{OK: false, Actions: []manager.Action{{
		Service: "gateway", Action: "failed", ErrorCode: manager.ActionErrorHealthCheckFailed,
		HealthReason:    manager.HealthFailureReason("secret-fragment"),
		LastProbeReason: manager.HealthFailureHTTPStatus, HealthStatusCode: 999,
	}}}
	data := safeStartResult(result, func(string) string { return "/tmp/gateway.log" })
	serialized, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	text := string(serialized)
	if strings.Contains(text, "secret-fragment") || strings.Contains(text, `"healthStatusCode":999`) {
		t.Fatalf("structured start failure leaked unrecognized health diagnostics: %s", text)
	}
	if !strings.Contains(text, `"lastProbeReason":"http_status"`) {
		t.Fatalf("structured start failure lost recognized health diagnostics: %s", text)
	}
}

func TestStartFailureDataAllowListsErrorCode(t *testing.T) {
	result := &manager.Result{
		OK: false,
		Actions: []manager.Action{{
			Service:   "gateway",
			Action:    "failed",
			ErrorCode: manager.ActionErrorCode("unsafe-log-fragment-secret"),
			Error:     "ignored",
		}},
	}
	data := safeStartResult(result, func(service string) string { return "/tmp/" + service + ".log" })
	serialized, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}
	text := string(serialized)
	if strings.Contains(text, "unsafe-log-fragment-secret") {
		t.Fatalf("structured start failure leaked an unrecognized error code: %s", text)
	}
	if !strings.Contains(text, `"errorCode":"service_start_failed"`) {
		t.Fatalf("structured start failure did not fall back to the safe error code: %s", text)
	}
}
