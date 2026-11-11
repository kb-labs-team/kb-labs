package testdeadline

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestScaledBudget(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
		want  time.Duration
		bad   bool
	}{
		{name: "default is generous", want: 30 * time.Second},
		{name: "scale applied", value: "2", want: 60 * time.Second},
		{name: "reject non-number", value: "large", bad: true},
		{name: "reject non-positive", value: "0", bad: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := scaledBudget(test.value)
			if test.bad {
				if err == nil {
					t.Fatalf("scaledBudget(%q) accepted invalid scale", test.value)
				}
				return
			}
			if err != nil {
				t.Fatalf("scaledBudget(%q): %v", test.value, err)
			}
			if got != test.want {
				t.Fatalf("scaledBudget(%q) = %s, want %s", test.value, got, test.want)
			}
		})
	}
}

// case: S-261.9
func TestBudgetUsesScaleEnvironment(t *testing.T) {
	t.Setenv("KB_TEST_DEADLINE_SCALE", "2")
	if got := Budget(t); got != 60*time.Second {
		t.Fatalf("Budget() = %s, want 60s", got)
	}
}

func TestNamedOperationBudgetsUseScale(t *testing.T) {
	t.Setenv("KB_TEST_DEADLINE_SCALE", "2")
	if got := ProcessCancellationBound(t); got != 2*time.Second {
		t.Fatalf("ProcessCancellationBound() = %s, want 2s", got)
	}
	if got := ExternalToolTimeoutSlack(t); got != 2*time.Second {
		t.Fatalf("ExternalToolTimeoutSlack() = %s, want 2s", got)
	}
	if got := ResourceCleanupSlack(t); got != 4*time.Second {
		t.Fatalf("ResourceCleanupSlack() = %s, want 4s", got)
	}
}

// case: S-261.9
func TestFailureDiagnosticIncludesBudgetElapsedAndHostLoad(t *testing.T) {
	const childEnv = "KB_TEST_DEADLINE_DIAGNOSTIC_CHILD"
	if os.Getenv(childEnv) == "1" {
		Budget(t)
		t.Fatal("intentional diagnostic probe failure")
	}

	command := exec.Command(os.Args[0], "-test.run=^TestFailureDiagnosticIncludesBudgetElapsedAndHostLoad$")
	command.Env = append(os.Environ(), childEnv+"=1", "KB_TEST_DEADLINE_SCALE=2")
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("diagnostic probe exited successfully")
	}
	transcript := string(output)
	for _, field := range []string{"budget=1m0s", "elapsed=", "host_load="} {
		if !strings.Contains(transcript, field) {
			t.Fatalf("diagnostic transcript omits %q: %s", field, transcript)
		}
	}
	if strings.Contains(transcript, "host_load=unavailable") {
		t.Fatalf("host load is unavailable in the diagnostic transcript: %s", transcript)
	}
}
