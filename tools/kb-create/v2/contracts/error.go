package contracts

import (
	"errors"
	"fmt"
	"strings"

	"github.com/kb-labs/clikit/diag"
)

// Diagnostic converts shared request validation into the platform CLI failure
// contract, including its input exit code and field metadata.
func (e *RequestValidationError) Diagnostic() *diag.Diag {
	failure := NewDiag(CodeInputRequired, e.Message, e.Hint, e.Cause)
	failure.Meta = map[string]any{"field": e.Field}
	return failure
}

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

// Error codes emitted by kb-create's operation layer.
const (
	CodeToolchainUnsupported      = "KB_INSTALL_TOOLCHAIN_UNSUPPORTED"
	CodeMemoryInsufficient        = "KB_INSTALL_MEMORY_INSUFFICIENT"
	CodeResourceCheckFailed       = "KB_INSTALL_RESOURCE_CHECK_FAILED"
	CodePackageManagerKilled      = "KB_INSTALL_PACKAGE_MANAGER_KILLED"
	CodePortInUse                 = "KB_INSTALL_PORT_IN_USE"
	CodeIncompatibleComponents    = "KB_INSTALL_INCOMPATIBLE_COMPONENTS"
	CodeUnsupportedPlatform       = "KB_INSTALL_UNSUPPORTED_PLATFORM"
	CodeProviderUnresolved        = "KB_INSTALL_PROVIDER_UNRESOLVED"
	CodeProviderAmbiguous         = "KB_INSTALL_PROVIDER_AMBIGUOUS"
	CodeInputRequired             = "KB_INSTALL_INPUT_REQUIRED"
	CodeConfigRequired            = "KB_INSTALL_CONFIG_REQUIRED"
	CodeScenarioInvalid           = "KB_INSTALL_SCENARIO_INVALID"
	CodeWizardInputInvalid        = "KB_INSTALL_WIZARD_INPUT_INVALID"
	CodeSecretInputInvalid        = "KB_INSTALL_SECRET_INPUT_INVALID"
	CodeSecretStoreUnsupported    = "KB_INSTALL_SECRET_STORE_UNSUPPORTED"
	CodeSecretStateChanged        = "KB_INSTALL_SECRET_STATE_CHANGED"
	CodeBootstrapCredentialLocked = "KB_INSTALL_BOOTSTRAP_CREDENTIAL_LOCKED"
	CodeReleaseIndexInvalid       = "KB_INSTALL_RELEASE_INDEX_INVALID"
	CodeReleaseIndexSealFailed    = "KB_RELEASE_INDEX_SEAL_FAILED"
	CodeReleaseIndexUnreadable    = "KB_INSTALL_RELEASE_INDEX_UNREADABLE"
	CodeOfflineArtifactMissing    = "KB_INSTALL_OFFLINE_ARTIFACT_MISSING"
	CodeIndexSchemaUnsupported    = "KB_INSTALL_INDEX_SCHEMA_UNSUPPORTED"
	CodeLauncherTooOld            = "KB_INSTALL_LAUNCHER_TOO_OLD"
	CodeArtifactMismatch          = "KB_INSTALL_ARTIFACT_MANIFEST_MISMATCH"
	CodeServiceGraphMismatch      = "KB_INSTALL_SERVICE_GRAPH_MISMATCH"
	CodeApplyFailed               = "KB_INSTALL_APPLY_FAILED"
	CodeMarketplaceInstallFailed  = "KB_MARKETPLACE_INSTALL_FAILED"
	CodeOperationFailed           = "KB_INSTALL_OPERATION_FAILED"
	CodeRecoveryFailed            = "KB_INSTALL_RECOVERY_FAILED"
	CodeReceiptUnavailable        = "KB_INSTALL_RECEIPT_UNAVAILABLE"
	CodeDoctorInputInvalid        = "KB_INSTALL_DOCTOR_INPUT_INVALID"
	CodeLogUnavailable            = "KB_INSTALL_LOG_UNAVAILABLE"
	CodeDiagnosticUnavailable     = "KB_INSTALL_DIAGNOSTIC_UNAVAILABLE"
	CodeRollbackFailed            = "KB_INSTALL_ROLLBACK_FAILED"
	CodeOperationInProgress       = "KB_INSTALL_OPERATION_IN_PROGRESS"
	CodeRecoveryHostRunning       = "KB_INSTALL_RECOVERY_HOST_RUNNING"
	CodeRecoveryUnavailable       = "KB_INSTALL_RECOVERY_UNAVAILABLE"
	CodeUpdateApplyFailed         = "KB_UPDATE_APPLY_FAILED"
	CodeUpdateIncompatible        = "KB_UPDATE_INCOMPATIBLE"
	CodeUpdateDowngradeRefused    = "KB_UPDATE_DOWNGRADE_REFUSED"
	CodeUpdateHostNotHealthy      = "KB_UPDATE_HOST_NOT_HEALTHY"
	CodeUpdateNoSnapshot          = "KB_UPDATE_NO_SNAPSHOT"
	CodeUpdateSecretRefused       = "KB_UPDATE_SECRET_REFUSED"
	CodeInstallLayoutUnsupported  = "KB_INSTALL_LAYOUT_UNSUPPORTED"
	CodeHostSpecInvalid           = "KB_HOST_SPEC_INVALID"
	CodeHostStateDirUnwritable    = "KB_HOST_STATE_DIR_UNWRITABLE"
	CodeHostAlreadyRunning        = "KB_HOST_ALREADY_RUNNING"
	CodeOperationLockUnsupported  = "KB_HOST_OPERATION_LOCK_UNSUPPORTED"
	CodeHostProcessIdentityStale  = "KB_HOST_PROCESS_IDENTITY_STALE"
	CodeGatewayIndexUnavailable   = "KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE"
	CodeProvenanceMismatch        = "KB_INSTALL_PROVENANCE_MISMATCH"
)

