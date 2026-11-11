package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/kb-labs/devkit/internal/testdeadline"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
	clikitresult "github.com/kb-labs/clikit/result"
	"github.com/kb-labs/devkit/internal/checks"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

// case: S-179.27
func TestCheckReportsConfiguredChecksPerCategory(t *testing.T) {
	cfg := &config.DevkitConfig{Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}}}
	ws := &workspace.Workspace{Packages: []workspace.Package{{Name: "@acme/demo", Category: "ts-lib", Preset: "node-lib"}}}
	counts := selectedCheckCounts(ws, cfg, checks.Default(), nil, "", true)
	if counts["ts-lib"] != len(checks.Default().RulesFor(cfg.Presets["node-lib"])) {
		t.Fatalf("checksByCategory = %#v, want one count for each applicable rule", counts)
	}
}

// case: S-179.27
func TestCandidateFixturePackagesUseFixturePreset(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate check test source")
	}
	moduleDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), ".."))
	workspaceRoot := filepath.Clean(filepath.Join(moduleDir, "../.."))
	cfg, err := config.LoadFile(filepath.Join(workspaceRoot, "devkit.yaml"))
	if err != nil {
		t.Fatalf("load workspace devkit config: %v", err)
	}
	ws, err := workspace.New(workspaceRoot, cfg)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	fixtureCategories := map[string]bool{"fixture": true, "fixture-adapter": true}
	fixtures := 0
	for _, pkg := range ws.Packages {
		if fixtureCategories[pkg.Category] {
			fixtures++
			if pkg.Preset != "candidate-fixture" {
				t.Errorf("fixture package %s uses preset %q, want candidate-fixture", pkg.Name, pkg.Preset)
			}
		}
		if pkg.Preset == "candidate-fixture" && !fixtureCategories[pkg.Category] {
			t.Errorf("non-fixture package %s uses candidate-fixture preset", pkg.Name)
		}
	}
	if fixtures == 0 {
		t.Fatal("workspace discovery found no fixture-category packages")
	}
}

// case: S-179.28
func TestCheckRejectsUnknownAndUnmatchedFilters(t *testing.T) {
	cfg := &config.DevkitConfig{Presets: map[string]config.Preset{"go": {Language: "go"}}}
	ws := &workspace.Workspace{Packages: []workspace.Package{{Name: "@acme/go", Category: "go-binary", Preset: "go"}}}
	registry := checks.Default()

	for _, test := range []struct {
		name string
		only []string
	}{
		{name: "unknown", only: []string{"not-a-check"}},
		{name: "known but unmatched", only: []string{"package_json"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateCheckSelection(ws, cfg, registry, test.only, "", true)
			var failure *diag.Diag
			if !errors.As(err, &failure) || failure.Code != "KB_RUNTIME_INPUT_INVALID" {
				t.Fatalf("error = %v, want typed KB_RUNTIME_INPUT_INVALID", err)
			}
		})
	}
}

func TestCheckSelectionRecognizesWorkspaceCircularCheck(t *testing.T) {
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"node-lib": {Deps: config.DepsRules{CheckCircular: true}}},
		Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{
			Name: "libs", Category: config.CategoryConfig{Preset: "node-lib"},
		}}},
	}
	ws := &workspace.Workspace{Packages: []workspace.Package{{Name: "@kb/a", Preset: "node-lib"}}}
	registry := checks.Default()
	if err := validateCheckSelection(ws, cfg, registry, []string{"circular"}, "", true); err != nil {
		t.Fatalf("validate circular selection: %v", err)
	}
	if counts := selectedCheckCounts(ws, cfg, registry, []string{"circular"}, "", true); counts["circular"] != 1 {
		t.Fatalf("check counts = %#v, want circular check count", counts)
	}
	err := validateCheckSelection(ws, cfg, registry, []string{"circular"}, "@kb/a", true)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(failure.Hint, "kb-devkit check --only circular") {
		t.Fatalf("package-scoped circular selection error = %v, want typed full-workspace instruction", err)
	}
}

