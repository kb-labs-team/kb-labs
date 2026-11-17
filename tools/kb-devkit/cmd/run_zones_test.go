package cmd

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// case: S-179.50, S-179.51, S-179.52, S-179.53
func TestBuiltBinaryRunsTasksByConfiguredWorkspaceZone(t *testing.T) {
	root := t.TempDir()
	writeRunFixture(t, filepath.Join(root, "package.json"), `{"workspaces":["packages/*"]}`)
	writeRunFixture(t, filepath.Join(root, "packages", "platform", "package.json"), `{"name":"@fixture/platform"}`)
	writeRunFixture(t, filepath.Join(root, "packages", "plugin", "package.json"), `{"name":"@fixture/plugin","dependencies":{"@fixture/platform":"workspace:*"}}`)
	writeRunFixture(t, filepath.Join(root, "packages", "site", "package.json"), `{"name":"@fixture/site"}`)
	writeRunFixture(t, filepath.Join(root, "packages", "plugin", "src", "change.ts"), "export const changed = true\n")
	writeRunFixture(t, filepath.Join(root, "packages", "site", "src", "change.ts"), "export const changed = true\n")
	writeRunFixture(t, filepath.Join(root, "devkit.yaml"), `schemaVersion: 2
workspace:
  zones:
    runtime: ["packages/platform"]
    extensions: ["packages/plugin"]
    web-apps: ["packages/site"]
  categories:
    platform:
      match: ["packages/platform"]
      preset: node-lib
    plugin:
      match: ["packages/plugin"]
      preset: node-lib
    site:
      match: ["packages/site"]
      preset: node-lib
      defaultBuild: false
tasks:
  build:
    command: 'sh -c "mkdir -p dist && touch dist/built"'
    inputs: ["package.json", "src/**"]
    outputs: ["dist/**"]
    deps: ["^build"]
  lint:
    command: "touch lint-ran"
    inputs: ["src/**"]
    outputs: ["lint-ran"]
    deps: ["^check"]
  check:
    command: "touch checked"
    outputs: ["checked"]
  test:
    command: "touch test-ran"
    inputs: ["package.json"]
`)
	for _, args := range [][]string{
		{"init", "--quiet"},
		{"config", "user.email", "zones@example.test"},
		{"config", "user.name", "Zone Tests"},
		{"add", "--all"},
		{"commit", "--quiet", "-m", "fixture"},
	} {
		command := exec.Command("git", args...)
		command.Dir = root
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
		}
	}
	writeRunFixture(t, filepath.Join(root, "packages", "plugin", "src", "change.ts"), "export const changed = false\n")
	writeRunFixture(t, filepath.Join(root, "packages", "site", "src", "change.ts"), "export const changed = false\n")

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate CLI test source")
	}
	moduleRoot := filepath.Dir(filepath.Dir(source))
	binary := filepath.Join(t.TempDir(), "kb-devkit")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit for CLI contract test: %v\n%s", err, output)
	}

	type response struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Hint    string `json:"hint"`
		} `json:"error"`
		Data struct {
			Results []struct {
				Package string `json:"package"`
				Task    string `json:"task"`
			} `json:"results"`
			Summary struct {
				Scheduled   int `json:"scheduled"`
				Passed      int `json:"passed"`
				Failed      int `json:"failed"`
				Cached      int `json:"cached"`
				Blocked     int `json:"blocked"`
				NotAffected int `json:"notAffected"`
			} `json:"summary"`
			Elapsed string `json:"elapsed"`
		} `json:"data"`
	}
	run := func(args ...string) (int, response, string) {
		t.Helper()
		command := exec.Command(binary, args...)
		command.Dir = root
		stdout, err := command.Output()
		if err == nil {
			var result response
			if decodeErr := json.Unmarshal(stdout, &result); decodeErr != nil {
				t.Fatalf("decode CLI JSON %q: %v", stdout, decodeErr)
			}
			return 0, result, ""
		}
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("run CLI: %v", err)
		}
		var result response
		if decodeErr := json.Unmarshal(stdout, &result); decodeErr != nil {
			t.Fatalf("decode CLI error JSON %q: %v; stderr=%s", stdout, decodeErr, exit.Stderr)
		}
		return exit.ExitCode(), result, string(exit.Stderr)
	}
	resultPackages := func(result response) []string {
		packages := make([]string, 0, len(result.Data.Results))
		for _, task := range result.Data.Results {
			packages = append(packages, task.Package)
		}
		return packages
	}

	writeRunFixture(t, filepath.Join(root, "packages", "plugin", "src", "change.ts"), "export const changed = true\n")
	code, result, stderr := run("run", "build", "--affected", "--diff-only", "--zone", "extensions", "--json")
	if code != 0 || !result.OK || stderr != "" || len(resultPackages(result)) != 0 {
		t.Fatalf("empty affected-zone intersection: exit=%d result=%+v stderr=%s; want successful no-op", code, result, stderr)
	}
	if result.Data.Elapsed != "0s" || result.Data.Summary.Scheduled != 0 || result.Data.Summary.Passed != 0 || result.Data.Summary.Failed != 0 || result.Data.Summary.Cached != 0 || result.Data.Summary.Blocked != 0 || result.Data.Summary.NotAffected != 0 {
		t.Fatalf("empty selection JSON = %+v; want standard zero run summary and elapsed", result.Data)
	}
	writeRunFixture(t, filepath.Join(root, "packages", "site", "src", "change.ts"), "export const changed = true\n")
	writeRunFixture(t, filepath.Join(root, "packages", "plugin", "src", "change.ts"), "export const changed = false\n")
	code, result, stderr = run("run", "build", "--affected", "--diff-only", "--zones", "extensions", "--json")
	if code != 0 || !result.OK || stderr != "" || !reflect.DeepEqual(resultPackages(result), []string{"@fixture/platform", "@fixture/plugin"}) {
		t.Fatalf("affected plugin-zone build: exit=%d result=%+v stderr=%s; want affected plugin and upstream platform, not site", code, result, stderr)
	}

	code, result, stderr = run("run", "build", "--zone", "extensions", "--json")
	if code != 0 || !result.OK || stderr != "" || !reflect.DeepEqual(resultPackages(result), []string{"@fixture/platform", "@fixture/plugin"}) {
		t.Fatalf("plugin-zone build: exit=%d result=%+v stderr=%s; want upstream platform+plugin only", code, result, stderr)
	}

	for _, affected := range []bool{false, true} {
		args := []string{"run", "build", "lint", "--zone", "extensions", "--json"}
		if affected {
			writeRunFixture(t, filepath.Join(root, "packages", "plugin", "src", "change.ts"), "export const changed = 2\n")
			args = append(args, "--affected")
		}
		code, mixed, stderr := run(args...)
		var tasks []string
		for _, task := range mixed.Data.Results {
			tasks = append(tasks, task.Package+":"+task.Task)
		}
		sort.Strings(tasks)
		want := []string{"@fixture/platform:build", "@fixture/platform:check", "@fixture/plugin:build", "@fixture/plugin:lint"}
		if code != 0 || !mixed.OK || stderr != "" || !reflect.DeepEqual(tasks, want) {
			t.Fatalf("mixed zone tasks (affected=%t): exit=%d tasks=%v stderr=%s; want %v", affected, code, tasks, stderr, want)
		}
	}

	code, result, stderr = run("run", "test", "--zone", "extensions", "--json")
	if code != 0 || !result.OK || stderr != "" || !reflect.DeepEqual(resultPackages(result), []string{"@fixture/plugin"}) {
		t.Fatalf("plugin-zone test: exit=%d result=%+v stderr=%s; want plugin only", code, result, stderr)
	}

	code, result, stderr = run("run", "build", "--zone", "web-apps", "--json")
	if code != 0 || !result.OK || stderr != "" || !reflect.DeepEqual(resultPackages(result), []string{"@fixture/site"}) {
		t.Fatalf("sites-zone build: exit=%d result=%+v stderr=%s; want explicit defaultBuild:false site", code, result, stderr)
	}

	code, result, _ = run("run", "build", "--zone", "missing", "--json")
	if code == 0 || result.OK || result.Error.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(result.Error.Message, "missing") || !strings.Contains(result.Error.Hint, "kb-devkit deps") {
		t.Fatalf("unknown zone = exit %d, response %+v; want input error", code, result)
	}
	code, result, _ = run("run", "build", "--zone", "runtime", "--packages", "@fixture/plugin", "--json")
	if code == 0 || result.OK || result.Error.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(result.Error.Message, "@fixture/plugin") || !strings.Contains(result.Error.Message, "runtime") || !strings.Contains(result.Error.Hint, "kb-devkit deps") {
		t.Fatalf("empty packages-zone intersection = exit %d, response %+v; want input error", code, result)
	}
	code, result, stderr = run("run", "build", "--zone", "extensions", "--packages", "@fixture/plugin", "--json")
	if code != 0 || !result.OK || stderr != "" || !reflect.DeepEqual(resultPackages(result), []string{"@fixture/platform", "@fixture/plugin"}) {
		t.Fatalf("packages-zone intersection = exit %d, response %+v stderr=%s; want selected plugin with upstream", code, result, stderr)
	}
	code, result, _ = run("run", "build", "--zones", ",", "--json")
	if code == 0 || result.OK || result.Error.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(result.Error.Message, "At least one workspace zone") {
		t.Fatalf("empty zone selector = exit %d, response %+v; want input error", code, result)
	}

	configPath := filepath.Join(root, "devkit.yaml")
	originalConfig, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	gapConfig := strings.Replace(string(originalConfig), `runtime: ["packages/platform"]`, `runtime: ["packages/not-platform"]`, 1)
	if gapConfig == string(originalConfig) {
		t.Fatal("could not prepare workspace zone gap fixture")
	}
	writeRunFixture(t, configPath, gapConfig)
	code, result, _ = run("run", "build", "--json")
	if code == 0 || result.OK || result.Error.Code != "KB_RUNTIME_INPUT_INVALID" ||
		!strings.Contains(result.Error.Message, `packages/platform`) ||
		!strings.Contains(result.Error.Hint, "workspace.zones") || !strings.Contains(result.Error.Hint, "kb-devkit deps") {
		t.Fatalf("zone gap = exit %d, response %+v; want actionable typed input error", code, result)
	}

	overlapConfig := strings.Replace(string(originalConfig), `extensions: ["packages/plugin"]`, `extensions: ["packages/plugin", "packages/platform"]`, 1)
	if overlapConfig == string(originalConfig) {
		t.Fatal("could not prepare workspace zone overlap fixture")
	}
	writeRunFixture(t, configPath, overlapConfig)
	code, result, _ = run("run", "build", "--json")
	if code == 0 || result.OK || result.Error.Code != "KB_RUNTIME_INPUT_INVALID" ||
		!strings.Contains(result.Error.Message, `packages/platform`) ||
		!strings.Contains(result.Error.Message, "matches multiple workspace zones") ||
		!strings.Contains(result.Error.Message, "extensions") || !strings.Contains(result.Error.Message, "runtime") ||
		!strings.Contains(result.Error.Hint, "workspace.zones") || !strings.Contains(result.Error.Hint, "kb-devkit deps") {
		t.Fatalf("zone overlap = exit %d, response %+v; want actionable typed input error", code, result)
	}
}
