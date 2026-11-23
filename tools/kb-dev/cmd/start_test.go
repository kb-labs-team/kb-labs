package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	clikitresult "github.com/kb-labs/clikit/result"
	"github.com/kb-labs/dev/internal/config"
	"github.com/kb-labs/dev/internal/manager"
)

// case: PC-003.4
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

// case: PC-003.4
func TestStartJSONHealthDiagnosticsFromManagerResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	root := t.TempDir()
	cfg := &config.Config{
		Services: map[string]config.Service{"gateway": {
			Name: "Gateway", Type: config.ServiceTypeNode,
			Command: "sleep 60", HealthCheck: server.URL,
		}},
		Settings: config.Settings{
			PIDDir: filepath.Join(root, "pids"), LogsDir: filepath.Join(root, "logs"),
			StartTimeout: 150, HealthCheckInterval: 10,
		},
	}
	mgr := manager.New(cfg, root, root)
	mgr.ResolveEnv()
	result := mgr.Start(context.Background(), []string{"gateway"}, false)
	if result.OK {
		t.Fatal("manager start unexpectedly succeeded for HTTP 503 health endpoint")
	}

	data := safeStartResult(result, mgr.LogPath)
	serialized, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	text := string(serialized)
	for _, expected := range []string{
		`"errorCode":"health_check_failed"`, `"healthReason":"timeout"`,
		`"lastProbeReason":"http_status"`, `"healthStatusCode":503`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("structured manager result missing %s: %s", expected, text)
		}
	}
	if strings.Contains(text, "HTTP 503") || strings.Contains(text, "sleep 60") {
		t.Fatalf("structured manager result exposed raw process/health text: %s", text)
	}
}
