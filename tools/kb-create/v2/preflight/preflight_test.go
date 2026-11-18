package preflight

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	sharedtoolchain "github.com/kb-labs/clikit/toolchain"
)

func TestEnsureWithAcceptsSupportedRuntime(t *testing.T) {
	versions := map[string]string{"node": fmt.Sprintf("v%d.18.0", sharedtoolchain.SupportedNodeMajor), "pnpm": "12.21.0"}
	var output strings.Builder
	if err := EnsureWith(func(binary string) (string, error) { return versions[binary], nil }, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), fmt.Sprintf("Node.js v%d.18.0", sharedtoolchain.SupportedNodeMajor)) {
		t.Fatalf("preflight output = %q", output.String())
	}
}

func TestEnsureWithFailsFastOnUnsupportedNode(t *testing.T) {
	versions := map[string]string{"node": "v20.18.0", "pnpm": "12.21.0"}
	if err := EnsureWith(func(binary string) (string, error) { return versions[binary], nil }, nil); err == nil || !strings.Contains(err.Error(), "Node.js 20.18.0 is unsupported") {
		t.Fatalf("error = %v", err)
	}
}

// case: S-260.4
func TestInstallerPreflightMatchesRuntimeCatalogForOlderAndNewerMajors(t *testing.T) {
	entry, ok := diag.LookupCatalog("KB_NODE_VERSION_UNSUPPORTED")
	if !ok {
		t.Fatal("Node version diagnostic is absent from the catalog")
	}
	for _, version := range []string{"v20.19.4", "v26.0.0"} {
		err := EnsureWith(func(binary string) (string, error) {
			if binary == "node" {
				return version, nil
			}
			return "v12.21.0", nil
		}, nil)
		var failure *diag.Diag
		if !errors.As(err, &failure) {
			t.Fatalf("preflight error %T is not a catalogued diagnostic", err)
		}
		envelope, envelopeErr := diag.ToEnvelope(failure)
		if envelopeErr != nil {
			t.Fatal(envelopeErr)
		}
		values := map[string]string{
			"requiredMajor": fmt.Sprint(sharedtoolchain.SupportedNodeMajor),
			"actualVersion": strings.TrimPrefix(version, "v"),
		}
		expected, err := diag.FromCatalog(entry.Code, values)
		if err != nil {
			t.Fatal(err)
		}
		expectedEnvelope, err := diag.ToEnvelope(expected)
		if err != nil {
			t.Fatal(err)
		}
		if envelope.Code != entry.Code || envelope.Message != expectedEnvelope.Message || envelope.Hint != expectedEnvelope.Hint {
			t.Fatalf("preflight envelope differs from contract-checked catalog for %s: %#v", version, envelope)
		}
	}
}

func TestEnsureWithFailsFastWhenPnpmIsMissing(t *testing.T) {
	if err := EnsureWith(func(binary string) (string, error) {
		if binary == "pnpm" {
			return "", errors.New("not installed")
		}
		return fmt.Sprintf("v%d.18.0", sharedtoolchain.SupportedNodeMajor), nil
	}, nil); err == nil || !strings.Contains(err.Error(), "pnpm preflight failed") {
		t.Fatalf("error = %v", err)
	}
}

func TestEnsureWithKeepsMissingNodeSeparateFromUnsupportedVersion(t *testing.T) {
	err := EnsureWith(func(binary string) (string, error) {
		if binary == "node" {
			return "", errors.New("node executable missing")
		}
		return "v12.21.0", nil
	}, nil)
	var failure *diag.Diag
	if !errors.As(err, &failure) {
		t.Fatalf("missing Node error %T is not a catalogued diagnostic", err)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Code != "KB_INSTALL_NODE_MISSING" {
		t.Fatalf("missing Node code = %q", envelope.Code)
	}
}
