package v2cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/spf13/cobra"
)

func installCanaryIndex(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "x251-release-index-v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KB_HOME", filepath.Join(home, ".kb"))
	target := filepath.Join(home, ".local", "share", "kb-create", "release-index.json")
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, data, 0600); err != nil {
		t.Fatal(err)
	}
	return home
}

// case: S-285.1
func TestCanarySavedIndexPlanCommand(t *testing.T) {
	home := installCanaryIndex(t)
	args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--registry", "http://127.0.0.1:4873", "--json"}
	var out, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), args, &out, &stderr)
	var payload map[string]any
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatalf("%s %v", out.String(), err)
	}
	if code.Code() != 0 || payload["ok"] != true {
		t.Fatalf("exit=%d output=%s stderr=%s", code.Code(), out.String(), stderr.String())
	}
	data := payload["data"].(map[string]any)
	plan := data["plan"].(map[string]any)
	host := plan["host"].(map[string]any)
	var options map[string]any
	for _, entry := range plan["configPatches"].([]any) {
		patch := entry.(map[string]any)
		if patch["path"] == "/platform/adapterOptions" {
			if err := json.Unmarshal([]byte(patch["json"].(string)), &options); err != nil {
				t.Fatal(err)
			}
		}
	}
	services := options["serviceTransport"].(map[string]any)["services"].(map[string]any)
	address := services["gateway"].(map[string]any)["url"].(string)
	if host["healthUrl"] != address+"/health" {
		t.Fatalf("Gateway host and transport differ: host=%v address=%s", host, address)
	}
}

