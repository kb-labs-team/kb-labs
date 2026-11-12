package engine

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// Seam: the release configuration's resolver (producer of the platform's
// package names) -> devkit's --packages build closure (consumer). The test
// runs both for real; devkit itself never reads the release configuration.
// case: S-179.47
func TestReleasePlatformRootsBuildClosureContainsTheCliAndNoSite(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
	cfg, err := config.LoadFile(filepath.Join(root, "devkit.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(ws.Root, "tools", "kb-create", "scripts", "release-flow-roots.mjs")
	out, err := exec.Command("node", script, "platform").Output()
	if err != nil {
		t.Fatalf("release-flow-roots resolver failed (Node 24 must be on PATH): %v", err)
	}
	roots := ws.FilterByName(strings.Split(strings.TrimSpace(string(out)), ","))
	closure, err := expandBuildDependencyClosure(roots, ws.Packages)
	if err != nil {
		t.Fatal(err)
	}
	names := make(map[string]bool, len(closure))
	for _, pkg := range closure {
		names[pkg.Name] = true
		if strings.HasPrefix(pkg.RelPath, "sites/") {
			t.Errorf("closure contains site package %s (%s)", pkg.Name, pkg.RelPath)
		}
	}
	for _, want := range []string{"@kb-labs/cli-bin", "@kb-labs/core-runtime", "@kb-labs/sdk"} {
		if !names[want] {
			t.Errorf("closure lacks %s", want)
		}
	}
	if len(closure) >= len(ws.Packages) {
		t.Errorf("closure has %d of %d workspace packages; it must be a strict subset", len(closure), len(ws.Packages))
	}
}
