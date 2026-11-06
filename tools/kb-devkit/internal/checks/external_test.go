package checks

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kb-labs/clikit/proc/child"
	"github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/testdeadline"
	"github.com/kb-labs/devkit/internal/workspace"
)

func resultFileEnvExpansion() string {
	return `"$` + ExternalCheckResultFileEnv + `"`
}

// case: S-179.27
func TestWorkspaceExternalCheckFailsAtDeclaredExecutionBudget(t *testing.T) {
	root := t.TempDir()
	cfg := &config.DevkitConfig{
		Checks: config.ChecksConfig{TimeoutMS: 25},
		Custom: []config.CustomCheck{{Name: "slow-check", Run: "sleep 5", On: []string{"check"}, Scope: "workspace"}},
	}
	ws := &workspace.Workspace{Root: root}
	started := time.Now()
	results := RunAll(ws, cfg, Build(cfg, root, "check"), []string{"slow-check"}, nil)
	if elapsed := time.Since(started); elapsed > testdeadline.ExternalCheckObservationSlack(t) {
		t.Fatalf("check elapsed = %s, exceeds the scaled observation slack", elapsed)
	}
	issues := results["workspace"].Issues
	if len(issues) != 1 || !issues[0].CheckFailure || issues[0].Check != "slow-check" {
		t.Fatalf("issues = %#v, want timed-out check failure named slow-check", issues)
	}
	if !strings.Contains(issues[0].Cause, "25ms") {
		t.Fatalf("cause = %q, want declared 25ms execution budget", issues[0].Cause)
	}
}

func TestExternalCommandCheckAndFix(t *testing.T) {
	root := t.TempDir()
	pkgDir := filepath.Join(root, "packages", "demo")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatalf("mkdir pkg: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(`{"name":"@acme/demo","version":"1.0.0"}`), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}

	script := filepath.Join(root, "external-check.sh")
	body := `#!/bin/sh
if [ "$KB_DEVKIT_MODE" = "fix" ]; then
  if [ "$KB_DEVKIT_DRY_RUN" != "true" ]; then
    echo "# demo" > "$KB_DEVKIT_PACKAGE_DIR/README.md"
  fi
  printf '{"issues":[]}\n' > __RESULT_FILE_REDIRECT__
  exit 0
fi
if [ ! -f "$KB_DEVKIT_PACKAGE_DIR/README.md" ]; then
  printf '{"issues":[{"check":"external-readme","severity":"error","message":"README missing","file":"%s/README.md","fix":"create README.md","capability":"scaffoldable"}]}' "$KB_DEVKIT_PACKAGE_DIR" > __RESULT_FILE_REDIRECT__
else
  printf '{"issues":[]}' > __RESULT_FILE_REDIRECT__
fi
`

	body = strings.ReplaceAll(body, "__RESULT_FILE_REDIRECT__", resultFileEnvExpansion())
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}

	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{
			"ext-lib": {Language: "typescript"},
		},
		Checks: config.ChecksConfig{
			Packages: map[string]config.CheckPackConfig{
				"external-readme": {
					Enabled: true,
					Config:  map[string]any{"requiredFile": "README.md"},
				},
			},
		},
		Custom: []config.CustomCheck{{
			Name:     "external-readme",
			Run:      script,
			Fix:      script,
			On:       []string{"check"},
			Language: "typescript",
		}},
	}
	ws := &workspace.Workspace{
		Root: root,
		Packages: []workspace.Package{{
			Name:     "@acme/demo",
			Dir:      pkgDir,
			RelPath:  "packages/demo",
			Category: "ext-lib",
			Preset:   "ext-lib",
			Language: "typescript",
		}},
	}

	registry := Build(cfg, root, "check")
	results := RunAll(ws, cfg, registry, []string{"external-readme"}, nil)
	result := results["@acme/demo"]
	if len(result.Issues) != 1 || result.Issues[0].Check != "external-readme" {
		t.Fatalf("issues = %#v, want external-readme issue", result.Issues)
	}

	var fixer Fixer
	for _, rule := range registry.All() {
		if rule.Name() == "external-readme" {
			f, ok := rule.(Fixer)
			if !ok {
				t.Fatalf("external rule does not implement Fixer")
			}
			fixer = f
			break
		}
	}
	if fixer == nil {
		t.Fatal("external fixer not found in registry")
	}
	if err := fixer.Apply(result.Package, result.Issues, false); err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(pkgDir, "README.md")); err != nil {
		t.Fatalf("README.md not created: %v", err)
	}
}

