package health

import (
	"context"
	"fmt"
	"time"
)

// Checker polls a probe at a regular interval until it passes or times out.
type Checker struct {
	probe    Probe
	interval time.Duration
	timeout  time.Duration
}

// NewChecker creates a health checker with the given polling parameters.
func NewChecker(probe Probe, interval, timeout time.Duration) *Checker {
	return &Checker{
		probe:    probe,
		interval: interval,
		timeout:  timeout,
	}
}

// WaitHealthy polls the probe until it passes, the timeout expires, or the context is cancelled.
// Returns the last probe result.
func (c *Checker) WaitHealthy(ctx context.Context) Result {
	deadline := time.After(c.timeout)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	// Try immediately.
	lastResult := c.probe.Execute(ctx)
	if lastResult.OK {
		return lastResult
	}
	for {
		select {
		case <-ctx.Done():
			return Result{
				OK:              false,
				Latency:         lastResult.Latency,
				Error:           ctx.Err(),
				FailureReason:   FailureReasonCancelled,
				LastProbeReason: lastResult.FailureReason,
				StatusCode:      lastResult.StatusCode,
			}
		case <-deadline:
			return Result{
				OK:              false,
				Latency:         lastResult.Latency,
				Error:           fmt.Errorf("health check timeout after %s", c.timeout),
				FailureReason:   FailureReasonTimeout,
				LastProbeReason: lastResult.FailureReason,
				StatusCode:      lastResult.StatusCode,
			}
		case <-ticker.C:
			lastResult = c.probe.Execute(ctx)
			if lastResult.OK {
				return lastResult
			}
		}
	}
}

// CheckOnce runs the probe a single time and returns the result.
func (c *Checker) CheckOnce(ctx context.Context) Result {
	return c.probe.Execute(ctx)
}
