package resolve

import (
	"testing"

	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
)

func hostCatalog(host *contracts.HostSpec) catalog.Catalog {
	return catalog.Catalog{
		Channels:  map[contracts.Channel]string{contracts.ChannelStable: "2.0.0"},
		Platforms: []catalog.PlatformBundle{{ID: "platform", Version: "2.0.0", Package: "@kb/platform", SHA256: "platform", Host: host, Profiles: map[string]contracts.ServiceGraph{"default": {}}}},
	}
}

// The plan is the only product decision the runtime executes, so the host the
// launcher will run must be in it, copied from the platform the user selected.
func TestPlanCarriesThePlatformsHost(t *testing.T) {
	declared := &contracts.HostSpec{Command: "node_modules/.bin/kb-host", Args: []string{"--flag"}, HealthURL: "http://127.0.0.1:4000/health", Recover: &contracts.ToolSpec{Command: "node_modules/.bin/kb-recover"}}
	plan, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, hostCatalog(declared))
	if err != nil {
		t.Fatal(err)
	}
	if plan.Host == nil || plan.Host.Command != declared.Command || plan.Host.HealthURL != declared.HealthURL || plan.Host.Recover == nil || plan.Host.Recover.Command != "node_modules/.bin/kb-recover" {
		t.Fatalf("plan host = %#v", plan.Host)
	}
	// The plan owns its copy: mutating it must not reach the release index.
	plan.Host.Args[0] = "changed"
	if declared.Args[0] != "--flag" {
		t.Fatal("the plan must not alias the release index's host arguments")
	}
}

func TestPlanRejectsAPlatformThatDeclaresNoHost(t *testing.T) {
	_, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, hostCatalog(nil))
	launcherErr, ok := err.(*contracts.LauncherError)
	if !ok || launcherErr.Code != contracts.CodeIncompatibleComponents {
		t.Fatalf("err = %#v", err)
	}
}

func TestPlanHashCoversTheHost(t *testing.T) {
	first, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, hostCatalog(&contracts.HostSpec{Command: "a", HealthURL: "http://127.0.0.1:4000/health"}))
	if err != nil {
		t.Fatal(err)
	}
	second, err := Plan(contracts.InstallRequest{PlatformRoot: "/tmp/x"}, hostCatalog(&contracts.HostSpec{Command: "b", HealthURL: "http://127.0.0.1:4000/health"}))
	if err != nil {
		t.Fatal(err)
	}
	if first.PlanHash == second.PlanHash {
		t.Fatal("a different host is a different installation decision")
	}
}
