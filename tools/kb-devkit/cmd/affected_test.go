package cmd

import (
	"reflect"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestPackageNamesWithTaskSkipsAffectedPackagesWithoutTaskVariant(t *testing.T) {
	ws := &workspace.Workspace{}
	packages := []workspace.Package{
		{Name: "@fixture/daemon", Category: "service"},
		{Name: "@fixture/e2e", Category: "e2e-suite"},
	}
	cfg := &config.DevkitConfig{Tasks: map[string]config.TaskConfig{
		"test": {{Categories: []string{"service"}, Command: "go test ./..."}},
	}}

	got := packageNamesWithTask(ws, cfg, packages, "test")
	if want := []string{"@fixture/daemon"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("packages with test task = %v, want %v", got, want)
	}
}

func TestPackageNamesWithTaskReturnsEmptyWhenNoSelectedPackageOwnsTask(t *testing.T) {
	ws := &workspace.Workspace{}
	packages := []workspace.Package{{Name: "@fixture/e2e", Category: "e2e-suite"}}
	cfg := &config.DevkitConfig{Tasks: map[string]config.TaskConfig{
		"test": {{Categories: []string{"service"}, Command: "go test ./..."}},
	}}

	if got := packageNamesWithTask(ws, cfg, packages, "test"); len(got) != 0 {
		t.Fatalf("packages with test task = %v, want empty", got)
	}
}

// case: S-310.1
func TestPackageNamesWithTaskPolicyReportsOnlyExactManualOverride(t *testing.T) {
	ws := &workspace.Workspace{}
	packages := []workspace.Package{
		{Name: "github.com/kb-labs/kb-runner", Category: "internal-tool"},
		{Name: "github.com/kb-labs/kb-devkit", Category: "internal-tool"},
	}
	cfg := &config.DevkitConfig{Tasks: map[string]config.TaskConfig{"test": {
		{Categories: []string{"internal-tool"}, Packages: []string{"github.com/kb-labs/kb-runner"}, Command: "make test", ManualOnly: true},
		{Categories: []string{"internal-tool"}, Command: "make test"},
	}}}
	automatic, skipped := packageNamesWithTaskPolicy(ws, cfg, packages, "test")
	if !reflect.DeepEqual(automatic, []string{"github.com/kb-labs/kb-devkit"}) {
		t.Fatalf("automatic test packages = %v, want only active DevKit tool", automatic)
	}
	wantSkipped := []skippedManualTask{{Package: "github.com/kb-labs/kb-runner", Task: "test", Reason: "manual-only; run explicitly with --packages"}}
	if !reflect.DeepEqual(skipped, wantSkipped) {
		t.Fatalf("skipped manual tasks = %+v, want %+v", skipped, wantSkipped)
	}
}