func TestWorkspaceExternalCheckRunsOnceWithResolvedPackageCategories(t *testing.T) {
	root := t.TempDir()
	payloadPath := filepath.Join(root, "payload.json")
	callsPath := filepath.Join(root, "calls.txt")
	scriptPath := filepath.Join(root, "check.sh")
	script := "#!/bin/sh\ncat > '" + payloadPath + "'\nprintf x >> '" + callsPath + "'\nprintf '{\"issues\":[]}' > " + resultFileEnvExpansion() + "\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"typescript": {Language: "typescript"}},
		Tasks: map[string]config.TaskConfig{
			"verify": {{Command: "true"}},
			"build":  {{Command: "true"}},
		},
		Custom: []config.CustomCheck{{Name: "workspace-check", Run: scriptPath, On: []string{"check"}, Scope: "workspace"}},
	}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{
		{Name: "@acme/adapter", Dir: filepath.Join(root, "adapters", "adapter"), Category: "adapter", Preset: "typescript", Language: "typescript", RelPath: "adapters/adapter"},
		{Name: "@acme/library", Dir: filepath.Join(root, "packages", "library"), Category: "ts-lib", Preset: "typescript", Language: "typescript", RelPath: "packages/library"},
	}}
	results := RunAll(ws, cfg, Build(cfg, root, "check"), nil, nil)
	if got := string(mustReadFile(t, callsPath)); got != "x" {
		t.Fatalf("workspace check calls = %q, want one invocation", got)
	}
	var input struct {
		GraphTasks []string `json:"graphTasks"`
		Workspace  struct {
			Root     string `json:"root"`
			Packages []struct {
				Name        string `json:"name"`
				Category    string `json:"category"`
				RelPath     string `json:"relPath"`
				BuildTarget bool   `json:"buildTarget"`
			} `json:"packages"`
		} `json:"workspace"`
	}
	if err := json.Unmarshal(mustReadFile(t, payloadPath), &input); err != nil {
		t.Fatalf("decode workspace stdin: %v", err)
	}
	if input.Workspace.Root != root || len(input.Workspace.Packages) != 2 {
		t.Fatalf("workspace input = %#v, want root and both discovered packages", input.Workspace)
	}
	if strings.Join(input.GraphTasks, ",") != "build,verify" {
		t.Fatalf("workspace task graph = %v, want sorted task names [build verify]", input.GraphTasks)
	}
	if input.Workspace.Packages[0].Category != "adapter" || input.Workspace.Packages[1].Category != "ts-lib" {
		t.Fatalf("package categories = %#v, want resolved devkit categories", input.Workspace.Packages)
	}
	if input.Workspace.Packages[0].BuildTarget || input.Workspace.Packages[1].BuildTarget {
		t.Fatalf("build targets = %#v, want false because config declares no build task", input.Workspace.Packages)
	}
	if result, ok := results["workspace"]; !ok || len(result.Issues) != 0 || result.ChecksRun != 3 {
		t.Fatalf("clean workspace check result = %#v, want the custom check, task-ownership check, and release boundary check", result)
	}
}

