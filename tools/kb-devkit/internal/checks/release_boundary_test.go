package checks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// case: S-277.3
func TestReleaseBoundaryRejectsShippedWorkspaceDependencyOnInternalTool(t *testing.T) {
	root := t.TempDir()
	gatingDir := filepath.Join(root, "apps", "host")
	internalDir := filepath.Join(root, "tools", "runner")
	for _, dir := range []string{gatingDir, internalDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(gatingDir, "package.json"), []byte(`{"name":"@kb-labs/host","dependencies":{"@kb-labs/runner":"workspace:*"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(internalDir, "package.json"), []byte(`{"name":"@kb-labs/runner"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	ws := &workspace.Workspace{
		Root: root,
		Packages: []workspace.Package{
			{Name: "@kb-labs/host", Dir: gatingDir, RelPath: "apps/host", PnpmMember: true},
			{Name: "@kb-labs/runner", Dir: internalDir, RelPath: "tools/runner", ReleaseLane: "internal-tool", PnpmMember: true},
		},
	}
	results := RunAll(ws, &config.DevkitConfig{}, Default(), nil, nil)
	workspaceResult, exists := results["workspace"]
	if !exists || len(workspaceResult.Issues) != 1 {
		t.Fatalf("workspace check result = %#v, want one gating-to-internal dependency finding", workspaceResult)
	}
	for _, expected := range []string{"@kb-labs/host", "@kb-labs/runner", "workspace dependency", "gating package"} {
		if !strings.Contains(workspaceResult.Issues[0].Message, expected) {
			t.Errorf("issue %q does not identify %q", workspaceResult.Issues[0].Message, expected)
		}
	}
}

func TestReleaseBoundaryRejectsGoRequireWithoutLocalReplace(t *testing.T) {
	root := t.TempDir()
	gatingDir := filepath.Join(root, "services", "host")
	internalDir := filepath.Join(root, "tools", "runner")
	for _, dir := range []string{gatingDir, internalDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(gatingDir, "go.mod"), []byte("module example.internal/host\n\ngo 1.22.0\n\nrequire github.com/kb-labs/kb-runner v1.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(internalDir, "go.mod"), []byte("module github.com/kb-labs/kb-runner\n\ngo 1.22.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws := &workspace.Workspace{
		Root: root,
		Packages: []workspace.Package{
			{Name: "example.internal/host", Dir: gatingDir, RelPath: "services/host"},
			{Name: "github.com/kb-labs/kb-runner", Dir: internalDir, RelPath: "tools/runner", ReleaseLane: "internal-tool"},
		},
	}
	results := RunAll(ws, &config.DevkitConfig{}, Default(), []string{"release-boundary"}, nil)
	workspaceResult := results["workspace"]
	if len(workspaceResult.Issues) != 1 || !strings.Contains(workspaceResult.Issues[0].Message, `workspace dependency on internal tool "github.com/kb-labs/kb-runner"`) {
		t.Fatalf("workspace check result = %#v, want Go require boundary finding", workspaceResult)
	}
}

func TestReleaseBoundaryRejectsTransitiveGoReplaceWithoutDirectRequire(t *testing.T) {
	root := t.TempDir()
	gatingDir := filepath.Join(root, "services", "host")
	intermediateDir := filepath.Join(root, "third_party", "middle")
	internalDir := filepath.Join(root, "tools", "runner")
	for _, dir := range []string{gatingDir, intermediateDir, internalDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(gatingDir, "go.mod"), []byte("module example.internal/host\n\ngo 1.22.0\n\nrequire example.com/middle v1.0.0\n\nreplace github.com/kb-labs/kb-runner => ../../tools/runner\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(intermediateDir, "go.mod"), []byte("module example.com/middle\n\ngo 1.22.0\n\nrequire github.com/kb-labs/kb-runner v1.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(internalDir, "go.mod"), []byte("module github.com/kb-labs/kb-runner\n\ngo 1.22.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws := &workspace.Workspace{
		Root: root,
		Packages: []workspace.Package{
			{Name: "example.internal/host", Dir: gatingDir, RelPath: "services/host"},
			{Name: "github.com/kb-labs/kb-runner", Dir: internalDir, RelPath: "tools/runner", ReleaseLane: "internal-tool"},
		},
	}
	results := RunAll(ws, &config.DevkitConfig{}, Default(), []string{"release-boundary"}, nil)
	workspaceResult := results["workspace"]
	if len(workspaceResult.Issues) != 1 || !strings.Contains(workspaceResult.Issues[0].Message, `workspace dependency on internal tool "github.com/kb-labs/kb-runner"`) {
		t.Fatalf("workspace check result = %#v, want transitive local Go replace boundary finding", workspaceResult)
	}
}
