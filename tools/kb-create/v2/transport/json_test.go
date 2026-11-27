package transport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/internal/testfixtures"
)

func TestPlanUsesOnlyV2JSONRequestAndCatalog(t *testing.T) {
	source := testfixtures.MustSealCatalog(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "sha", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}})
	root := filepath.Join(t.TempDir(), "platform")
	input, err := json.Marshal(contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: root, Source: contracts.SourceRegistry})
	if err != nil {
		t.Fatal(err)
	}
	response := Plan(input, source)
	canonicalParent, err := filepath.EvalSymlinks(filepath.Dir(root))
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.Plan == nil || response.Plan.Request.PlatformRoot != filepath.Join(canonicalParent, filepath.Base(root)) {
		t.Fatalf("response = %#v", response)
	}
}
func TestPlanReturnsStructuredFailureForBadRequest(t *testing.T) {
	response := Plan([]byte(`not-json`), catalog.Catalog{})
	if response.OK || response.Error == nil || response.Error.Code == "" {
		t.Fatalf("response = %#v", response)
	}
}

// case: S-039.4
func TestPlanPreservesRequestValidationFieldAndCorrection(t *testing.T) {
	response := Plan([]byte(`{"schema":"kb.create/v2","platformRoot":""}`), catalog.Catalog{})
	if response.OK || response.Error == nil || response.Error.Code != contracts.CodeInputRequired {
		t.Fatalf("response = %#v", response)
	}
	if response.Error.Meta["field"] != "platformRoot" ||
		!strings.Contains(response.Error.Hint, "platformRoot") || !strings.Contains(response.Error.Hint, "request JSON") {
		t.Fatalf("validation response omitted field or correction: %#v", response.Error)
	}
}

// case: S-187.8
func TestPlanRejectsMissingProjectRootBeforePlatformMutation(t *testing.T) {
	base := t.TempDir()
	platformRoot := filepath.Join(base, "platform")
	projectRoot := filepath.Join(base, "missing-project")
	data := []byte(`{"schema":"kb.create/v2","platformRoot":"` + platformRoot + `","projectRoot":"` + projectRoot + `"}`)
	response := Plan(data, catalog.Catalog{})
	if response.OK || response.Error == nil || response.Error.Code != contracts.CodeInputRequired || response.Error.Meta["field"] != "projectRoot" {
		t.Fatalf("response = %#v, want typed projectRoot input error", response)
	}
	if !strings.Contains(response.Error.Hint, contracts.ShellCommand("mkdir", "-p", projectRoot)) || !strings.Contains(response.Error.Hint, "existing project directory") {
		t.Fatalf("validation hint omitted the project correction: %#v", response.Error)
	}
	if _, err := os.Stat(platformRoot); !os.IsNotExist(err) {
		t.Fatalf("planning request created platform root: stat error = %v", err)
	}
}

func TestPlanAcceptsWizardRequestEnvelopeUnchanged(t *testing.T) {
	source := testfixtures.MustSealCatalog(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "sha", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}})
	response := Plan([]byte(`{"ok":true,"request":{"schema":"kb.create/v2","platform":{"channel":"stable"},"platformRoot":"./kb-platform"}}`), source)
	if !response.OK || response.Plan == nil || !filepath.IsAbs(response.Plan.Request.PlatformRoot) {
		t.Fatalf("response = %#v", response)
	}
}
