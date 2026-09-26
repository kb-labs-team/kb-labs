package contracts

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// ErrorStage is the moment of the user journey in which an error happened.
// The set is open; the values below are the ones the launcher emits.
type ErrorStage string

const (
	StagePreflight  ErrorStage = "preflight"
	StageResolve    ErrorStage = "resolve"
	StageApply      ErrorStage = "apply"
	StageVerify     ErrorStage = "verify"
	StageRecover    ErrorStage = "recover"
	StageStart      ErrorStage = "start"
	StageRun        ErrorStage = "run"
	StageLogin      ErrorStage = "login"
	StageAddProject ErrorStage = "add-project"
	StageExtend     ErrorStage = "extend"
	StageUpdate     ErrorStage = "update"
	StageRollback   ErrorStage = "rollback"
)

//go:generate go run ./gen

// validStages is the journey vocabulary from error-envelope.schema.json.
var validStages = map[ErrorStage]bool{StagePreflight: true, StageResolve: true, StageApply: true, StageVerify: true, StageRecover: true, StageStart: true, StageLogin: true, StageAddProject: true, StageRun: true, StageExtend: true, StageUpdate: true, StageRollback: true}

// ErrorArea groups error codes by the part of the product they belong to.
type ErrorArea string

const (
	AreaInstall ErrorArea = "install"
	AreaHost    ErrorArea = "host"
	AreaAuth    ErrorArea = "auth"
	AreaProject ErrorArea = "project"
	AreaConfig  ErrorArea = "config"
	AreaPlugin  ErrorArea = "plugin"
	AreaUpdate  ErrorArea = "update"
	AreaRuntime ErrorArea = "runtime"
	AreaProduct ErrorArea = "product"
)

// ErrorSeverity distinguishes a blocking error from a non-blocking warning.
type ErrorSeverity string

const (
	SeverityError   ErrorSeverity = "error"
	SeverityWarning ErrorSeverity = "warning"
)

// Launcher error codes. The catalog of record is
// core/platform/src/error-envelope/errors.catalog.json; codes_gen.go
// is generated from it (go generate) and a test fails when it is stale.
const (
	CodeOperationInvalid       = "KB_INSTALL_OPERATION_INVALID"
	CodeToolchainUnsupported   = "KB_INSTALL_TOOLCHAIN_UNSUPPORTED"
	CodeIncompatibleComponents = "KB_INSTALL_INCOMPATIBLE_COMPONENTS"
	CodeProviderUnresolved     = "KB_INSTALL_PROVIDER_UNRESOLVED"
	CodeProviderAmbiguous      = "KB_INSTALL_PROVIDER_AMBIGUOUS"
	CodeInputRequired          = "KB_INSTALL_INPUT_REQUIRED"
	CodeConfigRequired         = "KB_INSTALL_CONFIG_REQUIRED"
	CodeScenarioInvalid        = "KB_INSTALL_SCENARIO_INVALID"
	CodeWizardInputInvalid     = "KB_INSTALL_WIZARD_INPUT_INVALID"
	CodeSecretInputInvalid     = "KB_INSTALL_SECRET_INPUT_INVALID"
	CodeReleaseIndexInvalid    = "KB_INSTALL_RELEASE_INDEX_INVALID"
	CodeIndexSchemaUnsupported = "KB_INSTALL_INDEX_SCHEMA_UNSUPPORTED"
	CodeLauncherTooOld         = "KB_INSTALL_LAUNCHER_TOO_OLD"
	CodeArtifactMismatch       = "KB_INSTALL_ARTIFACT_MANIFEST_MISMATCH"
	CodeServiceGraphMismatch   = "KB_INSTALL_SERVICE_GRAPH_MISMATCH"
	CodeApplyFailed            = "KB_INSTALL_APPLY_FAILED"
	CodeOperationFailed        = "KB_INSTALL_OPERATION_FAILED"
	CodeRecoveryFailed         = "KB_INSTALL_RECOVERY_FAILED"
	CodeReceiptUnavailable     = "KB_INSTALL_RECEIPT_UNAVAILABLE"
	CodeStatusUnhealthy        = "KB_INSTALL_STATUS_UNHEALTHY"
	CodeDoctorInputInvalid     = "KB_INSTALL_DOCTOR_INPUT_INVALID"
	CodeLogUnavailable         = "KB_INSTALL_LOG_UNAVAILABLE"
	CodeDiagnosticUnavailable  = "KB_INSTALL_DIAGNOSTIC_UNAVAILABLE"
)

// CodeInfo is the catalog data the launcher needs to build an envelope offline.
// launcherCodes (codes_gen.go) holds every catalog code.
type CodeInfo struct {
	Area      ErrorArea
	Stage     ErrorStage
	Retryable bool
}

