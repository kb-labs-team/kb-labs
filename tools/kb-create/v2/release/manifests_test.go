package release

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/installed"
)

// case: S-179.14
func TestEnrichWithManifestsRejectsPluginIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	packageRoot := filepath.Join(root, "node_modules", "@kb-labs", "plugin-entry")
	if err := os.MkdirAll(packageRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	manifest := installed.Manifest{
		Schema: installed.ManifestSchema,
		ID: "@kb-labs/manifest-id",
		Package: "@kb-labs/plugin",
		Version: "1.0.0",
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(packageRoot, "kb-create.manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = EnrichWithManifests(catalog.Catalog{
		Plugins: []catalog.Component{{ID: "@kb-labs/wrong-id", Package: manifest.Package, Version: manifest.Version}},
	}, root)
	if err == nil {
		t.Fatal("expected plugin identity mismatch to be rejected before sealing")
	}
}

func TestEnrichWithManifestsReplacesReleaseConfigProjection(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "node_modules", "@kb", "platform")
	if err := os.MkdirAll(path, 0o750); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"schema":"kb.create.artifact-manifest/v2","id":"platform","package":"@kb/platform","version":"2.0.0","requirements":[{"id":"gateway.mode","path":"/gateway/mode","required":true,"default":"\"secure\""},{"id":"gateway.token","secret":true,"generate":true,"required":true,"env":"GATEWAY_TOKEN","services":["gateway"]}]}`)
	if err := os.WriteFile(filepath.Join(path, "kb-create.manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	source := catalog.Catalog{Platforms: []catalog.PlatformBundle{{ID: "platform", Package: "@kb/platform", Version: "2.0.0", Config: []catalog.ConfigRequirement{{ID: "stale"}}}}}
	got, err := EnrichWithManifests(source, root)
	if err != nil || len(got.Platforms[0].Config) != 2 || got.Platforms[0].Config[0].ID != "gateway.mode" || got.Platforms[0].Config[1].Env != "GATEWAY_TOKEN" || !got.Platforms[0].Config[1].Generate {
		t.Fatalf("catalog/error = %#v / %v", got, err)
	}
}

func TestRequirementsRejectsSecretDefault(t *testing.T) {
	_, err := requirements([]doctor.Requirement{{ID: "token", Secret: true, Env: "TOKEN", Services: []string{"gateway"}, Default: []byte(`"unsafe"`)}})
	var ruleErr *ManifestRuleError
	if !errors.As(err, &ruleErr) {
		t.Fatalf("error = %v, want ManifestRuleError", err)
	}
	if ruleErr.Hint != "Remove the default from secret requirement token, then rerun release-index preparation." {
		t.Fatalf("hint = %q", ruleErr.Hint)
	}
}

func TestRequirementsSecretBindingRuleHasSpecificHint(t *testing.T) {
	_, err := requirements([]doctor.Requirement{{ID: "token", Secret: true}})
	var ruleErr *ManifestRuleError
	if !errors.As(err, &ruleErr) {
		t.Fatalf("error = %v, want ManifestRuleError", err)
	}
	if ruleErr.Hint != "Declare env and services for secret requirement token, then rerun release-index preparation." {
		t.Fatalf("hint = %q", ruleErr.Hint)
	}
}

func TestRequirementsPreserveOptionalCredentialWarningMetadata(t *testing.T) {
	items, err := requirements([]doctor.Requirement{{ID: "openai.apiKey", Path: "/platform/adapterOptions/llm/apiKey", Required: true, Optional: true, Secret: true, Env: "OPENAI_API_KEY", Services: []string{"gateway"}, Action: "set OPENAI_API_KEY to enable LLM features"}})
	if err != nil || len(items) != 1 || !items[0].Optional || items[0].Action != "set OPENAI_API_KEY to enable LLM features" {
		t.Fatalf("projected requirements/error = %#v / %v", items, err)
	}
}