func TestPackageExternalCheckReceivesDiscoveredWorkspaceAndTaskGraph(t *testing.T) {
	root := t.TempDir()
	payloadPath := filepath.Join(root, "payload.json")
	script := filepath.Join(root, "check.sh")
	body := "#!/bin/sh\ncat > '" + payloadPath + "'\nprintf '{\"issues\":[]}' > " + resultFileEnvExpansion() + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"typescript": {Language: "typescript"}},
		Tasks:   map[string]config.TaskConfig{"test": {{Command: "true"}}, "build": {{Command: "true"}}},
		Custom:  []config.CustomCheck{{Name: "package-check", Run: script, On: []string{"check"}, Language: "typescript"}},
	}
	pkg := workspace.Package{Name: "@acme/demo", Dir: root, RelPath: "packages/demo", Category: "ts-lib", Preset: "typescript", Language: "typescript"}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{pkg}}
	results := RunPackageRulesForPackages(ws, ws.Packages, cfg, Build(cfg, root, "check"), []string{"package-check"}, nil)
	if result := results[pkg.Name]; len(result.Issues) != 0 {
		t.Fatalf("package-check issues = %#v", result.Issues)
	}
	var input struct {
		GraphTasks []string `json:"graphTasks"`
		Workspace  struct {
			Root     string `json:"root"`
			Packages []struct {
				Name string `json:"name"`
			} `json:"packages"`
		} `json:"workspace"`
	}
	if err := json.Unmarshal(mustReadFile(t, payloadPath), &input); err != nil {
		t.Fatalf("decode package-check stdin: %v", err)
	}
	if input.Workspace.Root != root || len(input.Workspace.Packages) != 1 || input.Workspace.Packages[0].Name != pkg.Name {
		t.Fatalf("package check workspace = %#v, want discovered package context", input.Workspace)
	}
	if strings.Join(input.GraphTasks, ",") != "build,test" {
		t.Fatalf("package check task graph = %v, want sorted task names [build test]", input.GraphTasks)
	}
}

func mustReadFile(t *testing.T, file string) []byte {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	return data
}

func TestBuildSkipsDisabledOrMismatchedExternalChecks(t *testing.T) {
	cfg := &config.DevkitConfig{
		Checks: config.ChecksConfig{
			Packages: map[string]config.CheckPackConfig{
				"disabled": {Enabled: false},
			},
		},
		Custom: []config.CustomCheck{
			{Name: "disabled", Run: "true", On: []string{"check"}, Language: "typescript"},
			{Name: "go-only", Run: "true", On: []string{"check"}, Language: "go"},
		},
	}

	registry := Build(cfg, t.TempDir(), "check")
	rules := registry.RulesFor(config.Preset{Language: "typescript"})
	for _, rule := range rules {
		if rule.Name() == "disabled" || rule.Name() == "go-only" {
			t.Fatalf("unexpected external rule %q in typescript registry", rule.Name())
		}
	}
}

func TestExternalCheckHonorsCategoryFilter(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '{\"issues\":[{\"check\":\"adapter-manifest\",\"severity\":\"error\",\"message\":\"reported\"}]}' > "+resultFileEnvExpansion()+"\n"), 0o755); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"typescript": {Language: "typescript"}},
		Custom:  []config.CustomCheck{{Name: "adapter-manifest", Run: script, On: []string{"check"}, Language: "typescript", Categories: []string{"adapter"}}},
	}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{
		{Name: "@acme/adapter", Dir: root, Category: "adapter", Preset: "typescript", Language: "typescript"},
		{Name: "@acme/library", Dir: root, Category: "ts-lib", Preset: "typescript", Language: "typescript"},
	}}
	results := RunAll(ws, cfg, Build(cfg, root, "check"), []string{"adapter-manifest"}, nil)
	if len(results["@acme/adapter"].Issues) != 1 {
		t.Fatalf("adapter issues = %#v, want one", results["@acme/adapter"].Issues)
	}
	if len(results["@acme/library"].Issues) != 0 {
		t.Fatalf("library issues = %#v, want none", results["@acme/library"].Issues)
	}
}

