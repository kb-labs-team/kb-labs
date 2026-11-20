package health

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClassifyProbe(t *testing.T) {
	tests := []struct {
		input string
		want  ProbeType
	}{
		{"http://localhost:3000/health", ProbeHTTP},
		{"https://example.com/ping", ProbeHTTP},
		{"localhost:6379", ProbeTCP},
		{"redis-cli ping", ProbeCommand},
		{"echo ok", ProbeCommand},
	}
	for _, tt := range tests {
		p := ClassifyProbe(tt.input, 0)
		if p.Type != tt.want {
			t.Errorf("ClassifyProbe(%q) = %d, want %d", tt.input, p.Type, tt.want)
		}
	}
}

// TestEmptyHealthCheckIsNotSilentlyHealthy documents the "silent false-positive
// health check" gap found during the Studio-auth/resource-config
// investigation: when a service's healthCheck is empty (e.g. its manifest
// never declared runtime.healthCheck, or kb-create's EntryForSwap left it
// blank because Port was 0), ClassifyProbe falls back to ProbeCommand with an
// empty Target. execCommand then runs `bash -c ""`, which exits 0 — so a
// service that never started at all is reported healthy. The correct
// behavior is that an empty healthCheck must never report OK. Expected to
// FAIL against current code (this is the bug, not a regression guard yet).
func TestEmptyHealthCheckIsNotSilentlyHealthy(t *testing.T) {
	p := ClassifyProbe("", 2*time.Second)
	result := p.Execute(context.Background())
	if result.OK {
		t.Error("ClassifyProbe(\"\").Execute() reports OK=true for an empty healthCheck — " +
			"a service with no real probe configured must never be reported healthy " +
			"(bash -c \"\" trivially exits 0, masking a service that never started)")
	}
}

func TestHTTPProbeOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := ClassifyProbe(srv.URL, 3*time.Second)
	r := p.Execute(context.Background())
	if !r.OK {
		t.Errorf("expected OK, got error: %v", r.Error)
	}
	if r.Latency == 0 {
		t.Error("latency should be > 0")
	}
}

func TestHTTPProbeFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := ClassifyProbe(srv.URL, 3*time.Second)
	r := p.Execute(context.Background())
	if r.OK {
		t.Error("expected failure for 500 response")
	}
	if r.FailureReason != FailureReasonHTTPStatus || r.StatusCode != http.StatusInternalServerError {
		t.Fatalf("failure diagnostics = (%q, %d), want http_status and 500", r.FailureReason, r.StatusCode)
	}
}

func TestCheckerTimeoutPreservesTypedLastProbeFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	r := NewChecker(ClassifyProbe(srv.URL, time.Second), time.Millisecond, 15*time.Millisecond).
		WaitHealthy(context.Background())
	if r.OK || r.FailureReason != FailureReasonTimeout ||
		r.LastProbeReason != FailureReasonHTTPStatus || r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("timeout diagnostics = %#v", r)
	}
}

func TestHTTPProbeLatency(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := ClassifyProbe(srv.URL, 3*time.Second)
	r := p.Execute(context.Background())
	if !r.OK {
		t.Fatalf("expected OK, got error: %v", r.Error)
	}
	if r.Latency < 50*time.Millisecond {
		t.Errorf("latency %v should be >= 50ms", r.Latency)
	}
}

func TestCommandProbeOK(t *testing.T) {
	p := ClassifyProbe("echo ok", 5*time.Second)
	r := p.Execute(context.Background())
	if !r.OK {
		t.Errorf("expected OK, got error: %v", r.Error)
	}
}

func TestCommandProbeFail(t *testing.T) {
	p := ClassifyProbe("false", 5*time.Second)
	r := p.Execute(context.Background())
	if r.OK {
		t.Error("expected failure for 'false' command")
	}
}

func TestWaitHealthySuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := ClassifyProbe(srv.URL, 3*time.Second)
	c := NewChecker(p, 100*time.Millisecond, 5*time.Second)
	r := c.WaitHealthy(context.Background())
	if !r.OK {
		t.Errorf("expected OK, got error: %v", r.Error)
	}
}

