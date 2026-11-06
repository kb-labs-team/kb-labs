package catalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
)

// case: S-214.1
func TestLoadFileReadFailureDiagnostic(t *testing.T) {
	assertLoadFileDiagnostic(t, "read", "", "no such file or directory", contracts.CodeReleaseIndexUnreadable, nil)
}

// case: S-214.2
func TestLoadFileParseFailureDiagnostic(t *testing.T) {
	assertLoadFileDiagnostic(t, "parse", "", "invalid character", contracts.CodeReleaseIndexInvalid,
		func(*testing.T) []byte { return []byte("not json") })
}

// case: S-214.3
func TestLoadFileSchemaVersionFailureDiagnostic(t *testing.T) {
	assertLoadFileDiagnostic(t, "schema version", Schema, "kb.create.release-index/v99", contracts.CodeIndexSchemaUnsupported,
		func(*testing.T) []byte { return []byte(`{"schema":"kb.create.release-index/v99"}`) })
}

func TestPreviousReleaseSchemaIsRejected(t *testing.T) {
	_, err := Decode([]byte(`{"schema":"kb.create.release-index/v2"}`))
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeIndexSchemaUnsupported {
		t.Fatalf("previous schema error = %v, want %s", err, contracts.CodeIndexSchemaUnsupported)
	}
}

// case: S-214.4
func TestLoadFileDigestFailureDiagnostic(t *testing.T) {
	assertLoadFileDiagnostic(t, "digest", "wrong-digest", "", contracts.CodeReleaseIndexInvalid, func(t *testing.T) []byte {
		value := testLoadableCatalog(t)
		value.Digest = "wrong-digest"
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	})
}

// case: S-214.5
func TestLoadFileValidationRuleFailureDiagnostic(t *testing.T) {
	assertLoadFileDiagnostic(t, "validation rule", "valid release index", "platform bundle must declare",
		contracts.CodeReleaseIndexInvalid, func(t *testing.T) []byte {
			value := testLoadableCatalog(t)
			value.Platforms[0].Package = ""
			value.Digest, _ = digest(value)
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			return data
		})
}

func assertLoadFileDiagnostic(t *testing.T, gate, expected, actual, code string, contents func(*testing.T) []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "release-index.json")
	if contents != nil {
		if err := os.WriteFile(path, contents(t), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, err := LoadFile(path)
	if err == nil {
		t.Fatal("expected release-index failure")
	}
	var typed *diag.Diag
	if !errors.As(err, &typed) {
		t.Fatalf("error is not typed: %T %v", err, err)
	}
	if typed.Code != code {
		t.Fatalf("code = %q, want %q", typed.Code, code)
	}
	if typed.Meta["gate"] != gate || typed.Meta["path"] != path {
		t.Fatalf("details = %#v; want gate %q and path %q", typed.Meta, gate, path)
	}
	if expected != "" && typed.Meta["expected"] != expected {
		t.Errorf("expected detail = %#v", typed.Meta["expected"])
	}
	if actual != "" && !strings.Contains(fmt.Sprint(typed.Meta["actual"]), actual) {
		t.Errorf("actual detail = %#v; want %q", typed.Meta["actual"], actual)
	}
	if gate == "digest" && (typed.Meta["actual"] == "" || typed.Meta["expected"] != "wrong-digest") {
		t.Errorf("digest comparison details = %#v", typed.Meta)
	}
	if !strings.Contains(typed.Reason, gate) || !strings.Contains(typed.Reason, path) {
		t.Fatalf("human reason lacks gate/path: %q", typed.Reason)
	}
	envelope, err := diag.ToEnvelope(typed)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Details["gate"] != gate || envelope.Details["path"] != path {
		t.Fatalf("serialized details = %#v", envelope.Details)
	}
	if gate == "read" && (envelope.Retryable || !strings.Contains(envelope.Hint, "--index path and file permissions")) {
		t.Fatalf("read failure is not actionable and non-retryable: retryable=%v hint=%q", envelope.Retryable, envelope.Hint)
	}
	if !strings.Contains(envelope.Cause, gate) || !strings.Contains(envelope.Cause, path) {
		t.Fatalf("serialized cause lacks gate/path: %q", envelope.Cause)
	}
}

func testLoadableCatalog(t *testing.T) Catalog {
	t.Helper()
	value, err := Seal(Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []PlatformBundle{{
		SupportedTargets: []BinaryTarget{{OS: "linux", Arch: "amd64"}}, ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "artifact",
		Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestLoadFileRequiresPlatformBundle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFile(path); err == nil {
		t.Fatal("expected missing platform validation")
	}
}

func TestLoadJourneyCompatibilityIndexesBeforeCompatibilityResolution(t *testing.T) {
	for _, path := range []string{
		"../../../../e2e/platform/fixtures/installer-cases/compatibility-matrix-linux-arm64.json",
		"../../../../e2e/platform/fixtures/installer-cases/missing-host-binary-linux-arm64.json",
	} {
		t.Run(path, func(t *testing.T) {
			if _, err := LoadFile(path); err != nil {
				t.Fatalf("journey fixture is not a valid sealed release index: %v", err)
			}
		})
	}
}

func TestSealedJourneyFixturesMatchCatalogProducer(t *testing.T) {
	for _, path := range []string{
		"../../../../e2e/platform/fixtures/release-index-v3.json",
		"../cmd/kb-create-v2/testdata/x251-release-index-v3.json",
	} {
		t.Run(path, func(t *testing.T) {
			actual, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			index, err := LoadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			sealed, err := Seal(index)
			if err != nil {
				t.Fatal(err)
			}
			expected, err := json.MarshalIndent(sealed, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			expected = append(expected, '\n')
			if string(actual) != string(expected) {
				t.Fatal("fixture differs from catalog sealer output")
			}
		})
	}
}
