//go:build !windows

package v2cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

// case: S-284.19
func TestBuiltInstallDoesNotPromptWithoutTerminal(t *testing.T) {
	launcher, _ := binaries(t)
	index, err := filepath.Abs(filepath.Join("testdata", "x251-release-index.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"null", "pipe"} {
		t.Run(kind, func(t *testing.T) {
			home := t.TempDir()
			root := filepath.Join(home, "platform")
			gateway := "http://127.0.0.1:7000"
			plan := exec.Command(launcher, "plan", "--json", "--index", index, "--platform-root", root, "--platform-channel", "canary", "--gateway-url", gateway)
			plan.Env = append(os.Environ(), "HOME="+home, "XDG_DATA_HOME="+filepath.Join(home, "data"), "XDG_STATE_HOME="+filepath.Join(home, "state"))
			output, err := plan.CombinedOutput()
			if err != nil {
				t.Fatalf("isolated plan: %v: %s", err, output)
			}
			var result struct {
				Data struct {
					Plan contracts.ResolvedInstallPlan `json:"plan"`
				} `json:"data"`
			}
			if err := json.Unmarshal(output, &result); err != nil {
				t.Fatal(err)
			}
			if result.Data.Plan.Request.GatewayURL != gateway || result.Data.Plan.Host.HealthURL != gateway+"/health" {
				t.Fatalf("unexpected gateway in plan: %+v", result.Data.Plan.Host)
			}
			for _, service := range result.Data.Plan.ServiceGraph.Services {
				if service.Port != 0 && (service.Port < 4500 || service.Port > 65535) {
					t.Fatalf("unsafe planned port %d for %s", service.Port, service.ID)
				}
			}
			cmd := exec.Command(launcher, "install", "--index", index, "--platform-root", filepath.Join(home, "platform"), "--scenario", "custom", "--scenario-answers", `{"access.mode":"secured"}`, "--platform-channel", "canary", "--gateway-url", "http://127.0.0.1:7000")
			cmd.Env = append(os.Environ(), "HOME="+home, "XDG_DATA_HOME="+filepath.Join(home, "data"), "XDG_STATE_HOME="+filepath.Join(home, "state"))
			if kind == "null" {
				input, err := os.Open(os.DevNull)
				if err != nil {
					t.Fatal(err)
				}
				defer input.Close()
				cmd.Stdin = input
			} else {
				cmd.Stdin = strings.NewReader("ignored\n")
			}
			output, err = cmd.CombinedOutput()
			if err == nil {
				t.Fatalf("missing admin email unexpectedly accepted: %s", output)
			}
			if strings.Contains(string(output), "Platform channel [") || strings.Contains(string(output), "Studio access [") || !strings.Contains(string(output), "admin.email") {
				t.Fatalf("output=%s", output)
			}
		})
	}
}