func TestExternalCheckHonorsDeclaredAnchorPackages(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '{\"issues\":[]}' > "+resultFileEnvExpansion()+"\n"), 0o755); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	cfg := &config.DevkitConfig{
		Presets: map[string]config.Preset{"typescript": {Language: "typescript"}},
		Custom:  []config.CustomCheck{{Name: "anchored", Run: script, On: []string{"check"}, Language: "typescript", AnchorPackages: []string{"@acme/site"}}},
	}
	ws := &workspace.Workspace{Root: root, Packages: []workspace.Package{
		{Name: "@acme/site", Dir: root, Category: "site", Preset: "typescript", Language: "typescript"},
		{Name: "@acme/library", Dir: root, Category: "ts-lib", Preset: "typescript", Language: "typescript"},
	}}
	registry := Build(cfg, root, "check")
	if applicable := registry.ApplicableRulesFor(ws.Packages[0], cfg.Presets["typescript"], nil); len(applicable) == 0 || applicable[len(applicable)-1].Name() != "anchored" {
		t.Fatalf("site rules = %#v, want anchored external check", applicable)
	}
	for _, rule := range registry.ApplicableRulesFor(ws.Packages[1], cfg.Presets["typescript"], nil) {
		if rule.Name() == "anchored" {
			t.Fatal("anchored external check applied to a non-anchor package")
		}
	}
}

func TestExternalCheckUsesCallerToolPath(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	node := filepath.Join(binDir, "node")
	if err := os.WriteFile(node, []byte("#!/bin/sh\nprintf '{\"issues\":[{\"check\":\"tool-path\",\"severity\":\"error\",\"message\":\"caller node selected\"}]}' > "+resultFileEnvExpansion()+"\n"), 0o755); err != nil {
		t.Fatalf("write fake node: %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+"/bin:/usr/bin")
	rule := &externalRule{name: "tool-path", run: "node", phase: "check", workspaceRoot: root}
	issues := rule.Check(workspace.Package{Name: "@acme/demo", Dir: root}, config.Preset{Language: "typescript"})
	if len(issues) != 1 || issues[0].Message != "caller node selected" {
		t.Fatalf("issues = %#v, want the fake node issue", issues)
	}
}

func TestExternalCheckCrashIsNotReportedAsAStandardsFinding(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'node:fs:441 raw stack details' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	rule := &externalRule{name: "adapter-manifest", run: script, phase: "check", workspaceRoot: root}
	issues := rule.Check(workspace.Package{Name: "@acme/demo", Dir: root}, config.Preset{Language: "typescript"})
	if len(issues) != 1 || !issues[0].CheckFailure || issues[0].Check != "adapter-manifest" {
		t.Fatalf("issues = %#v, want a typed external-check failure", issues)
	}
	if !strings.Contains(issues[0].Cause, "result file") || !strings.Contains(issues[0].Cause, "adapter-manifest") || issues[0].Message == "node:fs:441 raw stack details" {
		t.Fatalf("failure exposed raw process output: %#v", issues[0])
	}
	if !strings.Contains(issues[0].Cause, "status 1") {
		t.Fatalf("cause = %q, want the non-zero process exit", issues[0].Cause)
	}
	if !strings.Contains(issues[0].Cause, "node:fs:441 raw stack details") {
		t.Fatalf("cause = %q, want stderr tail from the crashing check", issues[0].Cause)
	}
}

func TestExternalCheckDecodeFailureRetainsSuccessfulProcessExitStatus(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '{truncated result' > "+resultFileEnvExpansion()+"\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	rule := &externalRule{name: "test-pyramid", run: script, phase: "check", scope: "workspace", workspaceRoot: root}
	issues := rule.CheckWorkspace(&workspace.Workspace{Root: root})
	if len(issues) != 1 || !issues[0].CheckFailure {
		t.Fatalf("issues = %#v, want a typed output-decode failure", issues)
	}
	if !issues[0].FailureExitCodeKnown || issues[0].FailureExitCode != 0 {
		t.Fatalf("exit status = %d (known %t), want the completed process status 0", issues[0].FailureExitCode, issues[0].FailureExitCodeKnown)
	}
	if !strings.Contains(issues[0].Cause, "test-pyramid") || !strings.Contains(issues[0].Cause, "invalid result envelope") || !strings.Contains(issues[0].Cause, "result file") {
		t.Fatalf("cause = %q, want check name and invalid result-file problem", issues[0].Cause)
	}
}

func TestExternalCheckRejectsMalformedResultEnvelopes(t *testing.T) {
	tests := []struct {
		name       string
		resultJSON string
		wantError  string
	}{
		{name: "top-level null", resultJSON: `null`, wantError: "JSON object"},
		{name: "missing issues", resultJSON: `{}`, wantError: "issues array"},
		{name: "null issues", resultJSON: `{"issues":null}`, wantError: "array"},
		{name: "object issues", resultJSON: `{"issues":{}}`, wantError: "array"},
		{name: "top-level array", resultJSON: `[]`, wantError: "JSON object"},
		{name: "top-level scalar", resultJSON: `17`, wantError: "JSON object"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			script := filepath.Join(root, "check.mjs")
			body := "import { writeFileSync } from 'node:fs';\n" +
				"writeFileSync(process.env[" + strconv.Quote(ExternalCheckResultFileEnv) + "], " + strconv.Quote(testCase.resultJSON) + ");\n"
			if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
				t.Fatalf("write script: %v", err)
			}
			rule := &externalRule{name: "envelope-check", run: "node " + strconv.Quote(script), phase: "check", scope: "workspace", workspaceRoot: root}
			issues := rule.CheckWorkspace(&workspace.Workspace{Root: root})
			if len(issues) != 1 || !issues[0].CheckFailure || issues[0].Check != "envelope-check" {
				t.Fatalf("issues = %#v, want named external-check failure", issues)
			}
			for _, want := range []string{"envelope-check", "result file", testCase.wantError} {
				if !strings.Contains(issues[0].Cause, want) {
					t.Errorf("cause = %q, want it to contain %q", issues[0].Cause, want)
				}
			}
		})
	}
}

