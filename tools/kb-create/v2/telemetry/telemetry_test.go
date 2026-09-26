package telemetry

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSendRequiresExplicitConsent(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer server.Close()
	Send(server.URL, false, New("apply", "success", "", "stable", "registry", 3, time.Second))
	if calls != 0 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestSendDoesNotIncludeSensitiveFields(t *testing.T) {
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		body = string(data)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	Send(server.URL, true, New("apply", "failure", "KB_INSTALL_INPUT_REQUIRED", "stable", "offline", 2, time.Millisecond))
	if !strings.Contains(body, `"operation":"apply"`) || strings.Contains(body, "token") || strings.Contains(body, "path") {
		t.Fatalf("body = %s", body)
	}
}
