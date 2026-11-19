package cmd

import (
	"reflect"
	"testing"

	"github.com/kb-labs/devkit/internal/engine"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestPlatformAffectedScopeExcludesInternalToolsAndDeclaresPartialChecks(t *testing.T) {
	input := engine.AffectedSelection{Packages: []workspace.Package{
		{Name: "@kb-labs/core", ReleaseLane: "shipped"},
		{Name: "kb-runner", ReleaseLane: "internal-tool"},
	}}
	selected, excluded := selectionForScope(input, "platform")
	if len(selected.Packages) != 1 || selected.Packages[0].Name != "@kb-labs/core" {
		t.Fatalf("platform packages = %#v, want only shipped packages", selected.Packages)
	}
	if !reflect.DeepEqual(excluded, []string{"kb-runner"}) {
		t.Fatalf("excluded packages = %#v, want kb-runner", excluded)
	}
	manifest := platformScopeManifest(excluded)
	if manifest.Status != "partial" || !reflect.DeepEqual(manifest.ExcludedPackages, excluded) {
		t.Fatalf("platform scope manifest = %#v, want partial with exclusions", manifest)
	}
	if len(manifest.ExcludedChecks) == 0 || manifest.Warning == "" {
		t.Fatalf("platform scope must name omitted checks and warn: %#v", manifest)
	}
}

func TestDefaultAffectedScopePreservesFullSelection(t *testing.T) {
	input := engine.AffectedSelection{Packages: []workspace.Package{
		{Name: "@kb-labs/core", ReleaseLane: "shipped"},
		{Name: "kb-runner", ReleaseLane: "internal-tool"},
	}}
	selected, excluded := selectionForScope(input, "")
	if !reflect.DeepEqual(selected.Packages, input.Packages) || len(excluded) != 0 {
		t.Fatalf("default selection = %#v, exclusions = %#v; want unchanged full selection", selected, excluded)
	}
}