func TestExternalCheckDecoderAcceptsEmptyIssuesArray(t *testing.T) {
	output, err := decodeExternalCheckOutput([]byte(`{"issues":[]}`))
	if err != nil {
		t.Fatalf("decode valid empty result envelope: %v", err)
	}
	if output.Issues == nil || len(output.Issues) != 0 {
		t.Fatalf("issues = %#v, want a non-nil empty issues array", output.Issues)
	}
}

func TestExternalCheckRunnerAcceptsEmptyIssuesArray(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.mjs")
	body := "import { writeCheckResult } from " + strconv.Quote(checkResultHelperURL(t)) + ";\n" +
		"writeCheckResult([]);\nprocess.stdout.write('check completed');\n"
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		t.Fatalf("write script: %v", err)
	}
	rule := &externalRule{name: "empty-envelope", run: "node " + strconv.Quote(script), phase: "check", scope: "workspace", workspaceRoot: root}
	output, err := rule.runCommandWithInput(rule.run, externalInput{
		WorkspaceRoot: root,
		Check:         rule.name,
		Phase:         rule.phase,
		Workspace:     &externalWorkspace{Root: root},
	})
	if err != nil {
		t.Fatalf("valid empty result envelope failed in the external runner: %#v", err)
	}
	if output.Issues == nil || len(output.Issues) != 0 {
		t.Fatalf("issues = %#v, want a valid empty issues array", output.Issues)
	}
}

