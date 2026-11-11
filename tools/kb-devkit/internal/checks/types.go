// Package checks defines the extensibility backbone for workspace rules.
package checks

import (
	_ "embed"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// externalCheckResultFileEnv is shared with Node check producers.
//
//go:embed external-check-result-env.txt
var externalCheckResultFileEnv string

// ExternalCheckResultFileEnv names the file where an external check must
// synchronously write its JSON result. stdout and stderr remain diagnostics.
var ExternalCheckResultFileEnv = strings.TrimSpace(externalCheckResultFileEnv)

// Severity indicates how critical an issue is.
type Severity string
type Capability string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"

	CapabilityManual        Capability = "manual"
	CapabilityFixable       Capability = "fixable"
	CapabilityScaffoldable  Capability = "scaffoldable"
	CapabilityManagedBySync Capability = "managed-by-sync"
)

// Issue is a single finding from a rule check.
type Issue struct {
	Check                string     `json:"check"`
	Severity             Severity   `json:"severity"`
	Message              string     `json:"message"`
	File                 string     `json:"file,omitempty"`
	Line                 int        `json:"line,omitempty"`
	Fix                  string     `json:"fix,omitempty"`
	AutoFix              bool       `json:"autoFix,omitempty"`
	Capability           Capability `json:"capability,omitempty"`
	CheckFailure         bool       `json:"checkFailure,omitempty"`
	Cause                string     `json:"cause,omitempty"`
	FailureDiagnostic    *diag.Diag `json:"-"`
	FailureExitCode      int        `json:"-"`
	FailureExitCodeKnown bool       `json:"-"`
	FailureStderrTail    string     `json:"-"`
}

// Rule is the interface every checker must implement.
type Rule interface {
	Name() string
	Check(pkg workspace.Package, preset config.Preset) []Issue
}

// Fixer is an optional interface for rules that support --fix.
type Fixer interface {
	Apply(pkg workspace.Package, issues []Issue, dryRun bool) error
}