// LookupCode returns the launcher's catalog data for a code.
func LookupCode(code string) (CodeInfo, bool) {
	info, ok := launcherCodes[code]
	return info, ok
}

// codePrefixAreas maps the KB_<PREFIX>_ segment of a code to its area.
// KB_ADAPTER_* is a plugin-area family (see 08-errors.md section 5F).
var codePrefixAreas = map[string]ErrorArea{
	"INSTALL": AreaInstall,
	"HOST":    AreaHost,
	"AUTH":    AreaAuth,
	"PROJECT": AreaProject,
	"CONFIG":  AreaConfig,
	"PLUGIN":  AreaPlugin,
	"ADAPTER": AreaPlugin,
	"UPDATE":  AreaUpdate,
	"RUNTIME": AreaRuntime,
}

// AreaForCode derives the area from a code: KB_<AREA>_* for platform codes,
// product for <PLUGIN>_* codes, and empty for an empty code.
func AreaForCode(code string) ErrorArea {
	if code == "" {
		return ""
	}
	parts := strings.SplitN(code, "_", 3)
	if parts[0] != "KB" {
		return AreaProduct
	}
	if len(parts) < 3 {
		return ""
	}
	return codePrefixAreas[parts[1]]
}

// ErrorAction is a recovery step; Command is copy-ready.
type ErrorAction struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Command string `json:"command,omitempty"`
}

// LauncherError is the launcher's side of the unified error envelope
// (core/platform/src/error-envelope/error-envelope.schema.json, 08-errors.md).
// It is safe to render for a human, return in JSON/agent protocol and persist
// in a redacted diagnostic dossier. Cause must never hold secrets.
type LauncherError struct {
	Code          string            `json:"code"`
	Area          ErrorArea         `json:"area"`
	Stage         ErrorStage        `json:"stage"`
	Severity      ErrorSeverity     `json:"severity"`
	Retryable     bool              `json:"retryable"`
	Message       string            `json:"message"`
	Cause         string            `json:"cause,omitempty"`
	Hint          string            `json:"hint"`
	Actions       []ErrorAction     `json:"actions,omitempty"`
	Docs          string            `json:"docs,omitempty"`
	CorrelationID string            `json:"correlationId,omitempty"`
	Details       map[string]string `json:"details,omitempty"`
}

// NewLauncherError builds an error for a known launcher code, taking area,
// stage and retryable from the catalog table. A code the launcher does not
// know keeps the zero stage, and Validate reports it.
func NewLauncherError(code, message, hint string, cause error) *LauncherError {
	result := &LauncherError{Code: code, Message: message, Hint: hint}
	if info, ok := LookupCode(code); ok {
		result.Area, result.Stage, result.Retryable = info.Area, info.Stage, info.Retryable
	}
	if cause != nil {
		result.Cause = cause.Error()
	}
	return result.normalized()
}

func (e *LauncherError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// normalized fills the fields that are derivable so every serialised error is
// a complete envelope: area from the code, severity defaulting to error.
func (e *LauncherError) normalized() *LauncherError {
	value := *e
	if value.Area == "" {
		value.Area = AreaForCode(value.Code)
	}
	if value.Severity == "" {
		value.Severity = SeverityError
	}
	return &value
}

// MarshalJSON always emits the complete envelope, for values and pointers alike.
func (e LauncherError) MarshalJSON() ([]byte, error) {
	type envelope LauncherError
	return json.Marshal(envelope(*e.normalized()))
}

var (
	codePattern = regexp.MustCompile(`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`)
	validAreas  = map[ErrorArea]bool{AreaInstall: true, AreaHost: true, AreaAuth: true, AreaProject: true, AreaConfig: true, AreaPlugin: true, AreaUpdate: true, AreaRuntime: true, AreaProduct: true}
)

// Validate applies the same rules as error-envelope.schema.json and the TS
// validateErrorEnvelope, after normalisation. It returns the list of problems.
func (e *LauncherError) Validate() []string {
	value := e.normalized()
	var problems []string
	if !codePattern.MatchString(value.Code) {
		problems = append(problems, "code must match ^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$")
	}
	if !validAreas[value.Area] {
		problems = append(problems, "area is not a known area")
	}
	if !validStages[value.Stage] {
		problems = append(problems, "stage is not in the journey vocabulary")
	}
	if value.Severity != SeverityError && value.Severity != SeverityWarning {
		problems = append(problems, "severity must be error or warning")
	}
	if value.Message == "" {
		problems = append(problems, "message must not be empty")
	}
	if value.Hint == "" {
		problems = append(problems, "hint must not be empty")
	}
	for index, action := range value.Actions {
		if action.ID == "" || action.Label == "" {
			problems = append(problems, fmt.Sprintf("actions[%d] needs non-empty id and label", index))
		}
	}
	return problems
}
