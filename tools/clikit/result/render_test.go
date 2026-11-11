package result

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
)

func TestRender_Human(t *testing.T) {
	var b bytes.Buffer
	Render(&b, Success("hello human", map[string]any{"x": 1}), ModeHuman)
	if got := strings.TrimSpace(b.String()); got != "hello human" {
		t.Errorf("human = %q", got)
	}
}

func TestRender_JSON(t *testing.T) {
	var b bytes.Buffer
	Render(&b, Success("ignored", map[string]any{"x": 1}), ModeJSON)
	var env map[string]any
	if err := json.Unmarshal(b.Bytes(), &env); err != nil {
		t.Fatalf("not json: %v", err)
	}
	if env["ok"] != true {
		t.Errorf("envelope = %v", env)
	}
	if len(env) != 2 {
		t.Errorf("success envelope keys = %v, want only ok and data", env)
	}
	data, _ := env["data"].(map[string]any)
	if data["x"].(float64) != 1 {
		t.Errorf("data = %v", env["data"])
	}
}

func TestRender_AgentFallsBackToJSON(t *testing.T) {
	var b bytes.Buffer
	// No Agent payload set → agent mode uses the JSON envelope.
	Render(&b, Success("h", map[string]any{"x": 1}), ModeAgent)
	if !strings.Contains(b.String(), `"data"`) {
		t.Errorf("agent fallback = %q", b.String())
	}
}

func TestRenderDiag_JSONHasFullErrorEnvelope(t *testing.T) {
	d := diag.New("KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.",
		diag.WithReason("health gate timed out"),
		diag.WithCorrelationID("corr-test"))
	want, err := diag.ToEnvelope(d)
	if err != nil {
		t.Fatal(err)
	}
	var out, herr bytes.Buffer
	code := RenderDiag(&out, &herr, d, ModeJSON)
	if code != diag.ExitCode(d) {
		t.Errorf("exit = %d", code.Code())
	}
	var env map[string]any
	if err := json.Unmarshal(out.Bytes(), &env); err != nil {
		t.Fatalf("not json: %v", err)
	}
	if env["ok"] != false {
		t.Errorf("ok = %v", env["ok"])
	}
	e := env["error"].(map[string]any)
	if e["code"] != "KB_RUNTIME_UNEXPECTED" || e["message"] != "An unexpected error occurred." || e["hint"] != want.Hint || e["correlationId"] != "corr-test" {
		t.Errorf("error payload = %v", e)
	}
	if hint, ok := e["hint"].(string); !ok || strings.ContainsAny(hint, "{}") {
		t.Errorf("JSON hint contains an unresolved template marker: %v", e["hint"])
	}
	if len(env) != 2 || len(e) != 9 {
		t.Errorf("failure envelope has extra fields: %v", env)
	}
}

func TestRenderDiag_JSONKeepsStructuredFailureDataAtResultLevel(t *testing.T) {
	d := diag.New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.",
		diag.WithBinary("kb-devkit"),
		diag.WithData(map[string]any{
			"summary": map[string]int{"scheduled": 3, "failed": 1, "skipped": 2},
			"results": []map[string]any{{"package": "@fixture/core", "ok": false}},
		}))
	var out, herr bytes.Buffer
	if code := RenderDiag(&out, &herr, d, ModeJSON); code != diag.ExitCode(d) {
		t.Fatalf("exit = %d, want %d", code.Code(), diag.ExitCode(d).Code())
	}
	var env struct {
		OK   bool `json:"ok"`
		Data struct {
			Summary map[string]int `json:"summary"`
			Results []struct {
				Package string `json:"package"`
				OK      bool   `json:"ok"`
			} `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &env); err != nil {
		t.Fatalf("decode output %q: %v", out.String(), err)
	}
	if env.OK || env.Data.Summary["scheduled"] != 3 || env.Data.Summary["failed"] != 1 ||
		env.Data.Summary["skipped"] != 2 || len(env.Data.Results) != 1 || env.Data.Results[0].Package != "@fixture/core" {
		t.Fatalf("failure envelope = %+v", env)
	}
}

func TestRenderDiag_AgentOmitsMeta(t *testing.T) {
	d := diag.New("KB_RUNTIME_UNEXPECTED", "x", diag.WithCorrelationID("corr-test"))
	var out, herr bytes.Buffer
	RenderDiag(&out, &herr, d, ModeAgent)
	if !strings.Contains(out.String(), "correlationId") {
		t.Errorf("agent failure must retain correlationId, got %q", out.String())
	}
}

func TestRenderDiag_HumanShowsReasonAndHint(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	d := diag.New("KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.",
		diag.WithReason("shipped without a service manifest"),
		diag.WithCorrelationID("corr-human"))
	want, err := diag.ToEnvelope(d)
	if err != nil {
		t.Fatal(err)
	}
	var out, herr bytes.Buffer
	RenderDiag(&out, &herr, d, ModeHuman)
	h := herr.String()
	for _, part := range []string{"KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.", "why:", "shipped without", "Hint: " + want.Hint, "correlationId:", "corr-human"} {
		if !strings.Contains(h, part) {
			t.Errorf("human diag missing %q in:\n%s", part, h)
		}
	}
	if strings.ContainsAny(want.Hint, "{}") || strings.Contains(h, "Hint: ") && strings.ContainsAny(strings.SplitN(h, "Hint: ", 2)[1], "{}") {
		t.Errorf("human hint contains an unresolved template marker:\n%s", h)
	}
}

func TestRenderDiag_HumanDoesNotPrintMachineCause(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	d := diag.New("KB_RUNTIME_UNEXPECTED", "An unexpected error occurred.",
		diag.WithCause("raw internal Go error text"),
		diag.WithCorrelationID("corr-cause"))
	var out, herr bytes.Buffer
	RenderDiag(&out, &herr, d, ModeHuman)
	if strings.Contains(herr.String(), "raw internal Go error text") {
		t.Fatalf("human output leaked machine cause: %s", herr.String())
	}
}

// case: S-203.1, S-203.2
func TestMachineResultMatchesSharedContractFixtures(t *testing.T) {
	for _, fixture := range []string{
		"../../../core/platform/contracts/ux-result/fixtures/valid/success.json",
		"../../../core/platform/contracts/ux-result/fixtures/valid/failure.json",
	} {
		if err := ValidateFixture(fixture); err != nil {
			t.Errorf("shared fixture %s: %v", fixture, err)
		}
	}
}

func TestResolveMode(t *testing.T) {
	cases := []struct {
		j, a bool
		out  string
		want Mode
	}{
		{false, false, "", ModeHuman},
		{true, false, "", ModeJSON},
		{false, true, "", ModeAgent},
		{true, false, "agent", ModeAgent}, // --output wins
		{true, true, "human", ModeHuman},  // --output wins
		{false, false, "json", ModeJSON},
	}
	for _, c := range cases {
		if got := ResolveMode(c.j, c.a, c.out); got != c.want {
			t.Errorf("ResolveMode(%v,%v,%q) = %d, want %d", c.j, c.a, c.out, got, c.want)
		}
	}
}
