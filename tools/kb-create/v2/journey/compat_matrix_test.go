package journey_test

import (
	"encoding/json"
	"errors"
	"github.com/kb-labs/clikit/diag"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/resolve"
)

// The launcher <-> release-index compatibility matrix. Every case runs on an
// in-repo fixture index through the same path the launcher uses (Decode, then
// PlanWith), with no network. Running it on linux, macOS and Windows is a CI
// concern; the target OS/arch is pinned here so the result is host-independent.

const (
	fixtureVersion = "2.0.0"
	targetOS       = "linux"
	targetArch     = "amd64"
)

type fixtureOptions struct {
	minLauncher      string
	unrelatedBinary  bool
	binaryPlatformOS string // OS the fixture binary is built for
}

// fixtureIndex returns the sealed JSON of a small but complete release index.
func fixtureCatalog(t *testing.T, options fixtureOptions) catalog.Catalog {
	t.Helper()
	binaryOS := options.binaryPlatformOS
	if binaryOS == "" {
		binaryOS = targetOS
	}
	var source catalog.Catalog
	if err := json.Unmarshal(testfixtures.ReleaseIndexJSON(fixtureVersion, fixtureVersion, binaryOS, targetArch), &source); err != nil {
		t.Fatal(err)
	}
	source.Platforms[0].MinLauncherVersion = options.minLauncher
	source.Platforms[0].Host = testHost()
	source.Platforms[0].SupportedTargets = []catalog.BinaryTarget{{OS: targetOS, Arch: targetArch}}
	if options.unrelatedBinary {
		source.Compatibility.Labels[2].Requires = nil
	}
	return source
}

func fixtureIndex(t *testing.T, options fixtureOptions) []byte {
	t.Helper()
	source, err := catalog.Seal(fixtureCatalog(t, options))
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// install is what the launcher does with an index: load it, then resolve.
func installIndex(data []byte, launcher string) error {
	source, err := catalog.Decode(data)
	if err != nil {
		return err
	}
	request := contracts.InstallRequest{PlatformRoot: "/tmp/kb-compat", SDK: contracts.VersionSelector{Version: fixtureVersion}}
	_, err = resolve.PlanWith(request, source, resolve.Options{LauncherVersion: launcher, OS: targetOS, Arch: targetArch})
	return err
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *diag.Diag
	if !errors.As(err, &typed) {
		t.Fatalf("expected typed launcher error %s, got %v", code, err)
	}
	if typed.Code != code {
		t.Fatalf("code = %s (%s), want %s", typed.Code, typed.Message, code)
	}
	if typed.Hint == "" {
		t.Fatalf("%s must carry a hint", code)
	}
}

func TestCompatibilityMatrix(t *testing.T) {
	t.Run("fresh resolve ok", func(t *testing.T) {
		if err := installIndex(fixtureIndex(t, fixtureOptions{}), "2.0.0"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("launcher exactly at minimum is accepted, dev build is unconstrained", func(t *testing.T) {
		data := fixtureIndex(t, fixtureOptions{minLauncher: "2.0.0"})
		for _, launcher := range []string{"2.0.0", "2.1.0", "dev"} {
			if err := installIndex(data, launcher); err != nil {
				t.Fatalf("launcher %s: %v", launcher, err)
			}
		}
	})
	t.Run("index schema newer", func(t *testing.T) {
		data := fixtureIndex(t, fixtureOptions{})
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		raw["schema"] = "kb.create.release-index/v99"
		// A v3 index may have a different shape entirely; it must be rejected
		// on its schema, before any field is interpreted.
		raw["platforms"] = "topology moved to a single host"
		newer, _ := json.Marshal(raw)
		requireCode(t, installIndex(newer, "2.0.0"), contracts.CodeIndexSchemaUnsupported)
	})
	t.Run("index schema unknown", func(t *testing.T) {
		requireCode(t, installIndex([]byte(`{"schema":"something-else"}`), "2.0.0"), contracts.CodeIndexSchemaUnsupported)
	})
	t.Run("launcher too old", func(t *testing.T) {
		err := installIndex(fixtureIndex(t, fixtureOptions{minLauncher: "2.1.0"}), "2.0.0")
		requireCode(t, err, contracts.CodeLauncherTooOld)
		if !strings.Contains(err.Error(), "2.1.0") {
			t.Fatalf("message should name the required version: %v", err)
		}
	})
	t.Run("platform without sdk relation", func(t *testing.T) {
		data := fixtureIndex(t, fixtureOptions{})
		var source catalog.Catalog
		if err := json.Unmarshal(data, &source); err != nil {
			t.Fatal(err)
		}
		source.Compatibility.Labels[0].Requires = nil
		invalid, err := json.Marshal(source)
		if err != nil {
			t.Fatal(err)
		}
		_, err = catalog.Decode(invalid)
		var typed *diag.Diag
		if !errors.As(err, &typed) || typed.Code != contracts.CodeReleaseIndexInvalid ||
			!strings.Contains(typed.Reason, "platform 2.0.0 compatibility label") || !strings.Contains(typed.Reason, "has no SDK relation") {
			t.Fatalf("Decode error = %#v, want typed invalid-index error for missing platform SDK relation", err)
		}
	})
	t.Run("binary not related to platform or sdk", func(t *testing.T) {
		_, err := catalog.Seal(fixtureCatalog(t, fixtureOptions{unrelatedBinary: true}))
		if err == nil || !strings.Contains(err.Error(), "shipped binary") {
			t.Fatalf("Seal error = %v, want rejection for shipped binary without platform relation", err)
		}
	})
	t.Run("corrupt digest", func(t *testing.T) {
		data := fixtureIndex(t, fixtureOptions{})
		tampered := strings.Replace(string(data), "@kb/platform", "@kb/tampered", 1)
		requireCode(t, installIndex([]byte(tampered), "2.0.0"), contracts.CodeReleaseIndexInvalid)
	})
	t.Run("all binary artifacts missing", func(t *testing.T) {
		source := fixtureCatalog(t, fixtureOptions{})
		source.Platforms[0].Binaries = nil
		source.Compatibility.Labels = source.Compatibility.Labels[:2]
		sealed, err := catalog.Seal(source)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(sealed)
		if err != nil {
			t.Fatal(err)
		}
		requireCode(t, installIndex(data, "2.0.0"), contracts.CodeIncompatibleComponents)
	})
	t.Run("missing binary for os/arch", func(t *testing.T) {
		requireCode(t, installIndex(fixtureIndex(t, fixtureOptions{binaryPlatformOS: "windows"}), "2.0.0"), contracts.CodeIncompatibleComponents)
	})
}
