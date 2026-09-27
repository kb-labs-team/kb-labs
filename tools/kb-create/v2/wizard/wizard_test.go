package wizard

import (
	"bytes"
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

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
		Plugins:   []catalog.Component{{ID: "commit", Version: "1", Package: "@kb/commit", Tarball: "https://example.test/commit.tgz", SHA256: "commit"}},
		Adapters:  []catalog.Adapter{{Component: catalog.Component{ID: "state-broker", Version: "1", Package: "@kb/state", Tarball: "https://example.test/state.tgz", SHA256: "state"}, Provides: []string{"cache"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// scenario commit asks for channel, profile, then its cache provider.
	var output bytes.Buffer
	request, err := RequestScenario(source, "/platform", "commit", IO{In: bytes.NewBufferString("\n\nstate-broker\n"), Out: &output})
	if err != nil {
		t.Fatal(err)
	}
	if request.ScenarioID != "commit" || request.Platform.Channel != contracts.ChannelStable || request.ProviderPreferences["cache"] != "state-broker" {
		t.Fatalf("request = %#v", request)
	}
	machine := request
	machine.ScenarioID = "commit"
	if machine.ProviderPreferences["cache"] != request.ProviderPreferences["cache"] || len(machine.Plugins) != 1 || machine.Plugins[0].ID != "commit" {
		t.Fatalf("human/machine request mismatch: %#v / %#v", request, machine)
	}
}