func TestWaitHealthyTimeout(t *testing.T) {
	// Server that always returns 500.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := ClassifyProbe(srv.URL, 1*time.Second)
	c := NewChecker(p, 50*time.Millisecond, 200*time.Millisecond)
	r := c.WaitHealthy(context.Background())
	if r.OK {
		t.Error("expected timeout failure")
	}
}

func TestWaitHealthyCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	p := ClassifyProbe(srv.URL, 1*time.Second)
	c := NewChecker(p, 50*time.Millisecond, 10*time.Second)
	r := c.WaitHealthy(ctx)
	if r.OK {
		t.Error("expected cancellation failure")
	}
}

// startUnixServer starts an HTTP server on a unix domain socket.
// Uses a short /tmp path to avoid macOS 104-char unix socket path limit.
// Returns the socket path and a cleanup function.
func startUnixServer(t *testing.T, status int) (socketPath string, cleanup func()) {
	t.Helper()
	// Use /tmp directly — t.TempDir() produces paths that exceed the 104-char limit on macOS.
	socketPath = filepath.Join("/tmp", fmt.Sprintf("kb-test-%d.sock", time.Now().UnixNano()))

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	})

	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()

	cleanup = func() {
		_ = srv.Close()
		_ = os.Remove(socketPath)
	}
	return socketPath, cleanup
}

func TestUnixProbeOK(t *testing.T) {
	socketPath, cleanup := startUnixServer(t, http.StatusOK)
	defer cleanup()

	p := ClassifyServiceProbe("/health", socketPath, 3*time.Second)
	if p.Type != ProbeUnix {
		t.Fatalf("expected ProbeUnix, got %d", p.Type)
	}
	if p.SocketPath != socketPath {
		t.Errorf("SocketPath = %q, want %q", p.SocketPath, socketPath)
	}

	r := p.Execute(context.Background())
	if !r.OK {
		t.Errorf("expected OK, got error: %v", r.Error)
	}
	if r.Latency == 0 {
		t.Error("latency should be > 0")
	}
}

func TestUnixProbeFail(t *testing.T) {
	socketPath, cleanup := startUnixServer(t, http.StatusInternalServerError)
	defer cleanup()

	p := Probe{Type: ProbeUnix, Target: "/health", SocketPath: socketPath, Timeout: 3 * time.Second}
	r := p.Execute(context.Background())
	if r.OK {
		t.Error("expected failure for 500 response")
	}
}

func TestUnixProbeConnectionRefused(t *testing.T) {
	p := Probe{
		Type:       ProbeUnix,
		Target:     "/health",
		SocketPath: "/tmp/kb-dev-nonexistent-test.sock",
		Timeout:    500 * time.Millisecond,
	}
	r := p.Execute(context.Background())
	if r.OK {
		t.Error("expected failure for non-existent socket")
	}
}

func TestClassifyServiceProbeWithSocket(t *testing.T) {
	socketPath, cleanup := startUnixServer(t, http.StatusOK)
	defer cleanup()

	p := ClassifyServiceProbe("http://localhost:5050/health", socketPath, 3*time.Second)
	if p.Type != ProbeUnix {
		t.Fatalf("expected ProbeUnix, got %d", p.Type)
	}
	// Must extract just the path from the full URL.
	if p.Target != "/health" {
		t.Errorf("Target = %q, want /health", p.Target)
	}
	if p.SocketPath != socketPath {
		t.Errorf("SocketPath = %q, want %q", p.SocketPath, socketPath)
	}

	r := p.Execute(context.Background())
	if !r.OK {
		t.Errorf("expected OK via unix socket, got: %v", r.Error)
	}
}

func TestClassifyServiceProbeNoSocket(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := ClassifyServiceProbe(srv.URL, "", 3*time.Second)
	if p.Type != ProbeHTTP {
		t.Fatalf("expected ProbeHTTP, got %d", p.Type)
	}

	r := p.Execute(context.Background())
	if !r.OK {
		t.Errorf("expected OK, got: %v", r.Error)
	}
}

func TestClassifyServiceProbeDefaultsToHealthPath(t *testing.T) {
	socketPath, cleanup := startUnixServer(t, http.StatusOK)
	defer cleanup()

	p := ClassifyServiceProbe("", socketPath, 3*time.Second)
	if p.Target != "/health" {
		t.Errorf("expected default path /health, got %q", p.Target)
	}
}
