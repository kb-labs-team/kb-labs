package doctor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
)

func check(t *testing.T, section Section, id string) Check {
	t.Helper()
	for _, item := range section.Checks {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("no check %q in %+v", id, section.Checks)
	return Check{}
}

func installation(t *testing.T, hostCommand string) (root string, state host.State) {
	t.Helper()
	root = t.TempDir()
	state = host.State{Dir: filepath.Join(t.TempDir(), "launcher")}
	plan := contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema, ServiceGraph: contracts.ServiceGraph{PlatformVersion: "2.5.0"}, Host: &contracts.HostSpec{Command: hostCommand, HealthURL: "http://127.0.0.1:4000/health"}}
	if err := receipt.Write(root, contracts.InstallReceipt{ID: "r1", Plan: plan}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".kb"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".kb", "kb.config.jsonc"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root, state
}

func TestInstallationSectionReportsACompleteInstallationAsHealthy(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root, state := installation(t, executable)
	section := InspectInstallation(root, state)
	if !section.OK {
		t.Fatalf("section = %+v", section)
	}
	if detail := check(t, section, "receipt").Detail; !strings.Contains(detail, "2.5.0") {
		t.Fatalf("receipt detail = %q", detail)
	}
}

func TestInstallationSectionNamesWhatIsMissing(t *testing.T) {
	root, state := installation(t, filepath.Join(t.TempDir(), "no-such-host"))
	if err := os.Remove(filepath.Join(root, ".kb", "kb.config.jsonc")); err != nil {
		t.Fatal(err)
	}
	section := InspectInstallation(root, state)
	if section.OK || check(t, section, "config").OK || check(t, section, "host-spec").OK || !check(t, section, "receipt").OK {
		t.Fatalf("section = %+v", section)
	}
	if !strings.Contains(check(t, section, "host-spec").Hint, "kb-create") {
		t.Fatalf("a failed check must say how to fix it: %+v", check(t, section, "host-spec"))
	}
}

func TestInstallationSectionWithoutAReceiptIsAFindingNotAnError(t *testing.T) {
	section := InspectInstallation(t.TempDir(), host.State{Dir: t.TempDir()})
	if section.OK || check(t, section, "receipt").OK || !check(t, section, "launcher-state").OK {
		t.Fatalf("section = %+v", section)
	}
}

func TestInstallationSectionRejectsAReceiptWithoutAHost(t *testing.T) {
	root := t.TempDir()
	if err := receipt.Write(root, contracts.InstallReceipt{ID: "old", Plan: contracts.ResolvedInstallPlan{Schema: contracts.ResolvedPlanSchema}}); err != nil {
		t.Fatal(err)
	}
	section := InspectInstallation(root, host.State{Dir: t.TempDir()})
	if got := check(t, section, "host-spec"); got.OK || !strings.Contains(got.Detail, "no host") {
		t.Fatalf("host-spec = %+v", got)
	}
}

func TestPlatformSectionReportsAStoppedOrUnhealthyHost(t *testing.T) {
	stopped := InspectPlatform(context.Background(), host.Status{State: host.StateStopped}, nil)
	if stopped.OK || !strings.Contains(check(t, stopped, "host-process").Hint, "kb-create start") {
		t.Fatalf("stopped = %+v", stopped)
	}
	unhealthy := InspectPlatform(context.Background(), host.Status{State: host.StateUnhealthy, PID: 7}, nil)
	if unhealthy.OK || !strings.Contains(check(t, unhealthy, "host-process").Hint, "kb-create restart") {
		t.Fatalf("unhealthy = %+v", unhealthy)
	}
}

func gatewayDouble(t *testing.T, health, auth string) host.Status {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			_, _ = w.Write([]byte(health))
		case "/health/auth":
			if auth == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(auth))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return host.Status{State: host.StateRunning, PID: 9, Healthy: true, HealthURL: server.URL + "/health"}
}

func TestPlatformSectionReadsUpstreamsAdaptersAndSignInReadiness(t *testing.T) {
	status := gatewayDouble(t,
		`{"upstreams":{"marketplace":{"status":"up"},"state":{"status":"down"}},"adapters":{"cache":{"available":true},"llm":{"available":false}}}`,
		`{"ok":false,"issues":[{"code":"no_active_admin","severity":"error","message":"nobody can log in","hint":"kb-create doctor --recover"}]}`)
	section := InspectPlatform(context.Background(), status, nil)
	if section.OK {
		t.Fatalf("section = %+v", section)
	}
	for id, wantOK := range map[string]bool{"host-process": true, "upstream:marketplace": true, "upstream:state": false, "adapter:cache": true, "adapter:llm": false, "auth:no_active_admin": false} {
		if got := check(t, section, id); got.OK != wantOK {
			t.Fatalf("%s = %+v, want ok=%v", id, got, wantOK)
		}
	}
	if hint := check(t, section, "auth:no_active_admin").Hint; hint != "kb-create doctor --recover" {
		t.Fatalf("the sign-in hint must reach the operator unchanged: %q", hint)
	}
}

func TestPlatformSectionIsHealthyWhenEverythingReportsUp(t *testing.T) {
	status := gatewayDouble(t, `{"upstreams":{"state":{"status":"up"}}}`, `{"ok":true,"issues":[]}`)
	if section := InspectPlatform(context.Background(), status, nil); !section.OK {
		t.Fatalf("section = %+v", section)
	}
}

func TestPlatformSectionToleratesAHostWithoutStructuredHealth(t *testing.T) {
	status := gatewayDouble(t, `ok`, "")
	section := InspectPlatform(context.Background(), status, nil)
	if !section.OK || !check(t, section, "health").OK {
		t.Fatalf("section = %+v", section)
	}
}

func TestSectionIsHealthyOnlyWhenEveryCheckIs(t *testing.T) {
	if !NewSection(nil).OK || !NewSection([]Check{{OK: true}}).OK {
		t.Fatal("empty and passing sections are healthy")
	}
	if NewSection([]Check{{OK: true}, {OK: false}}).OK {
		t.Fatal("one failing check fails the section")
	}
}
