package e2e

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/preflight"
	"github.com/kb-labs/create/v2/resolve"
)

func TestV2CompatibilityFailureIsRejectedBeforeArtifactExecution(t *testing.T) {
	source := catalog.Catalog{
		Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{
			ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform",
			Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}},
		}},
		Plugins: []catalog.Component{{
			ID: "future-plugin", Version: "3.0.0", Package: "@kb/future-plugin", SHA256: "plugin", PlatformRange: "^3.0.0",
		}},
	}
	_, err := resolve.Plan(contracts.InstallRequest{
		PlatformRoot: t.TempDir(),
		Plugins:      []contracts.ComponentRequest{{ID: "future-plugin"}},
	}, source)
	var launcherErr *contracts.LauncherError
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
	err := (artifacts.Pnpm{
		Root:   root,
		Client: server.Client(),
	}).Install([]contracts.Artifact{{
		ID: "platform", Package: "@kb/platform", Version: "2.0.0",
		Tarball: server.URL + "/platform.tgz", SHA256: "not-the-response",
	}})
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
		{name: "node", versions: map[string]string{"node": "v20.18.0", "pnpm": "11.4.0"}, want: "Node.js 24.x only"},
		{name: "pnpm", versions: map[string]string{"node": "v24.18.0", "pnpm": "10.9.0"}, want: "pnpm 11.x"},
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
