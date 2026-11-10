package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/semrange"
)

// SupportedSchemas lists every release-index schema this launcher can read.
// It is an explicit allow-list: an index whose schema is newer (for example a
// future v3 with a different topology) or simply unknown is rejected before
// any resolution work instead of being half-understood.
var SupportedSchemas = []string{Schema}

const indexInvalidHint = "Retry the command; if it persists report the correlationId (this is a KB Labs problem)."

// CheckSchema rejects an index schema this launcher does not support.
func CheckSchema(schema string) error {
	for _, supported := range SupportedSchemas {
		if schema == supported {
			return nil
		}
	}
	err := contracts.NewDiag(contracts.CodeIndexSchemaUnsupported,
		"The release index uses a schema this launcher does not support.",
		"Update the launcher (kb-create update, or download the current launcher) and retry.", nil)
	err.Meta = map[string]any{"actual": schema, "supported": strings.Join(SupportedSchemas, ",")}
	return err
}

// peekSchema reads only the schema field so that an index of a newer shape is
// rejected on its schema, not on an incidental decode failure.
func peekSchema(data []byte) (string, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return "", err
	}
	return head.Schema, nil
}

// indexGateError keeps the validation phase and mismatched values attached to
// the underlying failure until the single loader boundary adds file context.
type indexGateError struct {
	gate, expected, actual string
	err                    error
}

func (e *indexGateError) Error() string { return e.err.Error() }
func (e *indexGateError) Unwrap() error { return e.err }

// wrapIndexError is the single error-construction boundary for release-index
// loading. It keeps typed schema failures and enriches every gate with path,
// reason, and string-valued envelope details.
func wrapIndexError(path, gate, expected, actual string, err error) error {
	reason := fmt.Sprintf("Release index %s failed for %s: %s", gate, path, strings.ReplaceAll(err.Error(), "\n", " "))
	var typed *diag.Diag
	if errors.As(err, &typed) {
		typed.Reason = reason
		typed.Cause = reason
		if typed.Meta == nil {
			typed.Meta = map[string]any{}
		}
		typed.Meta["gate"] = gate
		typed.Meta["path"] = path
		if expected != "" {
			typed.Meta["expected"] = expected
		}
		if actual != "" {
			typed.Meta["actual"] = actual
		}
		return typed
	}
	code, message, hint := contracts.CodeReleaseIndexInvalid, "The release index is corrupted or invalid.", indexInvalidHint
	if gate == "read" {
		code, message, hint = contracts.CodeReleaseIndexUnreadable,
			"The release index at "+path+" cannot be read.", "Check the --index path and file permissions."
	}
	diagnostic := contracts.NewDiag(code,
		message, hint, err)
	diagnostic.Reason = reason
	diagnostic.Cause = reason
	diagnostic.Meta = map[string]any{"gate": gate, "path": path}
	if expected != "" {
		diagnostic.Meta["expected"] = expected
	}
	if actual != "" {
		diagnostic.Meta["actual"] = actual
	}
	return diagnostic
}

// CheckLauncher enforces the platform's optional minLauncherVersion. An empty
// constraint means no constraint.
func CheckLauncher(platform PlatformBundle, launcherVersion string) error {
	if platform.MinLauncherVersion == "" {
		return nil
	}
	// A workspace build has no release version to compare. This is the
	// established local-build contract exercised by the compatibility matrix.
	if launcherVersion == "dev" {
		return nil
	}
	minimum, err := semrange.ParseVersion(platform.MinLauncherVersion)
	if err != nil {
		return contracts.NewDiag(contracts.CodeReleaseIndexInvalid,
			fmt.Sprintf("Platform %s declares an invalid minLauncherVersion %q.", platform.Version, platform.MinLauncherVersion), indexInvalidHint, err)
	}
	current, err := semrange.ParseVersion(launcherVersion)
	if err != nil {
		return contracts.NewDiag(contracts.CodeReleaseIndexInvalid,
			fmt.Sprintf("Launcher version %q is not a valid semantic version.", launcherVersion), indexInvalidHint, err)
	}
	if semrange.AtLeast(minimum).Satisfies(current) {
		return nil
	}
	failure := contracts.NewDiag(contracts.CodeLauncherTooOld,
		fmt.Sprintf("Platform %s requires launcher %s or newer, but this is %s.", platform.Version, platform.MinLauncherVersion, launcherVersion),
		"Run kb-create update, or download the current launcher, then retry.", nil)
	failure.Meta = map[string]any{"platform": platform.Version, "minLauncherVersion": platform.MinLauncherVersion, "launcher": launcherVersion}
	return failure
}
