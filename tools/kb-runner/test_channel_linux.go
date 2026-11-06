//go:build linux

package main

import (
	"context"
	"errors"

	"github.com/kb-labs/clikit/diag"
)

func executeTestRequestOS(context.Context, testExecution) testResult {
	invocation, err := testChannelInvocation()
	if err != nil {
		return testResult{ExitCode: 2, Diagnostic: err.Error()}
	}
	root := runnerRoot{invocation: invocation}
	next, err := testChannelNextCommand()
	if err != nil {
		return testResult{ExitCode: 2, Diagnostic: err.Error()}
	}
	refusal := testChannelRefusal{Code: "KB_RUNTIME_INPUT_INVALID", Next: next, Cause: "outside Go tests require the macOS sandbox-exec policy; Linux policy is not implemented"}
	diagnostic := testChannelDiagnostic(root, refusal)
	var typed *diag.Diag
	if errors.As(diagnostic, &typed) {
		return testResult{ExitCode: 2, DiagnosticCode: refusal.Code, Diagnostic: renderDiagnostic(typed)}
	}
	return testResult{ExitCode: 2, Diagnostic: diagnostic.Error()}
}