// case: S-179.28
func TestCheckRejectsCategoryMismatchWithApplicableCategories(t *testing.T) {
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}},
		Custom:  []config.CustomCheck{{Name: "cli-naming", Run: "true", On: []string{"check"}, Categories: []string{"plugin-entry"}}},
	}
	ws := &workspace.Workspace{Packages: []workspace.Package{{Name: "@kb-labs/viewer/core", Category: "ts-lib", Preset: "node-lib"}}}
	err := validateCheckSelection(ws, cfg, checks.Build(cfg, ".", "check"), []string{"cli-naming"}, "@kb-labs/viewer/core", true)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_RUNTIME_INPUT_INVALID" {
		t.Fatalf("error = %v, want typed KB_RUNTIME_INPUT_INVALID", err)
	}
	if !strings.Contains(failure.Message, "does not apply") || !strings.Contains(failure.Hint, "plugin-entry") {
		t.Fatalf("failure = %#v, want applicability reason and matching categories", failure)
	}
}

// case: S-179.28
func TestCheckCLIRejectsReviewerCategoryMismatch(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate check test source")
	}
	moduleDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), ".."))
	workspaceRoot := filepath.Clean(filepath.Join(moduleDir, "../.."))
	cfg, err := config.LoadFile(filepath.Join(workspaceRoot, "devkit.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.New(workspaceRoot, cfg)
	if err != nil {
		t.Fatal(err)
	}
	var packageName string
	for _, pkg := range ws.Packages {
		if pkg.Category == "ts-lib" {
			packageName = pkg.Name
			break
		}
	}
	if packageName == "" {
		t.Fatal("workspace has no package in the ts-lib category")
	}
	tempDir := t.TempDir()
	binary := filepath.Join(tempDir, "kb-devkit")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = moduleDir
	build.Env = isolatedCheckEnv(t, tempDir)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\n%s", err, output)
	}

	command := exec.Command(binary, "check", "--package", packageName, "--only", "cli-naming", "--json")
	command.Dir = workspaceRoot
	command.Env = isolatedCheckEnv(t, tempDir)
	output, err := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 {
		t.Fatalf("command exit = %v, want nonzero typed refusal; output: %s", err, output)
	}
	var response struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Hint    string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(output, &response); err != nil {
		t.Fatalf("decode command response: %v; output: %s", err, output)
	}
	if response.OK || response.Error.Code != "KB_RUNTIME_INPUT_INVALID" || !strings.Contains(response.Error.Message, "does not apply") || !strings.Contains(response.Error.Hint, "plugin-entry") {
		t.Fatalf("response = %#v, want typed category-mismatch refusal", response)
	}
}

// case: S-179.27
func TestCheckCLIStreamsNamedProgressAndCataloguedTimeoutThroughPTY(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the macOS script utility provides the PTY contract exercised here")
	}
	script, err := exec.LookPath("script")
	if err != nil {
		t.Skip("script utility is unavailable")
	}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate check test source")
	}
	moduleDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), ".."))
	tempDir := t.TempDir()
	fixtureRoot := filepath.Join(tempDir, "workspace")
	pkgDir := filepath.Join(fixtureRoot, "packages", "demo")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@acme/demo"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	config := `schemaVersion: 2
workspace:
  discovery: ["packages/*"]
  categories:
    demo:
      match: ["packages/*"]
      language: javascript
      preset: demo
presets:
  demo:
    language: javascript
checks:
  timeout_ms: 5000
custom_checks:
  - name: slow-check
    run: >-
      sleep 3; printf '{"issues":[]}' > "$KB_DEVKIT_CHECK_RESULT_FILE"
    on: [check]
    scope: workspace
