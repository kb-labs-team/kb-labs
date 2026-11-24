// Package health provides service health check probes with latency tracking.
package health

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// FailureReason is a bounded diagnostic category. It never contains probe
// output, URLs, process arguments, or other caller-controlled text.
type FailureReason string

const (
	FailureReasonProbeFailed   FailureReason = "probe_failed"
	FailureReasonHTTPStatus    FailureReason = "http_status"
	FailureReasonTimeout       FailureReason = "timeout"
	FailureReasonProcessExited FailureReason = "process_exited"
	FailureReasonCancelled     FailureReason = "cancelled"
)

// ProbeType classifies how to check service health.
type ProbeType int

const (
	// ProbeHTTP checks an HTTP endpoint (GET, accept 2xx/3xx).
	ProbeHTTP ProbeType = iota
	// ProbeCommand runs a shell command (exit 0 = healthy).
	ProbeCommand
	// ProbeTCP checks if a TCP port is reachable.
	ProbeTCP
	// ProbeUnix performs an HTTP GET over a unix domain socket.
	ProbeUnix
)

// Probe defines a single health check.
type Probe struct {
	Type       ProbeType
	Target     string        // URL for HTTP, "host:port" for TCP, path for Unix, command for Command
	SocketPath string        // unix domain socket path — only used when Type == ProbeUnix
	Timeout    time.Duration // per-attempt timeout
}

// Result of a single probe execution.
type Result struct {
	OK              bool          `json:"ok"`
	Latency         time.Duration `json:"latency"`
	Error           error         `json:"-"`
	FailureReason   FailureReason `json:"-"`
	LastProbeReason FailureReason `json:"-"`
	StatusCode      int           `json:"-"`
}

// ClassifyProbe determines probe type from the healthCheck string in config.
func ClassifyProbe(healthCheck string, timeout time.Duration) Probe {
	if timeout == 0 {
		timeout = 3 * time.Second
	}

	if strings.HasPrefix(healthCheck, "http://") || strings.HasPrefix(healthCheck, "https://") {
		return Probe{Type: ProbeHTTP, Target: healthCheck, Timeout: timeout}
	}

	// Check if it looks like host:port.
	if host, port, err := net.SplitHostPort(healthCheck); err == nil && host != "" && port != "" {
		return Probe{Type: ProbeTCP, Target: healthCheck, Timeout: timeout}
	}

	return Probe{Type: ProbeCommand, Target: healthCheck, Timeout: timeout}
}

// ClassifyServiceProbe selects the appropriate probe for a service.
// When socketPath is set, a unix domain socket probe is used and healthCheck
// is treated as an HTTP path (e.g. "/health"). When socketPath is empty,
// falls back to ClassifyProbe using the healthCheck string as-is.
func ClassifyServiceProbe(healthCheck, socketPath string, timeout time.Duration) Probe {
	if timeout == 0 {
		timeout = 3 * time.Second
	}
	if socketPath != "" {
		path := healthCheck
		// Extract path component if caller passed a full URL (backwards-compat).
		if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
			if u, err := url.Parse(path); err == nil {
				path = u.Path
			}
		}
		if path == "" {
			path = "/health"
		}
		return Probe{Type: ProbeUnix, Target: path, SocketPath: socketPath, Timeout: timeout}
	}
	return ClassifyProbe(healthCheck, timeout)
}

// Execute runs the probe once and returns the result.
func (p Probe) Execute(ctx context.Context) Result {
	start := time.Now()

	switch p.Type {
	case ProbeHTTP:
		return p.execHTTP(ctx, start)
	case ProbeTCP:
		return p.execTCP(ctx, start)
	case ProbeCommand:
		return p.execCommand(ctx, start)
	case ProbeUnix:
		return p.execUnix(ctx, start)
	default:
		return failedProbeResult(fmt.Errorf("unknown probe type: %d", p.Type), 0)
	}
}

func (p Probe) execHTTP(ctx context.Context, start time.Time) Result {
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.Target, nil)
	if err != nil {
		return failedProbeResultForContext(ctx, err, time.Since(start))
	}

	resp, err := http.DefaultClient.Do(req)
	latency := time.Since(start)

	if err != nil {
		return failedProbeResultForContext(ctx, err, latency)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return Result{OK: true, Latency: latency}
	}

	return Result{OK: false, Latency: latency, Error: fmt.Errorf("HTTP %d", resp.StatusCode),
		FailureReason: FailureReasonHTTPStatus, StatusCode: resp.StatusCode}
}

func (p Probe) execTCP(ctx context.Context, start time.Time) Result {
	dialer := net.Dialer{Timeout: p.Timeout}
	conn, err := dialer.DialContext(ctx, "tcp", p.Target)
	latency := time.Since(start)

	if err != nil {
		return failedProbeResultForContext(ctx, err, latency)
	}
	_ = conn.Close()
	return Result{OK: true, Latency: latency}
}

func (p Probe) execCommand(ctx context.Context, start time.Time) Result {
	// An empty target has no real command to run — `bash -c ""` trivially
	// exits 0, which would silently report a service as healthy when in fact
	// no probe was ever configured for it. Callers that intend "no health
	// check" (kb-dev's manager.go) already guard on an empty healthCheck
	// string before ever constructing a probe; reaching this with an empty
	// target means something built a probe out of a blank/misconfigured
	// health check, so it must fail rather than lie.
	if strings.TrimSpace(p.Target) == "" {
		return failedProbeResult(fmt.Errorf("no health check command configured"), time.Since(start))
	}

	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", p.Target)
	err := cmd.Run()
	latency := time.Since(start)

	if err != nil {
		return failedProbeResultForContext(ctx, err, latency)
	}
	return Result{OK: true, Latency: latency}
}

func (p Probe) execUnix(ctx context.Context, start time.Time) Result {
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()

	socketPath := p.SocketPath
	dialFn := func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: p.Timeout}).DialContext(ctx, "unix", socketPath)
	}
	client := &http.Client{
		Transport: &http.Transport{DialContext: dialFn},
	}

	reqURL := "http://localhost" + p.Target
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return failedProbeResultForContext(ctx, err, time.Since(start))
	}

	resp, err := client.Do(req)
	latency := time.Since(start)
	if err != nil {
		return failedProbeResultForContext(ctx, err, latency)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return Result{OK: true, Latency: latency}
	}
	return Result{OK: false, Latency: latency, Error: fmt.Errorf("HTTP %d", resp.StatusCode),
		FailureReason: FailureReasonHTTPStatus, StatusCode: resp.StatusCode}
}

func failedProbeResult(err error, latency time.Duration) Result {
	reason := FailureReasonProbeFailed
	if errors.Is(err, context.DeadlineExceeded) {
		reason = FailureReasonTimeout
	}
	return Result{OK: false, Latency: latency, Error: err, FailureReason: reason}
}

func failedProbeResultForContext(ctx context.Context, err error, latency time.Duration) Result {
	if contextError := ctx.Err(); contextError != nil {
		err = contextError
	}
	return failedProbeResult(err, latency)
}
