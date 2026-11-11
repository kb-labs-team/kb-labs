//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/testdeadline"

	"github.com/kb-labs/clikit/command"
	"github.com/kb-labs/clikit/diag"
)

func TestZcodeIsExplicitAndUsesItsOwnStreamParser(t *testing.T) {
	if defaultAgentVendor == "zcode" {
		t.Fatal("zcode must remain opt-in")
	}
	if _, ok := vendorRegistry["zcode"]; !ok {
		t.Fatal("zcode vendor is not registered")
	}
	if _, err := newAdapter("zcode"); err != nil {
		t.Fatalf("explicit zcode adapter: %v", err)
	}

	// Source: apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts:319-335
	activity, err := parseVendorEvent("zcode", []byte(`{"eventId":"evt-1","sessionId":"session-1","type":"model.streaming","payload":{"kind":"text_delta","delta":"working"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if activity.Kind != EventActivity || activity.SessionID != "session-1" {
		t.Fatalf("activity=%+v", activity)
	}

	// Source: apps/zcode-cli/packages/cli/src/prompt-command.ts:387-399
	final, err := parseVendorEvent("zcode", []byte(`{"type":"result","sessionId":"session-1","response":"done","usage":{"inputTokens":13,"outputTokens":7}}`))
	if err != nil {
		t.Fatal(err)
	}
	if final.Kind != EventFinal || final.SessionID != "session-1" || final.FinalMessage != "done" || final.InputTokens != 13 || final.OutputTokens != 7 {
		t.Fatalf("final=%+v", final)
	}

	// Source: apps/zcode-cli/packages/core/src/agent/turn-state.ts:160-164;
	// apps/zcode-cli/packages/core/src/runtime/helpers/turn-errors.ts:190-205;
	// apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts:394-404, 1489-1524
	failure, err := parseVendorEvent("zcode", []byte(`{"eventId":"evt-2","sessionId":"session-1","type":"turn.failed","payload":{"error":{"message":"provider failed"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if failure.Kind != EventVendorError || failure.SessionID != "session-1" || failure.Message != "provider failed" {
		t.Fatalf("failure=%+v", failure)
	}
}

func TestZcodeDefaultBinaryResolvesTheDocumentedWrapper(t *testing.T) {
	t.Setenv("ZCODE_BIN", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	got, err := vendorBinary(vendorRegistry["zcode"])
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "Desktop", "work", "zcode", "zcode")
	if got != want {
		t.Fatalf("default ZCode binary=%q want %q", got, want)
	}
}

func TestZcodeHelpDerivesVendorSetFromRegistry(t *testing.T) {
	var out, errOut strings.Builder
	root := runnerRoot{Root: command.InvocationRoot("kb-runner"), invocation: "kb-runner"}
	code, err := agentCommand(root, []string{"--help"}, &out, &errOut)
	if code != 0 || err != nil || !strings.Contains(out.String(), "zcode") {
		t.Fatalf("agent help: code=%d err=%v output=%q", code, err, out.String())
	}
	var limitsOut strings.Builder
	code, err = limitsRecordCommand(root, nil, &limitsOut)
	if code != 0 || err != nil || !strings.Contains(limitsOut.String(), "zai|zcode") {
		t.Fatalf("limits record help: code=%d err=%v output=%q", code, err, limitsOut.String())
	}
}

func TestZcodeChildEnvironmentIsCleanAndUsesAccountDataDirectory(t *testing.T) {
	home := t.TempDir()
	for key, value := range map[string]string{
		"HOME": home, "PATH": os.Getenv("PATH"), "TMPDIR": t.TempDir(),
		"CLAUDECODE": "parent", "CLAUDE_CODE_SESSION_ID": "session-parent", "CLAUDE_CODE_MESSAGING_TOKEN": "parent-message-token",
		"ANTHROPIC_AUTH_TOKEN": "parent-secret", "CODEX_HOME": filepath.Join(home, ".codex"),
		"ZCODE_PERSONAL_SETTING": "parent-setting", "ZCODE_DATA_BASE_DIR": "parent-zcode-dir",
	} {
		t.Setenv(key, value)
	}
	state := t.TempDir()
	env, err := vendorAgentEnvironment("zcode", nil, AgentRequest{StateDir: state, JobID: "job-zcode"}, "")
	if err != nil {
		t.Fatal(err)
	}
	values := make(map[string]string, len(env))
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("invalid child environment entry %q", entry)
		}
		values[key] = value
	}
	if values["ZCODE_DATA_BASE_DIR"] != filepath.Join(home, ".zcode-kb-runner") {
		t.Fatalf("ZCODE_DATA_BASE_DIR=%q", values["ZCODE_DATA_BASE_DIR"])
	}
	for _, key := range []string{"CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CODEX_HOME", "ZCODE_PERSONAL_SETTING", "ZCODE_BIN", "ZCODE_MODEL", "ZCODE_PROVIDER", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"} {
		if _, ok := values[key]; ok {
			t.Errorf("child inherited %s", key)
		}
	}
}

func TestZcodeSandboxProfileCanonicalizesSymlinkedWriteRoot(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ZCode sandbox profile requires the macOS sandbox-exec boundary")
	}
	// Expectations are canonical paths; t.TempDir may itself sit under a symlink such as /var.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	worktreeTarget := filepath.Join(root, "worktree-target")
	worktreeLink := filepath.Join(root, "worktree-link")
	for _, dir := range []string{
		worktreeTarget,
		filepath.Join(root, "job", "tmp"),
		filepath.Join(root, "home", ".zcode-kb-runner"),
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(worktreeTarget, worktreeLink); err != nil {
		t.Fatal(err)
	}
	profile, err := zcodeSandboxProfile(zcodeSandboxInputs{
		Worktree:   worktreeLink,
		JobTemp:    filepath.Join(root, "job", "tmp"),
		ZcodeState: []string{filepath.Join(root, "home", ".zcode-kb-runner")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(profile, "(subpath "+strconv.Quote(worktreeTarget)+")") {
		t.Fatalf("profile does not contain the canonical worktree target %q: %s", worktreeTarget, profile)
	}
	if strings.Contains(profile, "(subpath "+strconv.Quote(worktreeLink)+")") {
		t.Fatalf("profile retained the unresolved symlink path %q: %s", worktreeLink, profile)
	}
}

func TestZcodeSandboxProfileResolvesMissingRootThroughExistingParent(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ZCode sandbox profile requires the macOS sandbox-exec boundary")
	}
	// Expectations are canonical paths; t.TempDir may itself sit under a symlink such as /var.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	parentTarget := filepath.Join(root, "parent-target")
	parentLink := filepath.Join(root, "parent-link")
	jobTemp := filepath.Join(root, "job", "tmp")
	zcodeData := filepath.Join(root, "home", ".zcode-kb-runner")
	for _, dir := range []string{parentTarget, jobTemp, zcodeData} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(parentTarget, parentLink); err != nil {
		t.Fatal(err)
	}
	missingRoot := filepath.Join(parentLink, "new-worktree")
	profile, err := zcodeSandboxProfile(zcodeSandboxInputs{
		Worktree:   missingRoot,
		JobTemp:    jobTemp,
		ZcodeState: []string{zcodeData},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(parentTarget, "new-worktree")
	if !strings.Contains(profile, "(subpath "+strconv.Quote(want)+")") {
		t.Fatalf("profile does not resolve missing root through its canonical existing parent %q: %s", want, profile)
	}
}

func TestZcodeSandboxCommandAndProfileEnforceWriteBoundary(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ZCode sandbox boundary requires macOS sandbox-exec")
	}
	sandbox, err := exec.LookPath(zcodeSandboxBinary)
	if err != nil {
		t.Fatalf("sandbox-exec is unavailable: %v", err)
	}
	root := t.TempDir()
	worktreeTarget := filepath.Join(root, "worktree-target")
	worktree := filepath.Join(root, "worktree-link")
	outside := filepath.Join(root, "outside")
	jobTemp := filepath.Join(root, "job", "tmp")
	zcodeData := filepath.Join(root, "home", ".zcode-kb-runner")
	cache := filepath.Join(root, "home", ".npm")
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-message-token")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "parent-anthropic-token")
	t.Setenv("CODEX_HOME", filepath.Join(root, "home", ".codex"))
	t.Setenv("ZCODE_PERSONAL_SETTING", "parent-setting")
	for _, dir := range []string{worktreeTarget, outside, jobTemp, zcodeData, cache} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(worktreeTarget, worktree); err != nil {
		t.Fatal(err)
	}
	profile, err := zcodeSandboxProfile(zcodeSandboxInputs{Worktree: worktree, JobTemp: jobTemp, ZcodeState: []string{zcodeData}, NodeCaches: []string{cache}})
	if err != nil {
		t.Fatal(err)
	}
	insidePath := filepath.Join(worktree, "inside.txt")
	outsidePath := filepath.Join(outside, "outside.txt")
	environmentPath := filepath.Join(worktree, "environment.txt")
	fakeZcode := filepath.Join(root, "fake-zcode")
	if err := os.WriteFile(fakeZcode, []byte("#!/bin/sh\nset -e\n/usr/bin/env > \"$3\"\nprintf inside > \"$1\"\nprintf outside > \"$2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	cmd, err := zcodeSandboxCommand(context.Background(), sandbox, profile, fakeZcode, insidePath, outsidePath, environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd.Env, err = vendorAgentEnvironment("zcode", nil, AgentRequest{StateDir: t.TempDir(), JobID: "job-sandbox"}, "")
	if err != nil {
		t.Fatal(err)
	}
	combined, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatal("sandboxed shell wrote outside the allowlisted directories")
	}
	if data, readErr := os.ReadFile(insidePath); readErr != nil || string(data) != "inside" {
		t.Fatalf("write within worktree failed: data=%q err=%v command=%q", data, readErr, combined)
	}
	if _, readErr := os.Stat(outsidePath); !os.IsNotExist(readErr) {
		t.Fatalf("outside write unexpectedly exists: %v", readErr)
	}
	environment, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"parent-message-token", "parent-anthropic-token", "parent-setting", ".codex"} {
		if strings.Contains(string(environment), value) {
			t.Errorf("fake ZCode inherited parent setting %q", value)
		}
	}
	if !strings.Contains(string(environment), "ZCODE_DATA_BASE_DIR=") {
		t.Fatal("fake ZCode did not receive the vendor-owned data directory")
	}

	cmd, err = zcodeSandboxCommand(context.Background(), sandbox, profile, "/bin/sh", "-c", "printf boundary-ok")
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(output)) != "boundary-ok" {
		t.Fatalf("real /bin/sh boundary process: output=%q err=%v", output, err)
	}
}

func TestZcodeSandboxRefusesMissingSandboxExecutable(t *testing.T) {
	_, err := zcodeSandboxCommand(context.Background(), "", "", "/bin/sh")
	var sandboxErr zcodeSandboxError
	if !errors.As(err, &sandboxErr) {
		t.Fatal("missing sandbox executable was accepted")
	}
	diagnostic := zcodeSandboxDiagnostic(runnerRoot{invocation: "kb-runner"}, err)
	var typed *diag.Diag
	if !errors.As(diagnostic, &typed) || typed.Code != zcodeSandboxDiagnosticCode {
		t.Fatalf("sandbox refusal is not catalogued: %v", diagnostic)
	}
	entry, ok := diag.LookupCatalog(zcodeSandboxDiagnosticCode)
	if !ok || typed.Hint != entry.Hint {
		t.Fatalf("sandbox diagnostic hint does not come from catalog: %+v", typed)
	}
}

func TestZcodeSandboxProbeReturnsCataloguedRefusalWhenPolicyCannotApply(t *testing.T) {
	sandbox, err := exec.LookPath(zcodeSandboxBinary)
	if err != nil {
		_, err = zcodeSandboxCommand(context.Background(), "", "", "/bin/sh")
	} else {
		root := t.TempDir()
		profile, profileErr := zcodeSandboxProfile(zcodeSandboxInputs{
			Worktree:   filepath.Join(root, "worktree"),
			JobTemp:    filepath.Join(root, "job-temp"),
			ZcodeState: []string{filepath.Join(root, "zcode-data")},
		})
		if profileErr != nil {
			t.Fatal(profileErr)
		}
		err = probeZcodeSandbox(context.Background(), sandbox, profile)
	}
	if err == nil {
		return
	}
	var sandboxErr zcodeSandboxError
	if !errors.As(err, &sandboxErr) {
		t.Fatalf("sandbox application failure was not classified: %v", err)
	}
	diagnostic := zcodeSandboxDiagnostic(runnerRoot{invocation: "kb-runner"}, err)
	var typed *diag.Diag
	if !errors.As(diagnostic, &typed) || typed.Code != zcodeSandboxDiagnosticCode {
		t.Fatalf("sandbox application refusal is not catalogued: %v", diagnostic)
	}
}

func TestZcodeSandboxRefusalPersistsDiagnosticAndNextStep(t *testing.T) {
	store := newJobStore(t.TempDir())
	if _, err := store.Create(Job{ID: "zcode-refusal", Stream: "zcode", Vendor: "zcode", State: JobRunning, Phase: PhaseRun}); err != nil {
		t.Fatal(err)
	}
	code, err := failZcodeSandboxJob(store, "zcode-refusal", runnerRoot{invocation: "kb-runner"}, "final.md", zcodeSandboxError{reason: "sandbox policy unavailable"})
	if code != 1 || err == nil {
		t.Fatalf("refusal result: code=%d err=%v", code, err)
	}
	job, err := store.Get("zcode-refusal")
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := diag.LookupCatalog(zcodeSandboxDiagnosticCode)
	if !ok || job.Final == nil || !strings.Contains(job.Final.Error, entry.Message) || !strings.Contains(job.Final.Error, "xcode-select --install") {
		t.Fatalf("terminal diagnostic=%+v catalog=%+v", job.Final, entry)
	}
	if !strings.Contains(job.Final.Next, "status --state") {
		t.Fatalf("terminal next step=%q", job.Final.Next)
	}
}

func TestZcodeArgumentsUseOfficialHeadlessAndResumeContract(t *testing.T) {
	work := t.TempDir()
	for _, tc := range []struct {
		name string
		args []string
		want []string
	}{
		{name: "start", args: zcodeArgs(AgentRequest{Prompt: "task", Workdir: work}, false), want: []string{"--prompt", "task", "--cwd", work, "--mode", "yolo", "--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode", "--output-format", "stream-json", "--no-color"}},
		{name: "resume", args: zcodeArgs(AgentRequest{Prompt: "continue", Workdir: work, SessionID: "session-1"}, true), want: []string{"--resume", "session-1", "--prompt", "continue", "--cwd", work, "--mode", "yolo", "--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode", "--output-format", "stream-json", "--no-color"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.args) != len(tc.want) {
				t.Fatalf("args=%q want exact documented command args %q", tc.args, tc.want)
			}
			for index, want := range tc.want {
				if tc.args[index] != want {
					t.Errorf("arg[%d]=%q want %q", index, tc.args[index], want)
				}
			}
		})
	}
}

func TestZcodeResultUsageFeedsSharedGrantLedger(t *testing.T) {
	state := t.TempDir()
	event, err := parseVendorEvent("zcode", []byte(`{"type":"result","sessionId":"s","response":"done","usage":{"inputTokens":13,"outputTokens":7}}`))
	if err != nil {
		t.Fatal(err)
	}
	jobs := []Job{{ID: "zcode-1", Vendor: "zcode", Tokens: event.Tokens, InputTokens: event.InputTokens, OutputTokens: event.OutputTokens}}
	if _, err := newJobStore(state).Create(jobs[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := newVendorGrantStore(state, "zcode", time.Now).Record("500M"); err != nil {
		t.Fatal(err)
	}
	limit, err := vendorSpendLimit("zcode", state, jobs)
	if err != nil {
		t.Fatal(err)
	}
	if limit.Spend == nil || limit.Spend.Total != 20 || limit.Vendor != "zcode" || !limit.Spend.HasGrant || limit.Spend.Remaining != 499_999_980 {
		t.Fatalf("limit=%+v", limit)
	}
	var output strings.Builder
	code, err := limitsRecordCommand(runnerRoot{invocation: "kb-runner"}, []string{"zcode", "--state", state, "--grant", "500M"}, &output)
	if code != 0 || err != nil || !strings.Contains(output.String(), "Recorded zcode token grant") {
		t.Fatalf("zcode grant command: code=%d err=%v output=%q", code, err, output.String())
	}
	var display, errOut strings.Builder
	code, err = limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state}, &display, &errOut, func(string) (limitsProvider, error) {
		return fakeLimitProvider{}, nil
	})
	if code != 0 || err != nil || !strings.Contains(display.String(), "zcode spent 20 tokens (this job) / 20 total; remaining 499999980") {
		t.Fatalf("zcode limit display: code=%d err=%v output=%q", code, err, display.String())
	}
}

func TestZcodeParserResultIsMachineReadable(t *testing.T) {
	event, err := parseVendorEvent("zcode", []byte(`{"type":"result","sessionId":"s","response":"ok","usage":{"inputTokens":5,"outputTokens":8}}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil || !strings.Contains(string(encoded), `"tokens":13`) {
		t.Fatalf("event=%s err=%v", encoded, err)
	}
}

func TestZcodeStateRootsCoverAccountDataAndCLIStorage(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	roots := zcodeStateRoots(home)
	for _, want := range []string{zcodeDataBaseDir(home), filepath.Join(home, ".zcode", "cli")} {
		if !slices.Contains(roots, want) {
			t.Fatalf("ZCode state roots %v do not include %q", roots, want)
		}
	}
	if slices.Contains(roots, filepath.Join(home, ".zcode")) {
		t.Fatalf("ZCode state roots %v must not open the desktop app data root", roots)
	}
}

func TestZcodeEnvironmentCarriesJobModel(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ZCODE_MODEL", "parent-model")
	env, err := vendorAgentEnvironment("zcode", nil, AgentRequest{StateDir: t.TempDir(), JobID: "job-model", Model: "GLM-5.3"}, "")
	if err != nil {
		t.Fatal(err)
	}
	var models []string
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "ZCODE_MODEL="); ok {
			models = append(models, value)
		}
	}
	if len(models) != 1 || models[0] != "GLM-5.3" {
		t.Fatalf("ZCODE_MODEL entries = %q, want only the job model", models)
	}
}

func TestZcodeSandboxAllowsToolchainDevicesSignalsAndJobTemp(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ZCode sandbox boundary requires macOS sandbox-exec")
	}
	sandbox, err := exec.LookPath(zcodeSandboxBinary)
	if err != nil {
		t.Fatalf("sandbox-exec is unavailable: %v", err)
	}
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	state := filepath.Join(root, "state")
	request := AgentRequest{StateDir: state, JobID: "job-toolchain", Workdir: worktree}
	jobTemp := zcodeJobTemp(request)
	zcodeData := filepath.Join(root, "home", ".zcode-kb-runner")
	for _, dir := range []string{worktree, jobTemp, zcodeData} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	profile, err := zcodeSandboxProfile(zcodeSandboxInputs{Worktree: worktree, JobTemp: jobTemp, ZcodeState: []string{zcodeData}})
	if err != nil {
		t.Fatal(err)
	}
	// Each step is what a Go or Node test run does inside the agent sandbox.
	script := `set -e
echo discarded > /dev/null
mktemp "$TMPDIR/agent.XXXXXX" > /dev/null
/bin/sleep 30 & child=$!
kill -TERM "$child"
wait "$child" || true
printf toolchain-ok`
	cmd, err := zcodeSandboxCommand(context.Background(), sandbox, profile, "/bin/sh", "-c", script)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(root, "home"))
	cmd.Env, err = vendorAgentEnvironment("zcode", nil, request, "")
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	output, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(output)) != "toolchain-ok" {
		t.Fatalf("sandboxed toolchain steps: output=%q err=%v", output, err)
	}
	if elapsed := time.Since(started); elapsed > testdeadline.SignalDeliveryBound(t) {
		t.Fatalf("signal to own child was not delivered (took %s)", elapsed)
	}
}