`
	configPath := filepath.Join(fixtureRoot, "devkit.yaml")
	if err := os.WriteFile(configPath, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}

	binary := filepath.Join(tempDir, "kb-devkit")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = moduleDir
	build.Env = isolatedCheckEnv(t, tempDir)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\n%s", err, output)
	}
	home := filepath.Join(tempDir, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testdeadline.Budget(t))
	defer cancel()
	transcript := filepath.Join(tempDir, "pty-transcript.txt")
	command := exec.CommandContext(ctx, script, "-q", "-F", transcript, binary, "--config", configPath, "check", "--only", "slow-check", "--json")
	command.Dir = fixtureRoot
	command.Env = isolatedCheckEnv(t, home)
	var commandStdout, commandStderr bytes.Buffer
	command.Stdout = &commandStdout
	command.Stderr = &commandStderr
	if err := command.Start(); err != nil {
		t.Fatalf("start built check through PTY: %v", err)
	}
	t.Cleanup(func() {
		if command.Process != nil && command.ProcessState == nil {
			if err := command.Process.Kill(); err == nil {
				if waitErr := command.Wait(); waitErr != nil && !errors.Is(waitErr, os.ErrProcessDone) {
					t.Errorf("wait for stopped PTY check command: %v", waitErr)
				}
			} else if errors.Is(err, os.ErrProcessDone) {
				_ = command.Wait()
			} else {
				t.Errorf("stop PTY check command: %v", err)
			}
		}
	})
	deadline := time.After(testdeadline.Budget(t))
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		transcriptBytes, readErr := os.ReadFile(transcript)
		transcriptText := string(transcriptBytes)
		if readErr == nil && strings.Contains(transcriptText, "[RUN] workspace:slow-check elapsed") {
			if strings.Contains(transcriptText, "[DONE] workspace:slow-check") {
				t.Fatalf("PTY transcript contains completion before the delay ends: %q", transcriptText)
			}
			break
		}
		select {
		case <-ticker.C:
		case <-deadline:
			t.Fatalf("PTY emitted no named progress before completion: %q (read error: %v)", transcriptText, readErr)
		}
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("built check through PTY: %v; stdout: %s; stderr: %s", err, commandStdout.String(), commandStderr.String())
	}
	transcriptBytes, err := os.ReadFile(transcript)
	if err != nil {
		t.Fatalf("read PTY transcript: %v", err)
	}
	if !strings.Contains(string(transcriptBytes), "[DONE] workspace:slow-check elapsed") {
		t.Fatalf("PTY transcript lacks completion line: %q", transcriptBytes)
	}

	if err := os.WriteFile(configPath, []byte(strings.Replace(config, "timeout_ms: 5000", "timeout_ms: 30", 1)), 0o644); err != nil {
		t.Fatalf("set short timeout: %v", err)
	}
	command = exec.CommandContext(ctx, binary, "--config", configPath, "check", "--only", "slow-check", "--json")
	command.Dir = fixtureRoot
	command.Env = isolatedCheckEnv(t, home)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("timed-out check exited successfully")
	}
	for _, expected := range []string{"KB_DEVKIT_CHECK_EXECUTION_FAILED", "slow-check", "30ms"} {
		if !strings.Contains(string(output), expected) {
			t.Fatalf("timeout output lacks %q: %s", expected, output)
		}
	}
}

// case: S-179.30
func TestCheckCLIExternalFailureReportsExitCodeStderrAndRerunCommand(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate check test source")
	}
	moduleDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), ".."))
	tempDir := t.TempDir()
	fixtureRoot := filepath.Join(tempDir, "workspace")
	pkgDir := filepath.Join(fixtureRoot, "packages", "demo")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@acme/demo"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	config := `schemaVersion: 2
workspace:
  discovery: ["packages/*"]
  categories:
    demo:
      match: ["packages/*"]
      language: javascript
      preset: demo
presets:
  demo:
    language: javascript
checks:
  timeout_ms: 5000
