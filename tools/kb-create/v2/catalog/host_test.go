package catalog

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

func platformWithHost(host *contracts.HostSpec) Catalog {
	return Catalog{
		Channels:  map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", Tarball: "https://example.test/platform.tgz", SHA256: "artifact", Host: host, Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	}
}

// Every platform runs as one supervised host, so the release must say how: a
// platform bundle without a host is a release mistake, caught when the index is
// sealed and again when it is loaded.
func TestValidateRequiresEveryPlatformToDeclareAValidHost(t *testing.T) {
	if _, err := Seal(platformWithHost(nil)); err == nil || !strings.Contains(err.Error(), "declares no host") {
		t.Fatalf("a platform without a host must not seal: %v", err)
	}
	remote := &contracts.HostSpec{Command: "kb-host", HealthURL: "http://example.com:4000/health"}
	if _, err := Seal(platformWithHost(remote)); err == nil || !strings.Contains(err.Error(), "invalid host") {
		t.Fatalf("a host that is not on loopback must not seal: %v", err)
	}
	broken := &contracts.HostSpec{Command: "kb-host", HealthURL: "http://127.0.0.1:4000/health", Recover: &contracts.ToolSpec{}}
	if _, err := Seal(platformWithHost(broken)); err == nil || !strings.Contains(err.Error(), "recover command") {
		t.Fatalf("a recovery tool without a command must not seal: %v", err)
	}
}

func TestSealedIndexCarriesTheHostAndItsRecoveryTool(t *testing.T) {
	declared := &contracts.HostSpec{Command: "node_modules/.bin/kb-host", HealthURL: "http://127.0.0.1:4000/health", Recover: &contracts.ToolSpec{Command: "node_modules/.bin/kb-recover"}}
	sealed, err := Seal(platformWithHost(declared))
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(sealed)
	if err != nil {
		t.Fatal(err)
	}
	var loaded Catalog
	if err := json.Unmarshal(data, &loaded); err != nil {
		t.Fatal(err)
	}
	if err := Verify(loaded); err != nil {
		t.Fatalf("the digest must cover the host declaration: %v", err)
	}
	loaded.Platforms[0].Host.Command = "tampered"
	if Verify(loaded) == nil {
		t.Fatal("changing the host after sealing must break the digest")
	}
	loaded.Platforms[0].Host.Command = declared.Command
	host := loaded.Platforms[0].Host
	if host == nil || host.Command != declared.Command || host.HealthURL != declared.HealthURL || host.Recover == nil || host.Recover.Command != "node_modules/.bin/kb-recover" {
		t.Fatalf("host = %#v", host)
	}
}
