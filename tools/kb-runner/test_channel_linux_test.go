//go:build linux

package main

import (
	"context"
	"strings"
	"testing"
)

func TestOutsideGoTestsFailClosedWithTypedDiagnosticOnLinux(t *testing.T) {
	result := executeTestRequestOS(context.Background(), testExecution{})
	if result.ExitCode == 0 || result.DiagnosticCode != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("Linux outside test result = %+v, want typed fail-closed diagnostic", result)
	}
	if result.Diagnostic == "" || !strings.Contains(result.Diagnostic, "next:") {
		t.Fatalf("Linux outside test refusal lacks a next step: %+v", result)
	}
}