custom_checks:
  - name: stderr-check
    run: >-
      printf 'fixture stderr detail\n' >&2; printf 'stderr-check\n' >> rerun.log;
      printf '{"issues":[]}' > "$KB_DEVKIT_CHECK_RESULT_FILE"; exit 1
    on: [check]
    scope: workspace
  - name: stderr-check-two
    run: >-
      printf 'second stderr detail\n' >&2; printf 'stderr-check-two\n' >> rerun.log;
      printf '{"issues":[]}' > "$KB_DEVKIT_CHECK_RESULT_FILE"; exit 2
    on: [check]
    scope: workspace
  - name: 'audit check; touch injected #'
    run: >-
      printf 'audit check; touch injected #\n' >> rerun.log;
      printf '{"issues":[]}' > "$KB_DEVKIT_CHECK_RESULT_FILE"; exit 3
    on: [check]
    scope: workspace
`
	configPath := filepath.Join(fixtureRoot, "devkit.yaml")
	if err := os.WriteFile(configPath, []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}

	binary := filepath.Join(tempDir, "kb-devkit")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Dir = moduleDir
	build.Env = isolatedCheckEnv(t, tempDir)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build kb-devkit: %v\\n%s", err, output)
	}
	binDir := filepath.Join(tempDir, "bin")
	if err := os.Mkdir(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(binary, filepath.Join(binDir, "kb-devkit")); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "check", "--only", "stderr-check,stderr-check-two,audit check; touch injected #", "--json")
	command.Dir = fixtureRoot
	command.Env = isolatedCheckEnv(t, tempDir)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 {
		t.Fatalf("command exit = %v, want nonzero; stdout: %s; stderr: %s", err, output, stderr.String())
	}
	var response struct {
		Data struct {
			Checks []struct {
				Check         string `json:"check"`
				ExitCode      int    `json:"exitCode"`
				ExitCodeKnown bool   `json:"exitCodeKnown"`
				StderrTail    string `json:"stderrTail"`
				RerunCommand  string `json:"rerunCommand"`
			} `json:"checks"`
		} `json:"data"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Cause   string `json:"cause"`
			Hint    string `json:"hint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(output, &response); err != nil {
		t.Fatalf("decode command response: %v; stdout: %s", err, output)
	}
	if response.Error.Code != "KB_DEVKIT_CHECK_EXECUTION_FAILED" {
		t.Fatalf("diagnostic code = %q, want KB_DEVKIT_CHECK_EXECUTION_FAILED", response.Error.Code)
	}
	expectedFailures := map[string]struct {
		exitCode   int
		stderrTail string
	}{
		"stderr-check":                  {exitCode: 1, stderrTail: "fixture stderr detail"},
		"stderr-check-two":              {exitCode: 2, stderrTail: "second stderr detail"},
		"audit check; touch injected #": {exitCode: 3, stderrTail: ""},
	}
	if len(response.Data.Checks) != len(expectedFailures) {
		t.Fatalf("failure records = %#v, want all configured failures; stdout: %s", response.Data.Checks, output)
	}
	for _, check := range response.Data.Checks {
		want, exists := expectedFailures[check.Check]
		if !exists || !check.ExitCodeKnown || check.ExitCode != want.exitCode || check.StderrTail != want.stderrTail {
			t.Fatalf("failure record = %#v, want check, process status, and stderr from the fixture", check)
		}
		if check.RerunCommand == "" {
			t.Fatalf("failure record %#v has no runnable suggestion", check)
		}
		if !strings.Contains(response.Error.Hint, check.RerunCommand) {
			t.Fatalf("rendered hint %q does not contain structured rerun command %q", response.Error.Hint, check.RerunCommand)
		}
		if err := os.WriteFile(filepath.Join(fixtureRoot, "rerun.log"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(fixtureRoot, "injected")); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		rerun := exec.Command("sh", "-c", check.RerunCommand)
		rerun.Dir = fixtureRoot
		rerun.Env = append(isolatedCheckEnv(t, tempDir), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		rerunOutput, rerunErr := rerun.CombinedOutput()
		if rerunErr == nil {
			t.Fatalf("suggested command %q succeeded, want the fixture check failure", check.RerunCommand)
		}
		observed, readErr := os.ReadFile(filepath.Join(fixtureRoot, "rerun.log"))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if strings.TrimSpace(string(observed)) != check.Check {
			t.Fatalf("suggested command %q ran %q, want only %s; output: %s", check.RerunCommand, observed, check.Check, rerunOutput)
		}
		if _, err := os.Stat(filepath.Join(fixtureRoot, "injected")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("suggested command %q interpreted shell metacharacters in the check name; injected file stat error: %v", check.RerunCommand, err)
		}
	}
}

func isolatedCheckEnv(t *testing.T, home string) []string {
	t.Helper()
	env := make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		if strings.HasPrefix(item, "KB_PLATFORM_ROOT=") || strings.HasPrefix(item, "KB_HOME=") || strings.HasPrefix(item, "KB_NET_OFFSET=") || strings.HasPrefix(item, "HOME=") {
			continue
		}
		env = append(env, item)
	}
	goEnv, err := exec.Command("go", "env", "GOPATH", "GOMODCACHE", "GOCACHE").Output()
	if err != nil {
		t.Fatalf("read Go cache locations: %v", err)
	}
	paths := strings.Split(strings.TrimSpace(string(goEnv)), "\n")
	if len(paths) != 3 {
		t.Fatalf("go env returned %d paths, want GOPATH, GOMODCACHE, GOCACHE", len(paths))
	}
	env = append(env, "HOME="+home, "GOPATH="+paths[0], "GOMODCACHE="+paths[1], "GOCACHE="+paths[2])
	return env
}

// case: S-179.27
func TestSelectedCheckCountsOnlyApplicablePackagePairs(t *testing.T) {
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}},
		Custom:  []config.CustomCheck{{Name: "cli-naming", Run: "true", On: []string{"check"}, Categories: []string{"plugin-entry"}}},
	}
	ws := &workspace.Workspace{Packages: []workspace.Package{
		{Name: "@acme/plugin-a", Category: "plugin-entry", Preset: "node-lib"},
		{Name: "@acme/plugin-b", Category: "plugin-entry", Preset: "node-lib"},
		{Name: "@acme/library", Category: "ts-lib", Preset: "node-lib"},
	}}
	registry := checks.Build(cfg, ".", "check")

	wholeWorkspace := selectedCheckCounts(ws, cfg, registry, []string{"cli-naming"}, "", true)
	if wholeWorkspace["plugin-entry"] != 2 || sumCheckCounts(wholeWorkspace) != 2 {
		t.Fatalf("whole-workspace counts = %#v, want exactly two applicable packages", wholeWorkspace)
	}
	wholeResults := checks.RunAll(ws, cfg, registry, []string{"cli-naming"}, nil)
	if len(wholeResults) != 2 {
		t.Fatalf("whole-workspace executed packages = %d, want the two hand-counted plugin-entry packages", len(wholeResults))
	}
	for _, name := range []string{"@acme/plugin-a", "@acme/plugin-b"} {
		if wholeResults[name].ChecksRun != len(registry.ApplicableRulesFor(wholeResults[name].Package, cfg.Presets["node-lib"], []string{"cli-naming"})) {
			t.Fatalf("%s execution count = %d, applicability owner returned a different count", name, wholeResults[name].ChecksRun)
		}
	}
	mixed := selectedCheckCounts(ws, cfg, registry, []string{"cli-naming", "package_json"}, "", true)
	if mixed["plugin-entry"] != 2*2 || mixed["ts-lib"] != 1 || sumCheckCounts(mixed) != 5 {
		t.Fatalf("mixed counts = %#v, want 4 plugin-entry pairs and 1 ts-lib pair", mixed)
	}
	mixedResults := checks.RunAll(ws, cfg, registry, []string{"cli-naming", "package_json"}, nil)
	if len(mixedResults) != 3 || mixedResults["@acme/plugin-a"].ChecksRun != 2 || mixedResults["@acme/plugin-b"].ChecksRun != 2 || mixedResults["@acme/library"].ChecksRun != 1 {
		t.Fatalf("mixed execution = %#v, want only the five applicable pairs", mixedResults)
	}
}

func TestSelectedCheckPackagesUsesDeclaredReleaseLaneAndAllowsExplicitInternalPackage(t *testing.T) {
	ws := &workspace.Workspace{Packages: []workspace.Package{
		{Name: "@acme/host"},
		{Name: "@acme/runner", ReleaseLane: "internal-tool"},
	}}
	if got := selectedCheckPackages(ws, ""); len(got) != 1 || got[0].Name != "@acme/host" {
		t.Fatalf("default package checks = %#v, want only gating package", got)
	}
	if got := selectedCheckPackages(ws, "@acme/runner"); len(got) != 1 || got[0].Name != "@acme/runner" {
		t.Fatalf("explicit internal-tool checks = %#v, want runner", got)
	}
}

func TestInternalToolCheckScopeRequiresDeclaredInternalLane(t *testing.T) {
	ws := &workspace.Workspace{Packages: []workspace.Package{
		{Name: "@acme/host"},
		{Name: "@acme/runner", ReleaseLane: "internal-tool"},
	}}
	if got, err := internalToolCheckPackage(ws, "@acme/runner"); err != nil || len(got) != 1 || got[0].Name != "@acme/runner" {
		t.Fatalf("internal-tool scope selection = %#v, %v; want runner", got, err)
	}
	if _, err := internalToolCheckPackage(ws, "@acme/host"); err == nil {
		t.Fatal("internal-tool scope accepted an undeclared gating package")
	}
}

func TestCheckCommandRegistersInternalToolPackageScope(t *testing.T) {
	flag := checkCmd.Flags().Lookup("internal-tool-package")
	if flag == nil || flag.Usage == "" {
		t.Fatal("check command does not expose internal-tool package scope")
	}
}

func TestCandidateCheckSelectionRetainsNonBoundaryPackageRules(t *testing.T) {
	cfg := &config.DevkitConfig{Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}}}
	ws := &workspace.Workspace{Packages: []workspace.Package{{Name: "@acme/host", Category: "ts-lib", Preset: "node-lib"}}}
	counts := selectedCheckCounts(ws, cfg, checks.Default(), nil, "", true)
	if counts["ts-lib"] == 0 || counts["workspace"] == 0 {
		t.Fatalf("candidate check counts = %#v, want package_json and workspace checks", counts)
	}
}

// case: S-179.27
func TestWorkspaceScopedCheckCountIsAnchoredOnce(t *testing.T) {
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"node-lib": {Language: "typescript"}},
		Custom:  []config.CustomCheck{{Name: "workspace-audit", Run: "true", On: []string{"check"}, Language: "any", Scope: "workspace"}},
	}
	ws := &workspace.Workspace{Packages: []workspace.Package{
		{Name: "@acme/plugin-a", Category: "plugin-entry", Preset: "node-lib"},
		{Name: "@acme/library", Category: "ts-lib", Preset: "node-lib"},
	}}
	counts := selectedCheckCounts(ws, cfg, checks.Build(cfg, ".", "check"), []string{"workspace-audit"}, "", true)
	if counts["workspace"] != 1 || sumCheckCounts(counts) != 1 {
		t.Fatalf("workspace count = %#v, want one anchored check", counts)
	}
	results := checks.RunAll(ws, cfg, checks.Build(cfg, ".", "check"), []string{"workspace-audit"}, nil)
	if results["workspace"].ChecksRun != 1 || len(results) != 1 {
		t.Fatalf("workspace execution = %#v, want one anchored run independent of package count", results)
	}
	emptyWorkspace := &workspace.Workspace{Root: t.TempDir()}
	registry := checks.Build(cfg, ".", "check")
	if err := validateCheckSelection(emptyWorkspace, cfg, registry, []string{"workspace-audit"}, "", true); err != nil {
		t.Fatalf("workspace-only check selection returned %v, want one real anchored check", err)
	}
	if counts := selectedCheckCounts(emptyWorkspace, cfg, registry, []string{"workspace-audit"}, "", true); counts["workspace"] != 1 {
		t.Fatalf("empty workspace counts = %#v, want one anchored check", counts)
	}
}

// case: S-179.29
func TestCheckFailureEnvelopeUsesStandardsViolationCodeAndData(t *testing.T) {
	previousJSONMode := jsonMode
	t.Cleanup(func() { jsonMode = previousJSONMode })
	jsonMode = true
	err := outputCheckJSON(map[string]checks.PackageResult{
		"@acme/demo": {
			Package: workspace.Package{Name: "@acme/demo", RelPath: "packages/demo", Category: "ts-lib"},
			Issues:  []checks.Issue{{Check: "package_json", Severity: checks.SeverityError, Message: "missing field"}},
		},
	}, &config.DevkitConfig{}, map[string]int{"ts-lib": 1}, 1)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_DEVKIT_STANDARDS_VIOLATIONS" || failure.Data == nil {
		t.Fatalf("error = %#v, want standards-violation diagnostic with result data", err)
	}
}

// case: S-179.44
func TestCheckHumanWarningsAreNonBlocking(t *testing.T) {
	results := map[string]checks.PackageResult{
		"@acme/demo": {
			Package: workspace.Package{Name: "@acme/demo", RelPath: "packages/demo", Category: "ts-lib"},
			Issues:  []checks.Issue{{Check: "warning-check", Severity: checks.SeverityWarning, Message: "informational finding"}},
		},
	}
	var humanOutput bytes.Buffer
	restoreOutput := clikitcommand.SetOutputWriter(&humanOutput)
	defer restoreOutput()
	if err := outputCheckHuman(results, &config.DevkitConfig{}, map[string]int{"ts-lib": 1}, 1); err != nil {
		t.Fatalf("warning-only check returned %v, want success", err)
	}
	if output := humanOutput.String(); !strings.Contains(output, "warning") || !strings.Contains(output, "informational finding") {
		t.Fatalf("human output = %q, want warning label and finding text", output)
	}
	jsonErr := outputCheckJSON(results, &config.DevkitConfig{}, map[string]int{"ts-lib": 1}, 1)
	jsonData, ok := clikitresult.ReturnedData(jsonErr)
	if !ok {
		t.Fatalf("warning-only JSON result = %v, want returned JSON data", jsonErr)
	}
	jsonResult, ok := jsonData.(checkJSONResult)
	if !ok {
		t.Fatalf("warning-only JSON data has type %T, want checkJSONResult", jsonData)
	}
	if !jsonResult.OK || jsonResult.Summary.Errors != 0 || jsonResult.Summary.Warnings != 1 {
		t.Fatalf("warning-only JSON result = %#v, want ok with 0 errors and 1 warning", jsonResult)
	}
	packageResult, ok := jsonResult.Packages["@acme/demo"]
	if !ok || !packageResult.OK || len(packageResult.Issues) != 1 || packageResult.Issues[0].Severity != checks.SeverityWarning {
		t.Fatalf("warning-only JSON package result = %#v, want one warning issue and ok package", packageResult)
	}
	results["@acme/demo"] = checks.PackageResult{
		Package: workspace.Package{Name: "@acme/demo", RelPath: "packages/demo", Category: "ts-lib"},
		Issues:  []checks.Issue{{Check: "error-check", Severity: checks.SeverityError, Message: "blocking finding"}},
	}
	err := outputCheckHuman(results, &config.DevkitConfig{}, map[string]int{"ts-lib": 1}, 1)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_DEVKIT_STANDARDS_VIOLATIONS" {
		t.Fatalf("error-severity check returned %v, want standards-violation diagnostic", err)
	}
}

// case: S-179.30
func TestCheckExecutionFailureIsTypedAndActionable(t *testing.T) {
	failures := []externalCheckFailure{{Check: "adapter-manifest", Cause: "external command exited with status 1", ExitCode: 1, ExitCodeKnown: true, StderrTail: "fixture detail"}}
	err := externalCheckFailureError(checkCmd, failures, nil)
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != "KB_DEVKIT_CHECK_EXECUTION_FAILED" {
		t.Fatalf("error = %#v, want typed external-check failure", err)
	}
	if !strings.Contains(failure.Cause, "adapter-manifest") || !strings.Contains(failure.Cause, "fixture detail") {
		t.Fatalf("failure = %#v, want safe cause and rerun hint", failure)
	}
	expectedDiagnostic, err := diag.FromCatalog("KB_DEVKIT_CHECK_EXECUTION_FAILED", map[string]string{
		"check": "adapter-manifest", "exitCode": "1", "stderrTail": "fixture detail",
		"nextCommand": "kb-devkit check --only " + shellQuoteArgument("adapter-manifest") + " --json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if failure.Hint != expectedDiagnostic.Hint {
		t.Fatalf("hint = %q, want catalog-rendered hint %q", failure.Hint, expectedDiagnostic.Hint)
	}
	envelope, err := diag.ToEnvelope(failure)
	if err != nil {
		t.Fatalf("ToEnvelope() error = %v, want catalogued check detail", err)
	}
	expectedEnvelope, err := diag.ToEnvelope(expectedDiagnostic)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Message != expectedEnvelope.Message || envelope.Hint != expectedEnvelope.Hint {
		t.Fatalf("envelope = %#v, want catalog-rendered message and hint %#v", envelope, expectedEnvelope)
	}
	if len(checkExecutionFailures(map[string]checks.PackageResult{
		"a": {Issues: []checks.Issue{{Check: "browser-node-builtins", CheckFailure: true, Cause: "exit 1"}}},
		"b": {Issues: []checks.Issue{{Check: "adapter-manifest", CheckFailure: true, Cause: "exit 2"}}},
	})) != 2 {
		t.Fatal("checkExecutionFailures dropped a crashed check")
	}
}

func TestKnownZeroExitStatusReportsActualFailureCause(t *testing.T) {
	failures := []externalCheckFailure{{Check: "test-pyramid", Cause: "result file missing: /tmp/result.json", ExitCode: 0, ExitCodeKnown: true}}
	err := externalCheckFailureError(checkCmd, failures, nil)
	var diagnostic *diag.Diag
	if !errors.As(err, &diagnostic) || !strings.Contains(diagnostic.Message, "result file missing: /tmp/result.json") {
		t.Fatalf("diagnostic = %#v, want the actual result-file failure", err)
	}
	if strings.Contains(diagnostic.Message, "exited with status 0") {
		t.Fatalf("diagnostic = %#v, must not report successful exit as the failure", diagnostic)
	}
}

// case: S-179.27
func TestExternalToolTimeoutDiagnosticSurvivesCheckFailureAggregation(t *testing.T) {
	diagnostic, err := diag.FromCatalog("KB_TOOLCHAIN_EXTERNAL_TIMEOUT", map[string]string{
		"tool": "fixture", "argsSummary": "check", "elapsed": "30m", "stderrTail": "", "nextCommand": "kb-devkit check --only slow-check",
	})
	if err != nil {
		t.Fatal(err)
	}
	issues := map[string]checks.PackageResult{
		"workspace": {Issues: []checks.Issue{{Check: "slow-check", CheckFailure: true, Cause: "tool timeout", FailureDiagnostic: diagnostic}}},
	}
	failures := checkExecutionFailures(issues)
	if len(failures) != 1 || failures[0].Diagnostic != diagnostic {
		t.Fatalf("check failures = %#v, want preserved toolchain diagnostic", failures)
	}
	err = externalCheckFailureError(checkCmd, failures, issues)
	var got *diag.Diag
	if !errors.As(err, &got) || got.Code != "KB_TOOLCHAIN_EXTERNAL_TIMEOUT" {
		t.Fatalf("aggregated timeout = %#v, want KB_TOOLCHAIN_EXTERNAL_TIMEOUT", err)
	}
}
