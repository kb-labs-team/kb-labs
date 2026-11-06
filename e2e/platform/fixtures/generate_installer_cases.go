// Generate the small, sealed release indexes used by the installer journeys.
// From tools/kb-create/v2 run:
//
//	go run ../../../e2e/platform/fixtures/generate_installer_cases.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

const fixtureVersion = "3.2.0"

func label(id, kind, artifact, version string, requires ...string) catalog.CompatibilityLabel {
	value := catalog.CompatibilityLabel{ID: id, Kind: kind, ArtifactID: artifact, Version: version, Status: "prepared", ValidatedBy: []string{"installer-journey-fixture"}}
	for _, relation := range requires {
		value.Requires = append(value.Requires, catalog.CompatibilityRelation{Label: relation, Constraint: ">=3.0.0 <4.0.0"})
	}
	return value
}

func fixtureCatalog(hasRunnerBinary bool, runnerOS, runnerArch string) catalog.Catalog {
	platform := catalog.PlatformBundle{
		ID: "platform", Version: fixtureVersion, Package: "@kb/fixture-platform",
		SupportedTargets: []catalog.BinaryTarget{{OS: runnerOS, Arch: runnerArch}},
		Tarball:          "https://example.test/fixture-platform.tgz", SHA256: "fixture-platform-sha256",
		SDKRange: ">=3.0.0 <4.0.0", Host: &contracts.HostSpec{Command: "node_modules/.bin/kb-host", HealthURL: "http://127.0.0.1:4000/health"},
		Profiles: map[string]contracts.ServiceGraph{"default": {PlatformVersion: fixtureVersion}},
	}
	if hasRunnerBinary {
		platform.Binaries = []catalog.Binary{{ID: "kb-create", OS: runnerOS, Arch: runnerArch, URL: "https://example.test/kb-create", SHA256: "fixture-binary-sha256", Filename: "kb-create"}}
	} else {
		foreignOS := "linux"
		if runnerOS == "linux" {
			foreignOS = "darwin"
		}
		platform.Binaries = []catalog.Binary{{ID: "kb-create", OS: foreignOS, Arch: runnerArch, URL: "https://example.test/kb-create", SHA256: "fixture-binary-sha256", Filename: "kb-create"}}
	}
	labels := []catalog.CompatibilityLabel{
		label("platform@3.2.0", "platform", "platform", "3.2.0", "sdk@3.0.0"),
		label("sdk@3.0.0", "sdk", "sdk", "3.0.0"), label("sdk@3.2.0", "sdk", "sdk", "3.2.0"), label("sdk@4.0.0", "sdk", "sdk", "4.0.0"),
	}
	binary := platform.Binaries[0]
	labels = append(labels, catalog.CompatibilityLabel{
		ID: fmt.Sprintf("binary:kb-create@3.2.0:%s/%s", binary.OS, binary.Arch), Kind: "binary", ArtifactID: "kb-create", Version: fixtureVersion,
		Requires: []catalog.CompatibilityRelation{{Label: "platform@3.2.0"}, {Label: "sdk@3.0.0"}, {Label: "sdk@3.2.0"}}, Status: "prepared", ValidatedBy: []string{"installer-journey-fixture"},
	})
	return catalog.Catalog{
		Channels:      map[contracts.Channel]string{contracts.ChannelStable: fixtureVersion},
		Compatibility: &catalog.CompatibilityMatrix{Schema: catalog.CompatibilitySchema, Labels: labels},
		Platforms:     []catalog.PlatformBundle{platform},
		SDKs: []catalog.Component{
			{ID: "sdk", Version: "3.0.0", Package: "@kb/fixture-sdk", Tarball: "https://example.test/fixture-sdk-3.0.0.tgz", SHA256: "fixture-sdk-3.0.0"},
			{ID: "sdk", Version: "3.2.0", Package: "@kb/fixture-sdk", Tarball: "https://example.test/fixture-sdk-3.2.0.tgz", SHA256: "fixture-sdk-3.2.0"},
			{ID: "sdk", Version: "4.0.0", Package: "@kb/fixture-sdk", Tarball: "https://example.test/fixture-sdk-4.0.0.tgz", SHA256: "fixture-sdk-4.0.0"},
		},
		Plugins: []catalog.Component{
			{ID: "fixture-plugin", Version: "1.0.0", Package: "@kb/fixture-plugin", Tarball: "https://example.test/fixture-plugin-1.0.0.tgz", SHA256: "fixture-plugin", PlatformRange: "<3.2.0"},
			{ID: "fixture-compat", Version: "1.0.0", Package: "@kb/fixture-compat", Tarball: "https://example.test/fixture-compat-1.0.0.tgz", SHA256: "fixture-compat", PlatformRange: "<3.2.0"},
			{ID: "fixture-sdk-incompat", Version: "1.0.0", Package: "@kb/fixture-sdk-incompat", Tarball: "https://example.test/fixture-sdk-incompat-1.0.0.tgz", SHA256: "fixture-sdk-incompat", PlatformRange: ">=3.0.0", SDKRange: "<3.0.0"},
		},
		Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "fixture-adapter", Version: "1.0.0", Package: "@kb/fixture-adapter", Tarball: "https://example.test/fixture-adapter-1.0.0.tgz", SHA256: "fixture-adapter", PlatformRange: "<3.2.0"}, Provides: []string{"fixtureCapability"}}},
	}
}

func main() {
	outDir := filepath.Join("..", "..", "..", "e2e", "platform", "fixtures", "installer-cases")
	if len(os.Args) == 2 {
		outDir = os.Args[1]
	}
	if err := os.MkdirAll(outDir, 0o750); err != nil {
		fatal(err)
	}
	for _, target := range []struct{ os, arch string }{{"linux", "amd64"}, {"linux", "arm64"}, {"darwin", "amd64"}, {"darwin", "arm64"}} {
		for name, hasRunnerBinary := range map[string]bool{"compatibility-matrix": true, "missing-host-binary": false} {
			filename := fmt.Sprintf("%s-%s-%s.json", name, target.os, target.arch)
			sealed, err := catalog.Seal(fixtureCatalog(hasRunnerBinary, target.os, target.arch))
			if err != nil {
				fatal(fmt.Errorf("seal %s: %w", filename, err))
			}
			data, err := json.MarshalIndent(sealed, "", "  ")
			if err != nil {
				fatal(err)
			}
			if err := os.WriteFile(filepath.Join(outDir, filename), append(data, '\n'), 0o600); err != nil {
				fatal(err)
			}
		}
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
