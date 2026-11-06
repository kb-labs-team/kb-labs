package wizard

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

// case: S-187.7
func TestRequestScenarioUsesSharedProjectSelectionValidation(t *testing.T) {
	source, err := catalog.Seal(catalog.Catalog{
		Channels:  map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	platformRoot := filepath.Join(base, "platform")
	_, err = RequestScenario(source, platformRoot, "explore", filepath.Join(base, "missing-project"), IO{
		In: bytes.NewBufferString("\n\n"), Out: &bytes.Buffer{},
	})
	var validation *contracts.RequestValidationError
	if !errors.As(err, &validation) || validation.Field != "projectRoot" || validation.Diagnostic().Code != contracts.CodeInputRequired {
		t.Fatalf("RequestScenario() error = %T %v, want shared projectRoot request validation", err, err)
	}
	if _, statErr := os.Stat(platformRoot); !os.IsNotExist(statErr) {
		t.Fatalf("wizard validation created platform root: stat error = %v", statErr)
	}
}

func TestRequestBuildsSharedCompatibleRequest(t *testing.T) {
	source, err := catalog.Seal(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}, Plugins: []catalog.Component{{ID: "review", Version: "1", Package: "@kb/review", Tarball: "https://example.test/review.tgz", SHA256: "review"}}, Adapters: []catalog.Adapter{{Component: catalog.Component{ID: "pino", Version: "1", Package: "@kb/pino", Tarball: "https://example.test/pino.tgz", SHA256: "pino"}}}})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	request, err := Request(source, "/platform", IO{In: bytes.NewBufferString("\n\nreview\npino\n"), Out: &output})
	if err != nil {
		t.Fatal(err)
	}
	if request.Policy != contracts.PolicyCompatible || request.Platform.Channel != contracts.ChannelStable || len(request.Plugins) != 1 || request.Plugins[0].ID != "review" || len(request.Adapters) != 1 {
		t.Fatalf("request = %#v", request)
	}
}

func TestRequestRejectsUnknownInteractiveChoice(t *testing.T) {
	source, _ := catalog.Seal(catalog.Catalog{Channels: map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"}, Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}}})
	if _, err := Request(source, "/platform", IO{In: bytes.NewBufferString("broken\n"), Out: &bytes.Buffer{}}); err == nil {
		t.Fatal("expected invalid choice")
	}
}

func TestRequestScenarioCompilesSameDeclarativeAnswersAsMachineRequest(t *testing.T) {
	source, err := catalog.Seal(catalog.Catalog{
		Channels:  map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "platform", Host: &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health"}, Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
		Plugins:   []catalog.Component{{ID: "@kb-labs/commit", Version: "1", Package: "@kb-labs/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}},
		Adapters:  []catalog.Adapter{{Component: catalog.Component{ID: "state-broker", Version: "1", Package: "@kb/state", Tarball: "https://example.test/state.tgz", SHA256: "state"}, Provides: []string{"cache"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Provider metadata supplies the scenario default, so only channel/profile
	// are prompted and this journey works with a finite non-terminal reader.
	var output bytes.Buffer
	projectRoot := t.TempDir()
	projectRoot, err = filepath.EvalSymlinks(projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	request, err := RequestScenario(source, "/platform", "commit", projectRoot, IO{In: bytes.NewBufferString("\n\n"), Out: &output})
	if err != nil {
		t.Fatal(err)
	}
	if request.ScenarioID != "commit" || request.Platform.Channel != contracts.ChannelStable || request.ProviderPreferences["cache"] != "state-broker" || request.ProjectRoot != projectRoot {
		t.Fatalf("request = %#v", request)
	}
	if bytes.Contains(output.Bytes(), []byte("Cache provider")) {
		t.Fatalf("infrastructure provider should use its declared default: %s", output.String())
	}
	interactiveProject := t.TempDir()
	interactiveProject, err = filepath.EvalSymlinks(interactiveProject)
	if err != nil {
		t.Fatal(err)
	}
	var interactiveOutput bytes.Buffer
	interactive, err := RequestScenario(source, "/platform", "commit", "", IO{
		In:  bytes.NewBufferString(interactiveProject + "\n\n\n"),
		Out: &interactiveOutput,
	})
	if err != nil {
		t.Fatal(err)
	}
	if interactive.ProjectRoot != interactiveProject || !bytes.Contains(interactiveOutput.Bytes(), []byte("Project directory")) {
		t.Fatalf("interactive project selection = %#v, output=%s", interactive, interactiveOutput.String())
	}
	machine := request
	machine.ScenarioID = "commit"
	if machine.ProviderPreferences["cache"] != request.ProviderPreferences["cache"] || len(machine.MarketplaceInstallSpecs) != 1 || machine.MarketplaceInstallSpecs[0] != "@kb-labs/commit" {
		t.Fatalf("human/machine request mismatch: %#v / %#v", request, machine)
	}
}