func TestExternalCheckReadsResultFileAfterLargeStdoutAndImmediateExit(t *testing.T) {
	root := t.TempDir()
	helperURL := checkResultHelperURL(t)
	script := filepath.Join(root, "check.mjs")
	body := "import { writeCheckResult } from " + strconv.Quote(helperURL) + ";\n" +
		"writeCheckResult([{check:'large-output',severity:'warning',message:'result survived'}]);\n" +
		"process.stdout.write('x'.repeat(204800));\nprocess.exit(0);\n"
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	rule := &externalRule{name: "large-output", run: "node " + strconv.Quote(script), phase: "check", scope: "workspace", workspaceRoot: root}
	issues := rule.CheckWorkspace(&workspace.Workspace{Root: root})
	if len(issues) != 1 || issues[0].Message != "result survived" {
		t.Fatalf("issues = %#v, want result from file despite 200 KiB stdout", issues)
	}
}

func checkResultHelperURL(t *testing.T) string {
	t.Helper()
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate external check test source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(testFile), "../../../.."))
	helperPath := filepath.Join(repoRoot, "scripts/checks/lib/check-result.mjs")
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(helperPath)}).String()
}

func TestExternalCheckMissingResultFileNamesCheckAndFile(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf 'human diagnostic only\\n'\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	rule := &externalRule{name: "missing-result", run: script, phase: "check", scope: "workspace", workspaceRoot: root}
	issues := rule.CheckWorkspace(&workspace.Workspace{Root: root})
	if len(issues) != 1 || !issues[0].CheckFailure || issues[0].Check != "missing-result" {
		t.Fatalf("issues = %#v, want named external check failure", issues)
	}
	if !strings.Contains(issues[0].Cause, "missing-result") || !strings.Contains(issues[0].Cause, "read result file") || !strings.Contains(issues[0].Cause, "result.json") {
		t.Fatalf("cause = %q, want check and result-file problem", issues[0].Cause)
	}
}

func TestExternalCheckReportsObserverErrorAfterSuccessfulExit(t *testing.T) {
	observerErr := &child.ProcessObservationError{
		PID:         42,
		Observation: "live members",
		Cause:       fmt.Errorf("enumerate Darwin process table: %w", syscall.EPERM),
	}
	err := &toolchain.CommandError{ExitCode: 0, Err: observerErr}
	cause := safeExternalCause(err)
	if !strings.Contains(cause, "process observer error") || !strings.Contains(cause, "enumerate Darwin process table: operation not permitted") {
		t.Fatalf("cause = %q, want exact process-observer failure chain", cause)
	}
	if strings.Contains(cause, "exited with status 0") {
		t.Fatalf("cause = %q, must not describe successful exit as the failure", cause)
	}
}

func TestExternalOutputErrorIncludesCapturedStderrTail(t *testing.T) {
	err := &externalOutputError{
		stderrTail: "adapter check failed before result write",
		err:        fmt.Errorf("read result file for external check adapter-manifest: no such file or directory"),
	}
	message := err.Error()
	for _, expected := range []string{"adapter-manifest", "result file", "stderr tail", "adapter check failed before result write"} {
		if !strings.Contains(message, expected) {
			t.Errorf("error = %q, want %q", message, expected)
		}
	}
}

func TestExternalCheckRetainsIssuesWhenCommandFails(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "check.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '{\"issues\":[{\"check\":\"ci-clean-machine-lanes\",\"severity\":\"error\",\"message\":\"journey claim failed\",\"fix\":\"Rerun with: kb-devkit check --only ci-clean-machine-lanes\"}]}' > "+resultFileEnvExpansion()+"\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write check script: %v", err)
	}
	rule := &externalRule{name: "ci-clean-machine-lanes", run: script, phase: "check", scope: "workspace", workspaceRoot: root}
	issues := rule.CheckWorkspace(&workspace.Workspace{Root: root})
	if len(issues) != 1 {
		t.Fatalf("issues = %#v, want the issue emitted before command failure", issues)
	}
	if issues[0].Message != "journey claim failed" || issues[0].Fix != "Rerun with: kb-devkit check --only ci-clean-machine-lanes" {
		t.Fatalf("issue = %#v, want the emitted detail and rerun command", issues[0])
	}
}
