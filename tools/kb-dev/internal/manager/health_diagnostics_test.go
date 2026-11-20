package manager

import (
	"context"
	"os"
	"testing"

	"github.com/kb-labs/dev/internal/config"
	"github.com/kb-labs/dev/internal/health"
)

func TestHealthFailureReasonIsAllowlisted(t *testing.T) {
	tests := []struct {
		input health.FailureReason
		want  HealthFailureReason
	}{
		{health.FailureReasonHTTPStatus, HealthFailureHTTPStatus},
		{health.FailureReasonTimeout, HealthFailureTimeout},
		{health.FailureReasonProcessExited, HealthFailureProcessExited},
		{health.FailureReason("process exited: SECRET"), ""},
	}
	for _, tt := range tests {
		if got := healthFailureReason(tt.input); got != tt.want {
			t.Errorf("healthFailureReason(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// case: PC-003.4
func TestWaitHealthOrExitReportsTypedChildExit(t *testing.T) {
	cfg := &config.Config{
		Services: map[string]config.Service{"gateway": {
			Name: "Gateway", Type: config.ServiceTypeNode, HealthCheck: "http://127.0.0.1:1/health",
		}},
		Settings: config.Settings{HealthCheckInterval: 5, StartTimeout: 100},
	}
	m := New(cfg, t.TempDir(), t.TempDir())
	exited := make(chan *os.ProcessState, 1)
	exited <- nil

	result := m.waitHealthOrExit(context.Background(), m.services["gateway"], exited)
	if result.OK || result.FailureReason != health.FailureReasonProcessExited {
		t.Fatalf("child exit result = %#v, want process_exited", result)
	}
}

func TestHealthStatusCodeIsBounded(t *testing.T) {
	for _, tt := range []struct{ input, want int }{{100, 100}, {503, 503}, {599, 599}, {99, 0}, {600, 0}} {
		if got := safeHealthStatusCode(tt.input); got != tt.want {
			t.Errorf("safeHealthStatusCode(%d) = %d, want %d", tt.input, got, tt.want)
		}
	}
}
