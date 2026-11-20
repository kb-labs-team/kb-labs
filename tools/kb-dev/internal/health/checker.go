package health

import (
	"context"
	"errors"
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
	checkCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	// Try immediately. Every probe shares the startup deadline so a slow probe
	// cannot return healthy after the overall startup budget has expired.
	lastResult := c.probe.Execute(checkCtx)
	if checkCtx.Err() != nil {
		return checkerStoppedResult(checkCtx, lastResult)
	}
	if lastResult.OK {
		return lastResult
	}
	for {
		select {
		case <-checkCtx.Done():
			return checkerStoppedResult(checkCtx, lastResult)
		case <-ticker.C:
			probeResult := c.probe.Execute(checkCtx)
			if checkCtx.Err() != nil {
				return checkerStoppedResult(checkCtx, lastResult)
			}
			lastResult = probeResult
			if probeResult.OK {
				return probeResult
			}
		}
	}
}

func checkerStoppedResult(ctx context.Context, lastResult Result) Result {
	reason := FailureReasonCancelled
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		reason = FailureReasonTimeout
	}
	return Result{
		OK:              false,
		Latency:         lastResult.Latency,
		Error:           ctx.Err(),
		FailureReason:   reason,
		LastProbeReason: lastResult.FailureReason,
		StatusCode:      lastResult.StatusCode,
	}
}

// CheckOnce runs the probe a single time and returns the result.
func (c *Checker) CheckOnce(ctx context.Context) Result {
	return c.probe.Execute(ctx)
}
