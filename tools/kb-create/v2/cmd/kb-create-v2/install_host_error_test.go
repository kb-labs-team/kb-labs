package v2cli

import (
	"errors"
	"testing"

	"github.com/kb-labs/clikit/diag"
)

// case: S-285.10
func TestInstallHostErrorPreservesValidationDiagnostic(t *testing.T) {
	inner := diag.New("KB_CONFIG_INVALID", "Adapter option platform.adapterOptions.storage.baseDir is invalid: Expected string.", diag.WithHint("Correct the adapter option."), diag.WithCause("Expected string; got number."))
	inner.Meta = map[string]any{"path": "platform.adapterOptions.storage.baseDir"}
	got := installHostFailure("/platform", errors.Join(inner))
	if got != inner || got.Cause != inner.Cause || got.Meta["path"] != inner.Meta["path"] {
		t.Fatalf("validation diagnostic was lost: %#v", got)
	}
}
