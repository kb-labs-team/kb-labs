//go:build !windows

package v2cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/versionroot"
)

func TestDoctorTextExplainsUnboundPersistentAdapter(t *testing.T) {
	const hint = "From a project using this platform, run `kb adapter bind analytics @kb-labs/adapters-analytics-sqlite`."
	data := renderDoctorPlatformChecks([]doctor.Check{{
		ID:             "adapter-analytics",
		Slot:           "analytics",
		Mode:           "inmemory",
		Implementation: "InMemory",
		Detail:         "analytics is using InMemory although @kb-labs/adapters-analytics-sqlite is bound in the install plan.",
		Hint:           hint,
	}})
	for _, expected := range []string{"Adapter analytics: mode=inmemory implementation=InMemory", "Problem: analytics is using InMemory", hint} {
		if !strings.Contains(data, expected) {
			t.Errorf("doctor text output omits %q: %s", expected, data)
		}
	}
}

func TestDoctorReportsMarketplaceSourcesWithoutCredentialValues(t *testing.T) {
	result := doctorCommandResult{MarketplaceSources: []map[string]any{
		{"kind": "registry", "url": "https://registry.example.test", "signingKeyConfigured": true, "authTokenConfigured": true},
		{"kind": "npm", "url": "https://npm.example.test", "signingKeyConfigured": false, "authTokenConfigured": false},
	}}
	output := result.human()
	for _, expected := range []string{"Marketplace source: registry https://registry.example.test (signing key configured) (token configured)", "Marketplace source: npm https://npm.example.test"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("doctor output omits %q: %s", expected, output)
		}
	}
	if strings.Contains(output, "authToken") || strings.Contains(output, "signingPublicKey") {
		t.Fatalf("doctor output includes credential field names: %s", output)
	}
}

func TestDoctorNamesForeignShimAndGivesOrderedCleanupAndRepairCommands(t *testing.T) {
	inst := newInstallation(t)
	link := shim.Path(inst.launcher)
	removedRoot := filepath.Join(t.TempDir(), "removed-owner")
	writeVersionedReceipt(t, removedRoot, contracts.InstallReceipt{ID: "removed-owner"})
	removedLayout, err := versionroot.ForPlatformPath(removedRoot)
	if err != nil {
		t.Fatal(err)
	}
	removedTarget := shim.Target(removedLayout.PlatformRoot())
	if err := removedLayout.RemoveOwned(); err != nil {
		t.Fatal(err)
	}
	existingFile := filepath.Join(t.TempDir(), "arbitrary-target")
	if err := os.WriteFile(existingFile, []byte("foreign target"), 0o600); err != nil {
		t.Fatal(err)
	}
	missingTarget := filepath.Join(t.TempDir(), "missing-target")
	targets := []struct {
		name   string
		target string
	}{
		{name: "arbitrary existing file", target: existingFile},
		{name: "arbitrary missing target", target: missingTarget},
		{name: "removed managed layout", target: removedTarget},
	}
	for _, item := range targets {
		t.Run(item.name, func(t *testing.T) {
			if err := os.Remove(link); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if err := os.Symlink(item.target, link); err != nil {
				t.Fatal(err)
			}
			removeCommand := contracts.ShellCommand("rm", "--", link)
			repairCommand := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", inst.root)
			expected := []string{link, item.target, "cannot be mapped to a validated installation", "considers it foreign and will not change it", removeCommand, repairCommand}
			assertOrdered := func(output string) {
				t.Helper()
				last := -1
				for _, fragment := range expected {
					index := strings.Index(output, fragment)
					if index <= last {
						t.Fatalf("doctor output does not explain the foreign shim and next commands in order; missing/out of order %q: %s", fragment, output)
					}
					last = index
				}
			}

			jsonResult, code, jsonOutput := inst.run("doctor", "--json")
			if code != 0 {
				t.Fatalf("JSON doctor failed: %d %s", code, jsonOutput)
			}
			findings, ok := jsonResult["findings"].([]any)
			if !ok {
				t.Fatalf("JSON doctor has no findings: %s", jsonOutput)
			}
			var shimFinding map[string]any
			for _, item := range findings {
				if finding, ok := item.(map[string]any); ok && finding["code"] == "KB_INSTALL_SHIM_DANGLING" {
					shimFinding = finding
				}
			}
			if shimFinding == nil || shimFinding["path"] != link {
				t.Fatalf("JSON doctor omitted the foreign shim path finding: %s", jsonOutput)
			}
			jsonHint, ok := shimFinding["hint"].(string)
			if !ok {
				t.Fatalf("JSON doctor finding has no hint: %#v", shimFinding)
			}
			assertOrdered(jsonHint)

			_, code, humanOutput := inst.run("doctor")
			if code != 0 {
				t.Fatalf("human doctor failed: %d %s", code, humanOutput)
			}
			assertOrdered(humanOutput)
			if got, err := os.Readlink(link); err != nil || got != item.target {
				t.Fatalf("doctor changed the foreign shim: got %q, error %v; want %q", got, err, item.target)
			}
		})
	}
}

