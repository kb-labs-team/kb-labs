package main

import "testing"

func TestCatalogAllowsTemplateParametersInStructuredDetails(t *testing.T) {
	item := entry{
		Code:                   "KB_TEST_TEMPLATE_DETAIL",
		HTTPStatus:             400,
		Area:                   "runtime",
		Stage:                  "resolve",
		Severity:               "error",
		ProcessExitClass:       "input-refusal",
		Message:                "Invalid input {field}.",
		Hint:                   "Run {command}.",
		StructuredDetailFields: []string{"field"},
		EnvironmentVariables:   map[string]string{"keyFile": "KB_RUNNER_ZAI_KEY_FILE"},
	}
	if err := validate([]entry{item}); err != nil {
		t.Fatalf("catalog validly shares template field and structured detail: %v", err)
	}
	if got := stringMapLiteral(item.EnvironmentVariables); got != `map[string]string{"keyFile": "KB_RUNNER_ZAI_KEY_FILE"}` {
		t.Fatalf("generated environment variable metadata=%s", got)
	}
}
