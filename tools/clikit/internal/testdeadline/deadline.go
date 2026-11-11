package testdeadline

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const defaultBudget = 30 * time.Second

// FormerFixedReadinessDeadlinePlusMarginStimulus is only a synchronization
// stimulus for proving readiness has no fixed two-second startup timer.
const FormerFixedReadinessDeadlinePlusMarginStimulus = 2500 * time.Millisecond

// Budget returns the module's generous, load-scaled test deadline.
func Budget(t testing.TB) time.Duration {
	t.Helper()
	return scaled(t, defaultBudget)
}

// Scale applies the governed test scale to a semantic observation window.
func Scale(t testing.TB, duration time.Duration) time.Duration {
	t.Helper()
	return scaled(t, duration)
}

// ProcessCancellationBound owns the test's process-tree cancellation latency bound.
func ProcessCancellationBound(t testing.TB) time.Duration {
	t.Helper()
	return scaled(t, time.Second)
}

// ExternalToolTimeoutSlack owns scheduling allowance after the production tool timeout.
func ExternalToolTimeoutSlack(t testing.TB) time.Duration {
	t.Helper()
	return scaled(t, time.Second)
}

// ResourceCleanupSlack owns scheduling allowance after the production cleanup bound.
func ResourceCleanupSlack(t testing.TB) time.Duration {
	t.Helper()
	return scaled(t, 2*time.Second)
}

func scaled(t testing.TB, duration time.Duration) time.Duration {
	budget, err := scaledDuration(duration, os.Getenv("KB_TEST_DEADLINE_SCALE"))
	if err != nil {
		t.Fatalf("scale test deadline: %v", err)
	}
	started := time.Now()
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("test deadline context: budget=%s elapsed=%s host_load=%s", budget, time.Since(started).Round(time.Millisecond), hostLoad())
		}
	})
	return budget
}

func scaledBudget(value string) (time.Duration, error) {
	return scaledDuration(defaultBudget, value)
}

func scaledDuration(duration time.Duration, value string) (time.Duration, error) {
	scale, err := scaleFactor(value)
	if err != nil {
		return 0, err
	}
	budget := time.Duration(float64(duration) * scale)
	if budget <= 0 {
		return 0, fmt.Errorf("scale %q produces a non-positive duration from %s", value, duration)
	}
	return budget, nil
}

func scaleFactor(value string) (float64, error) {
	if value == "" {
		return 1, nil
	}
	scale, err := strconv.ParseFloat(value, 64)
	if err != nil || scale <= 0 {
		return 0, fmt.Errorf("want a positive number, got %q", value)
	}
	return scale, nil
}

func hostLoad() string {
	if runtime.GOOS == "linux" {
		data, err := os.ReadFile("/proc/loadavg")
		if err != nil {
			return "unavailable: " + err.Error()
		}
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			return strings.Join(fields[:3], " ")
		}
		return "unavailable: malformed /proc/loadavg"
	}
	if runtime.GOOS == "darwin" {
		output, err := exec.Command("/usr/bin/uptime").Output()
		if err != nil {
			return "unavailable: " + err.Error()
		}
		return strings.TrimSpace(string(output))
	}
	return "unavailable on " + runtime.GOOS
}