func TestDoctorNamesAnotherValidatedShimOwnerAndRequiresExplicitSwitch(t *testing.T) {
	inst := newInstallation(t)
	otherRoot := filepath.Join(t.TempDir(), "other-platform")
	writeVersionedReceipt(t, otherRoot, contracts.InstallReceipt{ID: "other-owner"})
	otherLayout, err := versionroot.New(otherRoot)
	if err != nil {
		t.Fatal(err)
	}
	link := shim.Path(inst.launcher)
	target := shim.Target(otherLayout.PlatformRoot())
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	remove := contracts.ShellCommand("rm", "--", link)
	repair := contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", inst.root)
	for _, human := range []bool{false, true} {
		args := []string{"doctor", "--json"}
		if human {
			args = []string{"doctor"}
		}
		result, code, output := inst.run(args...)
		if code != 0 {
			t.Fatalf("doctor human=%t failed: %d %s", human, code, output)
		}
		text := output
		if !human {
			installation, ok := result["installation"].(map[string]any)
			if !ok {
				t.Fatalf("JSON doctor omitted installation checks: %#v", result)
			}
			checks, _ := installation["checks"].([]any)
			found := false
			for _, value := range checks {
				if check, ok := value.(map[string]any); ok && check["id"] == "kb-command-shim" {
					text, _ = check["hint"].(string)
					found = true
				}
			}
			if !found {
				t.Fatalf("JSON doctor omitted the shim ownership check: %#v", result)
			}
		}
		ordered := []string{link, "validated installation", otherLayout.InstallRoot(), "leaves it with that installation", remove, repair}
		last := -1
		for _, fragment := range ordered {
			index := strings.Index(text, fragment)
			if index <= last {
				t.Fatalf("doctor did not explain another shim owner and deliberate switch in order; missing/out of order %q: %s", fragment, text)
			}
			last = index
		}
		if got, err := os.Readlink(link); err != nil || got != target {
			t.Fatalf("doctor changed the other installation's shim: got %q, error %v", got, err)
		}
	}
}

func TestDoctorHandlerReturnsTypedFindingsAndNextAction(t *testing.T) {
	inputPath := filepath.Join(t.TempDir(), "doctor-input.json")
	input := map[string]any{
		"manifests": []any{map[string]any{"id": "@kb/plugin", "requirements": []any{map[string]any{
			"path": "/plugin/token", "required": true, "hint": "Set PLUGIN_TOKEN and rerun doctor.", "action": "set PLUGIN_TOKEN",
		}}}},
		"configured": map[string]bool{},
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inputPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	value, failure, code, _ := executeForTest(t, operationTestSetup{Operation: "doctor", DoctorInput: inputPath, JSON: true})
	if code != 0 || failure != nil {
		t.Fatalf("doctor exit = %d, failure = %#v", code, failure)
	}
	response, ok := value.(doctorCommandResult)
	if !ok || len(response.Findings) != 1 {
		t.Fatalf("doctor output is not a typed report: %#v", value)
	}
	finding := response.Findings[0]
	if finding.Code == "" || finding.Component != "@kb/plugin" || finding.Path != "/plugin/token" ||
		finding.Action != "set PLUGIN_TOKEN" || finding.Hint != "Set PLUGIN_TOKEN and rerun doctor." {
		t.Fatalf("doctor finding is missing its typed action: %#v", finding)
	}
}
