package diag

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// case: S-203.2
func TestToEnvelopeRejectsMissingRequiredParameter(t *testing.T) {
	d := New("KB_RUNTIME_UNKNOWN_COMMAND", "The requested command is not available.", WithHint("Use the command registry."))
	envelope, err := ToEnvelope(d)
	var violation *Diag
	if !errors.As(err, &violation) || violation.Code != "KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION" {
		t.Fatalf("ToEnvelope error = %v, want typed producer-contract diagnostic", err)
	}
	if violation.Meta["originalCode"] != "KB_RUNTIME_UNKNOWN_COMMAND" || violation.Meta["fields"] != "binary" || envelope.Code != "" {
		t.Fatalf("contract violation = %+v, envelope = %+v", violation, envelope)
	}
}

func TestToEnvelopeTreatsUndeclaredBracesAsLiteral(t *testing.T) {
	d := New("KB_ADAPTER_NOT_INSTALLED", "Adapter package {package} is not installed. Literal {braces}.",
		WithMeta(map[string]any{"package": "@kb-labs/example/{braces}"}),
		WithHint("Inspect the literal {braces} before retrying."),
	)
	envelope, err := ToEnvelope(d)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Message != "Adapter package @kb-labs/example/{braces} is not installed. Literal {braces}." || envelope.Hint != "Inspect the literal {braces} before retrying." {
		t.Fatalf("rendered envelope = %+v", envelope)
	}
}

func TestToEnvelopeDoesNotRenderStructuredOnlyFieldNames(t *testing.T) {
	d := New("KB_PLUGIN_CONTRACT_VIOLATION", "The literal {field} is part of this message.",
		WithMeta(map[string]any{"field": "actual-field"}),
		WithHint("Keep {field} literal in this hint."),
	)
	envelope, err := ToEnvelope(d)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Message != "The literal {field} is part of this message." || envelope.Hint != "Keep {field} literal in this hint." {
		t.Fatalf("structured-only template name was substituted: %+v", envelope)
	}
}

func TestContractViolationErrorIncludesCataloguedCodeAndFields(t *testing.T) {
	err := NewContractViolation("KB_DEVKIT_TASK_GRAPH_INVALID", "package").Error()
	if !strings.Contains(err, "KB_DEVKIT_TASK_GRAPH_INVALID") || !strings.Contains(err, "package") {
		t.Fatalf("contract violation Error() = %q, want original code and offending fields", err)
	}
}

func TestToEnvelopeRejectsUndeclaredDetailsWithTypedDiagnostic(t *testing.T) {
	d := New("KB_HOST_START_FAILED", "The host process failed while starting.",
		WithMeta(map[string]any{"undeclaredEvidence": "unexpected"}),
	)
	_, err := ToEnvelope(d)
	var violation *Diag
	if !errors.As(err, &violation) || violation.Code != "KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION" {
		t.Fatalf("ToEnvelope error = %v, want typed producer-contract diagnostic", err)
	}
	if violation.Meta["originalCode"] != d.Code || violation.Meta["fields"] != "undeclaredEvidence" {
		t.Fatalf("contract violation details = %#v", violation.Meta)
	}
	if !strings.Contains(err.Error(), d.Code) || !strings.Contains(err.Error(), "undeclaredEvidence") {
		t.Fatalf("contract violation error = %q, want original code and offending field", err.Error())
	}
}

// case: S-203.2
func TestToEnvelopeUsesCatalogHintWithoutCorrelationID(t *testing.T) {
	entry, ok := LookupCatalog("KB_RUNTIME_UNEXPECTED")
	if !ok {
		t.Fatal("unexpected runtime catalog entry is missing")
	}
	d := New(entry.Code, entry.Message)
	envelope, err := ToEnvelope(d)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Hint != entry.HintWithoutCorrelationID {
		t.Fatalf("hint = %q, want catalog's no-correlation hint %q", envelope.Hint, entry.HintWithoutCorrelationID)
	}
	if strings.ContainsAny(envelope.Hint, "{}") {
		t.Fatalf("hint retained template syntax: %q", envelope.Hint)
	}
}

// case: S-203.6
func TestToEnvelopeRendersBinaryTemplateFromInvocation(t *testing.T) {
	d := New("KB_RUNTIME_COMMAND_FAILED", "The command could not complete.", WithBinary("kb-devkit"))
	envelope, err := ToEnvelope(d)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(envelope.Hint, "kb-devkit --help") {
		t.Fatalf("hint = %q, want the invoking binary's help command", envelope.Hint)
	}
	if strings.ContainsAny(envelope.Hint, "{}") {
		t.Fatalf("hint retained template syntax: %q", envelope.Hint)
	}
}

// case: S-203.6
func TestToEnvelopeRequiresGeneratedUnknownCommandTemplateParameter(t *testing.T) {
	entry, ok := LookupCatalog("KB_RUNTIME_UNKNOWN_COMMAND")
	if !ok {
		t.Fatal("unknown-command catalog entry is missing")
	}
	if len(entry.TemplateParameters) != 1 || entry.TemplateParameters[0] != "binary" {
		t.Fatalf("generated template parameters = %v, want [binary]", entry.TemplateParameters)
	}
	d := New(entry.Code, entry.Message)
	_, err := ToEnvelope(d)
	var violation *Diag
	if !errors.As(err, &violation) || violation.Code != "KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION" || violation.Meta["fields"] != "binary" {
		t.Fatalf("ToEnvelope error = %v, want missing generated binary contract diagnostic", err)
	}
}

func TestToEnvelopePreservesStructuredDetails(t *testing.T) {
	items := []map[string]string{{"kind": "workflow", "id": "run-1", "owningService": "workflow"}}
	diagnostic := New("KB_RESTART_WORK_IN_FLIGHT", "Active work prevents restart.", WithMeta(map[string]any{
		"items":            items,
		"interruptCommand": "kb-create restart --interrupt",
	}))
	envelope, err := ToEnvelope(diagnostic)
	if err != nil {
		t.Fatalf("ToEnvelope() error = %v", err)
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var received map[string]any
	if err := json.Unmarshal(encoded, &received); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	details, ok := received["details"].(map[string]any)
	if !ok {
		t.Fatalf("details = %#v, want object", received["details"])
	}
	got, ok := details["items"].([]any)
	if !ok || len(got) != 1 {
		t.Fatalf("details.items = %#v, want one JSON object", details["items"])
	}
	item, ok := got[0].(map[string]any)
	if !ok || item["owningService"] != "workflow" {
		t.Fatalf("details.items[0] = %#v, want structured owner", got[0])
	}
}

func TestToEnvelopeEnforcesRequiredStructuredDetailSchema(t *testing.T) {
	for name, details := range map[string]map[string]any{
		"missing items": {"interruptCommand": "kb-create restart --interrupt"},
		"invalid item":  {"interruptCommand": "kb-create restart --interrupt", "items": []map[string]any{{"kind": "workflow", "id": "run-1", "owningService": "workflow", "extra": true}}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ToEnvelope(New("KB_RESTART_WORK_IN_FLIGHT", "Active work prevents restart.", WithMeta(details)))
			var violation *Diag
			if !errors.As(err, &violation) || violation.Code != "KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION" {
				t.Fatalf("ToEnvelope error = %v, want catalog contract violation", err)
			}
		})
	}
}
