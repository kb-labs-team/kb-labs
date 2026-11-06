package checks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

func TestSemverCompatibleHandlesCommonRanges(t *testing.T) {
	tests := []struct {
		got  string
		want string
		ok   bool
	}{
		{got: "^5.6.3", want: "^5", ok: true},
		{got: "~5.6.3", want: "~5.0.0", ok: true},
		{got: "^6.0.0", want: "^5", ok: false},
		{got: "workspace:*", want: "^5", ok: false},
	}

	for _, tt := range tests {
		if got := semverCompatible(tt.got, tt.want); got != tt.ok {
			t.Fatalf("semverCompatible(%q, %q) = %v, want %v", tt.got, tt.want, got, tt.ok)
		}
	}
}

func TestRegistryRulesForGoAndRegister(t *testing.T) {
	registry := Default()
	registry.Register(fakeRule{name: "custom"})

	tsRules := registry.RulesFor(config.Preset{Language: "typescript"})
	if len(tsRules) == 0 {
		t.Fatal("RulesFor(typescript) returned no rules")
	}

	goRules := registry.RulesFor(config.Preset{Language: "go"})
	if len(goRules) != 2 || goRules[0].Name() != "structure" || goRules[1].Name() != "deps" {
		t.Fatalf("RulesFor(go) = %#v, want structure and deps", goRules)
	}

	if len(registry.All()) != len(tsRules)+1 {
		t.Fatalf("All() length = %d, want %d package rules plus workspace release boundary", len(registry.All()), len(tsRules)+1)
	}
}

func TestPackageJSONAndStructureFixersApplyDeterministicChanges(t *testing.T) {
	dir := t.TempDir()
	pkg := workspace.Package{Name: "@acme/demo", Dir: dir}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"@acme/demo","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}

	pkgRule := &PackageJSONRule{}
	if err := pkgRule.Apply(pkg, []Issue{
		{Capability: CapabilityFixable, Message: `missing required field "type"`},
		{Capability: CapabilityFixable, Message: `missing required script "build"`},
		{Capability: CapabilityFixable, Message: `missing required devDependency "typescript"`},
	}, false); err != nil {
		t.Fatalf("PackageJSONRule.Apply error: %v", err)
	}

	var raw map[string]any
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		t.Fatalf("read package.json: %v", err)
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal package.json: %v", err)
	}
	if raw["type"] != "module" {
		t.Fatalf("type = %#v", raw["type"])
	}

	structRule := &StructureRule{}
	readme := filepath.Join(dir, "README.md")
	if err := structRule.Apply(pkg, []Issue{
		{Capability: CapabilityScaffoldable, File: readme},
	}, false); err != nil {
		t.Fatalf("StructureRule.Apply error: %v", err)
	}
	if _, err := os.Stat(readme); err != nil {
		t.Fatalf("README.md not created: %v", err)
	}
}
