package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/clikit/result"
	"github.com/kb-labs/dev/internal/manager"
)

// case: S-286.4
func TestServiceCommandFailurePreservesCauseAndOmitsLogTail(t *testing.T) {
	err := serviceCommandFailure("kb-dev start", &manager.Result{
		OK:   false,
		Hint: "Inspect the service log, then correct the startup failure.",
		Actions: []manager.Action{{
			Service:  "workflow",
			Action:   "failed",
			Error:    "health check timeout after 30s",
			LogsTail: []string{"GATEWAY_INTERNAL_SECRET=do-not-print"},
		}},
	})

	diagnostic, ok := err.(*diag.Diag)
	if !ok {
		t.Fatalf("expected structured diagnostic, got %T", err)
	}
	encoded, err := json.Marshal(result.FailureEnvelope(diagnostic))
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, want := range []string{"KB_RUNTIME_COMMAND_FAILED", "workflow", "health check timeout after 30s", "Inspect the service log"} {
		if !strings.Contains(text, want) {
			t.Errorf("failure envelope missing %q: %s", want, text)
		}
	}
	if strings.Contains(text, "do-not-print") || strings.Contains(text, "LogsTail") || strings.Contains(text, "logsTail") {
		t.Fatalf("failure envelope leaked raw log tail: %s", text)
	}

	if !strings.Contains(diagnostic.Reason, "workflow") || !strings.Contains(diagnostic.Reason, "health check timeout") {
		t.Fatalf("human-readable reason did not preserve manager cause: %q", diagnostic.Reason)
	}
}
