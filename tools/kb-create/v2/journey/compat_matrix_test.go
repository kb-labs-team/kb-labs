package journey_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
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
	omitSDKRelation  bool
	unrelatedBinary  bool
	binaryPlatformOS string // OS the fixture binary is built for
}

func label(id, kind, artifact string, requires ...string) catalog.CompatibilityLabel {
	value := catalog.CompatibilityLabel{ID: id, Kind: kind, ArtifactID: artifact, Version: fixtureVersion, Status: "prepared", ValidatedBy: []string{"stage"}}
	for _, item := range requires {
		value.Requires = append(value.Requires, catalog.CompatibilityRelation{Label: item})
	}
	return value
}

// fixtureIndex returns the sealed JSON of a small but complete release index.
func fixtureIndex(t *testing.T, options fixtureOptions) []byte {
	t.Helper()
	binaryOS := options.binaryPlatformOS
	if binaryOS == "" {
		binaryOS = targetOS
	}
	platformLabel := label("platform@"+fixtureVersion, "platform", "platform", "sdk@"+fixtureVersion)
	if options.omitSDKRelation {
		platformLabel.Requires = nil
	}
	binaryLabel := label("binary:kb-create@"+fixtureVersion+":"+binaryOS+"/"+targetArch, "binary", "kb-create", "platform@"+fixtureVersion, "sdk@"+fixtureVersion)
	if options.unrelatedBinary {
		binaryLabel.Requires = nil
	}
	source, err := catalog.Seal(catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: fixtureVersion},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: []catalog.CompatibilityLabel{
			platformLabel, label("sdk@"+fixtureVersion, "sdk", "sdk"), binaryLabel,
		}},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: fixtureVersion, Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			MinLauncherVersion: options.minLauncher,
			Profiles:           map[string]contracts.ServiceGraph{"default": {}},
			Binaries:           []catalog.Binary{{ID: "kb-create", OS: binaryOS, Arch: targetArch, URL: "https://example.test/kb-create", SHA256: "binary", Filename: "kb-create"}},
		}},
		SDKs: []catalog.Component{{ID: "sdk", Version: fixtureVersion, Package: "@kb/sdk", Tarball: "https://example.test/sdk.tgz", SHA256: "sdk"}},
	})
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
	var typed *contracts.LauncherError
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
		raw["schema"] = "kb.create.release-index/v3"
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
		requireCode(t, installIndex(fixtureIndex(t, fixtureOptions{omitSDKRelation: true}), "2.0.0"), contracts.CodeIncompatibleComponents)
	})
	t.Run("binary not related to platform or sdk", func(t *testing.T) {
		requireCode(t, installIndex(fixtureIndex(t, fixtureOptions{unrelatedBinary: true}), "2.0.0"), contracts.CodeIncompatibleComponents)
	})
	t.Run("corrupt digest", func(t *testing.T) {
		data := fixtureIndex(t, fixtureOptions{})
		tampered := strings.Replace(string(data), "@kb/platform", "@kb/tampered", 1)
		requireCode(t, installIndex([]byte(tampered), "2.0.0"), contracts.CodeReleaseIndexInvalid)
	})
	t.Run("missing binary for os/arch", func(t *testing.T) {
		requireCode(t, installIndex(fixtureIndex(t, fixtureOptions{binaryPlatformOS: "windows"}), "2.0.0"), contracts.CodeIncompatibleComponents)
	})
}