// case: S-285.2
func TestCanaryExplicitGatewayPlanCommand(t *testing.T) {
	home := installCanaryIndex(t)
	args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--platform-version", "2.121.0-canary.cec6dacc6", "--registry", "http://127.0.0.1:4873", "--gateway-url", "http://127.0.0.1:5500", "--json"}
	var out, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), args, &out, &stderr)
	if code.Code() != 0 {
		t.Fatalf("exit=%d output=%s stderr=%s", code.Code(), out.String(), stderr.String())
	}
	var payload struct {
		Data struct {
			Plan contracts.ResolvedInstallPlan `json:"plan"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	plan := payload.Data.Plan
	if plan.Host == nil || plan.Host.HealthURL != "http://127.0.0.1:5500/health" {
		t.Fatalf("host=%+v", plan.Host)
	}
	for _, patch := range plan.ConfigPatches {
		if patch.Path != "/platform/adapterOptions" {
			continue
		}
		var options struct {
			Transport struct {
				Offset   *int `json:"offset"`
				Services map[string]struct {
					URL string `json:"url"`
				} `json:"services"`
			} `json:"serviceTransport"`
		}
		if err := json.Unmarshal([]byte(patch.JSON), &options); err != nil {
			t.Fatal(err)
		}
		if options.Transport.Offset == nil || *options.Transport.Offset != 0 || options.Transport.Services["gateway"].URL != "http://127.0.0.1:5500" {
			t.Fatalf("transport=%+v", options.Transport)
		}
		return
	}
	t.Fatal("missing adapter options")
}

// case: S-285.3
func TestCanaryBuiltInScenariosPlanCommand(t *testing.T) {
	home := installCanaryIndex(t)
	ids, err := scenario.IDs()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			args := []string{"plan", "--platform-root", filepath.Join(home, id), "--platform-version", "2.121.0-canary.cec6dacc6", "--registry", "http://127.0.0.1:4873", "--gateway-url", "http://127.0.0.1:5500", "--scenario", id, "--json"}
			var out, stderr bytes.Buffer
			code := clikitcommand.Execute(newRootCommand(), args, &out, &stderr)
			if code.Code() != 0 {
				t.Fatalf("exit=%d output=%s stderr=%s", code.Code(), out.String(), stderr.String())
			}
		})
	}
}

// case: S-285.4
func TestCanaryRetryRetainsInvocationOrder(t *testing.T) {
	home := installCanaryIndex(t)
	args := []string{"plan", "--registry", "http://127.0.0.1:4873", "--gateway-url", "http://127.0.0.1:5500", "--platform-root", filepath.Join(home, "platform"), "--provider", "invalid"}
	var out, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommand(), args, &out, &stderr)
	if code.Code() == 0 {
		t.Fatal("expected invalid provider")
	}
	want := contracts.ShellCommand(append([]string{"kb-create"}, args...)...)
	var retry string
	for _, line := range strings.Split(out.String()+stderr.String(), "\n") {
		if _, value, found := strings.Cut(line, "Retry: "); found {
			retry = value
		}
	}
	if retry != want {
		t.Fatalf("retry=%q want=%q", retry, want)
	}
}

// case: S-285.4
func TestCanaryApplyRetryKeepsSecretEnvironmentNames(t *testing.T) {
	home := installCanaryIndex(t)
	args := []string{"apply", "--secret-env", "gateway.token=MY_TOKEN", "--registry", "http://127.0.0.1:4873", "--platform-root", filepath.Join(home, "platform"), "--provider", "invalid"}
	factory := func(*cobra.Command) commandDependencies {
		return commandDependencies{NodeCheck: func() error { return nil }, Runtime: &runtime.Dependencies{}}
	}
	var out, stderr bytes.Buffer
	code := clikitcommand.Execute(newRootCommandWithDependencyFactory(factory), args, &out, &stderr)
	if code.Code() == 0 {
		t.Fatal("expected invalid provider")
	}
	want := contracts.ShellCommand(append([]string{"kb-create"}, args...)...)
	if !strings.Contains(out.String()+stderr.String(), want) {
		t.Fatalf("expected %s in %s%s", want, out.String(), stderr.String())
	}
}

// case: S-285.4
func TestCanaryRetryRedactsSecretValues(t *testing.T) {
	home := installCanaryIndex(t)
	args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--gateway-url=http://alice:secret-password@127.0.0.1:5500", "--scenario-answers={ \"access.mode\" : \"local\", \"admin.password\" : \"hidden-password\" }", "--json"}
	var out, stderr bytes.Buffer
	clikitcommand.Execute(newRootCommand(), args, &out, &stderr)
	output := out.String() + stderr.String()
	if strings.Contains(output, "secret-password") || strings.Contains(output, "hidden-password") {
		t.Fatalf("secret leaked: %s", output)
	}
	if !strings.Contains(output, "KB_URL_PASSWORD") || !strings.Contains(output, "KB_SCENARIO") || !strings.Contains(output, "alice") {
		t.Fatalf("missing placeholders: %s", output)
	}
	if !strings.Contains(output, "access.mode") || !strings.Contains(output, "local") {
		t.Fatalf("non-secret answer was lost: %s", output)
	}
	var envelope struct {
		Error struct {
			Hint string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(envelope.Error.Hint, `"access.mode" : "local", "admin.password" : `) {
		t.Fatalf("non-secret bytes changed: %s", envelope.Error.Hint)
	}
}

// case: S-285.4
func TestCanaryRetryRedactsMalformedCredentialURL(t *testing.T) {
	home := installCanaryIndex(t)
	for _, value := range []string{"http://alice:secret%broken@127.0.0.1:5500", "alice:secret%broken@127.0.0.1:5500"} {
		args := []string{"plan", "--platform-root", filepath.Join(home, "platform"), "--gateway-url", value, "--json"}
		var out, stderr bytes.Buffer
		clikitcommand.Execute(newRootCommand(), args, &out, &stderr)
		if strings.Contains(out.String()+stderr.String(), "secret%broken") || strings.Contains(out.String()+stderr.String(), "%br") {
			t.Fatalf("secret leaked: %s%s", out.String(), stderr.String())
		}
	}
}
