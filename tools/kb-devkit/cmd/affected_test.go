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
