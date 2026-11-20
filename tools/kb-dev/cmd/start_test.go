package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	clikitresult "github.com/kb-labs/clikit/result"
	"github.com/kb-labs/dev/internal/config"
	"github.com/kb-labs/dev/internal/manager"
)

func TestStartFailureDataPreservesActionAndRedactsSecrets(t *testing.T) {
	secret := "fixture-internal-secret-value"
	result := &manager.Result{
		OK: false,
		Actions: []manager.Action{{
			Service: "gateway",
			Action:  "failed",
			Error:   "gateway failed while using " + secret,
			LogsTail: []string{
				"GATEWAY_INTERNAL_SECRET=" + secret,
				"gateway stopped before readiness",
			},
		}},
		Hint: "check logs",
	}
	cfg := &config.Config{Services: map[string]config.Service{
		"gateway": {Env: map[string]string{"GATEWAY_INTERNAL_SECRET": secret}},
	}}

	data := safeStartResult(result, cfg)
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
	if !strings.Contains(text, "gateway stopped before readiness") ||
		!strings.Contains(text, "failed while using [REDACTED]") ||
		!strings.Contains(text, `"code":"KB_RUNTIME_COMMAND_FAILED"`) {
		t.Fatalf("structured start failure lost its useful action details: %s", text)
	}
	if result.Actions[0].Error == data.Actions[0].Error {
		t.Fatal("safe result mutated or reused the original action")
	}
}
