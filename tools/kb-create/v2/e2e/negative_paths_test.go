package e2e

import (
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	sharedtoolchain "github.com/kb-labs/clikit/toolchain"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
	"github.com/kb-labs/create/v2/preflight"
	"github.com/kb-labs/create/v2/resolve"
)

func TestV2CompatibilityFailureIsRejectedBeforeArtifactExecution(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform",
			Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		Plugins: []catalog.Component{{
			ID: "future-plugin", Version: "3.0.0", Package: "@kb/future-plugin", Tarball: "https://example.test/future-plugin.tgz", SHA256: "plugin", PlatformRange: "^3.0.0",
		}},
	}
	sealed, err := testfixtures.SealCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err = catalog.Seal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	_, err = resolve.Plan(contracts.InstallRequest{
		PlatformRoot: t.TempDir(),
		Plugins:      []contracts.ComponentRequest{{ID: "future-plugin"}},
	}, sealed)
	var launcherErr *diag.Diag
	if !errors.As(err, &launcherErr) || launcherErr.Code != contracts.CodeIncompatibleComponents {
		t.Fatalf("error = %T %#v, want %s", err, err, contracts.CodeIncompatibleComponents)
	}
}

func TestV2NetworkFailureIsReportedBeforePnpmMutation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "registry unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	root := t.TempDir()
	source, err := catalog.LoadFile(filepath.Join("..", "cmd", "kb-create-v2", "testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	verified, err := catalog.VerifyCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	platform := source.Platforms[0]
	item := contracts.Artifact{ID: platform.ID, Package: platform.Package, Version: platform.Version,
		Tarball: server.URL + "/platform.tgz", ResolvedURL: server.URL + "/platform.tgz", SHA256: platform.SHA256}
	installer, err := artifacts.NewPnpm(artifacts.PnpmConfig{Root: root, CacheRoot: filepath.Join(root, "cache"),
		PackageManagerRoot: filepath.Join(root, "state"), Registry: server.URL, ReleaseCatalog: verified, Client: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	err = installer.Install([]contracts.Artifact{item})
	if err == nil {
		t.Fatal("expected registry failure")
	}
	if _, statErr := os.Stat(filepath.Join(root, "node_modules")); !os.IsNotExist(statErr) {
		t.Fatalf("pnpm mutation started after download failure: %v", statErr)
	}
}

func TestV2ToolchainFailureIsActionableForNodeAndPnpm(t *testing.T) {
	cases := []struct {
		name     string
		versions map[string]string
		want     string
	}{
		{name: "node", versions: map[string]string{"node": "v20.18.0", "pnpm": "11.4.0"}, want: "Node.js 20.18.0 is unsupported"},
		{name: "pnpm", versions: map[string]string{"node": fmt.Sprintf("v%d.18.0", sharedtoolchain.SupportedNodeMajor), "pnpm": "10.9.0"}, want: "pnpm 11.x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := preflight.EnsureWith(func(binary string) (string, error) {
				return tc.versions[binary], nil
			}, nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}