const (
	CodeProjectSelectionChanged   = "KB_INSTALL_PROJECT_SELECTION_CHANGED"
	CodeProjectRegistrationFailed = "KB_INSTALL_PROJECT_REGISTRATION_FAILED"
)

// NewDiag constructs the shared clikit diagnostic for a kb-create error code.
// The wrapped cause remains available through Unwrap. Its sanitized text is
// exposed in both machine and human diagnostics at this shared boundary.
func NewDiag(code, message, hint string, cause error) *diag.Diag {
	if causeRequired(code) && (cause == nil || strings.TrimSpace(cause.Error()) == "") {
		panic(fmt.Sprintf("diagnostic %s requires a non-empty cause", code))
	}
	opts := make([]diag.Opt, 0, 2)
	if hint != "" {
		opts = append(opts, diag.WithHint(hint))
	}
	if cause != nil {
		opts = append(opts, diag.WithCauseAndReason(cause.Error()))
		return diag.Wrap(cause, code, message, opts...)
	}
	return diag.New(code, message, opts...)
}

// UnsupportedPlatformDiagnostic renders the catalogued error for an OS or
// architecture without a KB Labs installer release.
func UnsupportedPlatformDiagnostic(goos, goarch string) *diag.Diag {
	failure, err := diag.FromCatalog(CodeUnsupportedPlatform, map[string]string{"os": goos, "arch": goarch})
	if err != nil {
		panic(err)
	}
	return failure
}

// UpdateIncompatibleDetails is the complete identity required by the
// KB_UPDATE_INCOMPATIBLE diagnostic contract.
type UpdateIncompatibleDetails struct {
	ID, Kind, RequiredRange, SelectedVersion string
}

// NewUpdateIncompatible constructs the update-only compatibility diagnostic.
// Keeping the detail fields together prevents a caller from selecting the
// catalog code without also supplying its required component identity.
func NewUpdateIncompatible(details UpdateIncompatibleDetails) *diag.Diag {
	failure, err := diag.FromCatalog(CodeUpdateIncompatible, map[string]string{
		"id": details.ID, "kind": details.Kind,
		"requiredRange": details.RequiredRange, "selectedVersion": details.SelectedVersion,
	})
	if err != nil {
		panic(err)
	}
	return failure
}

// HostSpecDiagnostic supplies the required reason template value for the
// catalogued host-specification error at every producer boundary.
func HostSpecDiagnostic(message, hint, reason string, cause error) *diag.Diag {
	failure := NewDiag(CodeHostSpecInvalid, message, hint, cause)
	failure.Meta = map[string]any{"reason": reason}
	return failure
}

// MarketplaceInstallDiagnostic is the single scenario boundary that wraps a
// Marketplace failure while preserving its original code, message and cause.
func MarketplaceInstallDiagnostic(spec, source string, cause error) *diag.Diag {
	options := []diag.Opt{diag.WithMeta(map[string]any{"source": source})}
	if cause != nil {
		options = append(options, diag.WithCauseAndReason(cause.Error()))
	}
	failure, err := diag.FromCatalog(CodeMarketplaceInstallFailed, map[string]string{
		"package": spec, "scope": "platform", "sourceName": source,
	}, options...)
	if err != nil {
		panic(err)
	}
	failure.Meta = map[string]any{"package": spec, "scope": "platform", "source": source}
	return failure
}

func causeRequired(code string) bool {
	switch code {
	case CodeProjectRegistrationFailed, CodeReleaseIndexInvalid, CodeReleaseIndexUnreadable, CodeReleaseIndexSealFailed:
		return true
	default:
		return false
	}
}

// NewProjectRegistrationFailure builds the only supported diagnostic for a
// failed post-install project registration. Its cause comes from locally
// observed request context, never remote response text.
func NewProjectRegistrationFailure(failedStep, causeCode string, httpStatus *int, remoteCorrelationID, hint string) *diag.Diag {
	if failedStep != "login" && failedStep != "register" {
		panic("project registration failure requires a login or register step")
	}
	if _, ok := diag.LookupCatalog(causeCode); !ok {
		panic(fmt.Sprintf("project registration failure requires a catalogued cause code, got %q", causeCode))
	}
	causeText := fmt.Sprintf("Project registration failed during %s: %s", failedStep, causeCode)
	meta := map[string]any{"causeCode": causeCode, "requestStage": failedStep}
	if httpStatus != nil {
		if *httpStatus < 100 || *httpStatus > 599 {
			panic("project registration failure HTTP status must be between 100 and 599")
		}
		meta["httpStatus"] = *httpStatus
		causeText += fmt.Sprintf(" (HTTP %d)", *httpStatus)
	}
	if diag.IsValidCorrelationID(remoteCorrelationID) {
		meta["remoteCorrelationId"] = remoteCorrelationID
		causeText += "; Gateway correlation ID " + remoteCorrelationID
	}
	failure := NewDiag(CodeProjectRegistrationFailed,
		"The platform is installed, but the selected project is not registered.", hint, errors.New(causeText))
	failure.Meta = meta
	return failure
}
