//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/clikit/diag"
)

func TestZaiIsExplicitOnlyAndSharesClaudeStreamParser(t *testing.T) {
	if defaultAgentVendor != "codex" {
		t.Fatalf("default vendor=%q; zai must remain opt-in", defaultAgentVendor)
	}
	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("test-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KB_RUNNER_ZAI_KEY_FILE", keyPath)
	if _, err := newAdapter("zai"); err != nil {
		t.Fatalf("explicit zai adapter: %v", err)
	}
	assistant, err := parseVendorEvent("zai", []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":13,"output_tokens":7}}}`))
	if err != nil || assistant.Kind != EventActivity || assistant.Message != "hello" || assistant.InputTokens != 13 || assistant.OutputTokens != 7 {
		t.Fatalf("z.ai Claude assistant event=%+v err=%v", assistant, err)
	}
	event, err := parseVendorEvent("zai", []byte(`{"type":"result","result":"done","usage":{"input_tokens":13,"output_tokens":7}}`))
	if err != nil || event.Kind != EventFinal || event.InputTokens != 13 || event.OutputTokens != 7 {
		t.Fatalf("z.ai Claude result event=%+v err=%v", event, err)
	}
	if _, err := newAdapter("gemini"); err == nil {
		t.Fatal("unregistered vendor unexpectedly selected")
	}
}

func TestZaiChildEnvironmentIsolatedAndDoesNotPersistSecret(t *testing.T) {
	state := t.TempDir()
	keyPath := filepath.Join(t.TempDir(), "zai-key")
	const token = "secret-zai-token-fixture"
	if err := os.WriteFile(keyPath, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KB_RUNNER_ZAI_KEY_FILE", keyPath)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(os.Getenv("HOME"), ".claude"))
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-session-token")
	t.Setenv("ANTHROPIC_BASE_URL", "https://parent.invalid")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "parent-token")
	t.Setenv("ANTHROPIC_DEFAULT_OPUS_MODEL", "parent-opus")
	t.Setenv("ANTHROPIC_DEFAULT_SONNET_MODEL", "parent-sonnet")
	t.Setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "parent-haiku")
	for _, key := range []string{"ZAI_OPUS_MODEL", "ZAI_SONNET_MODEL", "ZAI_HAIKU_MODEL"} {
		t.Setenv(key, "")
	}
	fake := filepath.Join(t.TempDir(), "claude")
	childEnvPath := filepath.Join(t.TempDir(), "child.env")
	script := fmt.Sprintf(`#!/bin/sh
/usr/bin/env | while IFS= read -r row; do
  case "$row" in ANTHROPIC_AUTH_TOKEN=*) echo "ANTHROPIC_AUTH_TOKEN=[redacted]" >> %s;; *) echo "$row" >> %s;; esac
done
printf '%%s\n' '{"type":"result","result":"done"}'
`, shellQuote(childEnvPath), shellQuote(childEnvPath))
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_BIN", fake)
	adapter, err := newAdapter("zai")
	if err != nil {
		t.Fatal(err)
	}
	command, err := adapter.Start(context.Background(), AgentRequest{Workdir: t.TempDir(), Prompt: "safe", StateDir: state, JobID: "isolated-test"})
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	request := AgentRequest{Workdir: t.TempDir(), Prompt: "safe resume", StateDir: state, JobID: "isolated-test", SessionID: "session-zai"}
	resume, err := adapter.Resume(context.Background(), request)
	if err != nil || !strings.Contains(strings.Join(resume.Args, " "), "--resume") {
		t.Fatalf("z.ai resume command=%v err=%v", resume, err)
	}
	if _, err := resume.Output(); err != nil {
		t.Fatalf("z.ai fake resume: %v", err)
	}
	dump, err := os.ReadFile(childEnvPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(dump)
	allowedVendorNames := map[string]bool{
		"ANTHROPIC_AUTH_TOKEN": true, "ANTHROPIC_BASE_URL": true,
		"ANTHROPIC_DEFAULT_OPUS_MODEL": true, "ANTHROPIC_DEFAULT_SONNET_MODEL": true,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL": true, "CLAUDE_CONFIG_DIR": true,
	}
	for _, row := range strings.Split(text, "\n") {
		name, _, _ := strings.Cut(row, "=")
		if (strings.HasPrefix(name, "ANTHROPIC_") || strings.HasPrefix(name, "CLAUDE_")) && !allowedVendorNames[name] {
			t.Errorf("z.ai child inherited undeclared vendor environment %s", name)
		}
	}
	for _, forbidden := range []string{"parent-session-token", "parent-token", "parent.invalid", filepath.Join(os.Getenv("HOME"), ".claude"), token} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("isolated child environment contains forbidden value %q", forbidden)
		}
	}
	for _, required := range []string{
		"ANTHROPIC_AUTH_TOKEN=[redacted]",
		"ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic",
		"ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3",
		"ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash",
		"HOME=" + filepath.Join(state, "vendors", "zai", "isolated-test", "home"),
		"CLAUDE_CONFIG_DIR=" + filepath.Join(state, "vendors", "zai", "isolated-test", "claude-config"),
	} {
		if !strings.Contains(text, required) {
			t.Errorf("child environment omitted %q: %s", required, text)
		}
	}
	if strings.Contains(string(output), token) {
		t.Fatal("fake provider output leaked key contents")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".claude")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("test child touched its parent Claude state path: %v", err)
	}
	if got := adapter.(commandAdapter).Redact("message=" + token); strings.Contains(got, token) {
		t.Fatalf("redactor leaked the key: %q", got)
	}
}

func TestZaiFakeRunNeverPersistsKeyInRunnerArtifacts(t *testing.T) {
	state := t.TempDir()
	keyPath := filepath.Join(t.TempDir(), "key")
	const token = "never-persist-this-zai-token"
	if err := os.WriteFile(keyPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KB_RUNNER_ZAI_KEY_FILE", keyPath)
	fake := filepath.Join(t.TempDir(), "claude")
	argvPath := filepath.Join(t.TempDir(), "argv.txt")
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s %%s\\n' "$0" "$*" > %s
printf '{"type":"result","result":"%%s","usage":{"input_tokens":11,"output_tokens":7}}\n' "$ANTHROPIC_AUTH_TOKEN"
printf '%%s\n' "$ANTHROPIC_AUTH_TOKEN" >&2
exit 1
`, shellQuote(argvPath))
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_BIN", fake)
	store := newJobStore(state)
	if _, err := store.Create(Job{ID: "zai-secret", Stream: "secret-check", Vendor: "zai", State: JobRunning, Phase: PhaseRun, StartedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	prompt := filepath.Join(t.TempDir(), "prompt")
	if err := os.WriteFile(prompt, []byte("safe prompt"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	code, runErr := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"--state", state, "--stream", "secret-check", "--vendor", "zai", "--workdir", work,
		"--prompt-file", prompt, "--job-id", "zai-secret",
	}, &out, &errOut)
	if code == 0 || runErr == nil || strings.Contains(runErr.Error(), token) || strings.Contains(out.String()+errOut.String(), token) {
		t.Fatalf("provider failure did not return a safe diagnostic: code=%d err=%v out=%s stderr=%s", code, runErr, out.String(), errOut.String())
	}
	job, err := store.Get("zai-secret")
	if err != nil {
		t.Fatal(err)
	}
	if job.InputTokens != 11 || job.OutputTokens != 7 || job.Tokens != 18 {
		t.Fatalf("persisted z.ai usage=%+v", job)
	}
	psOutput, err := os.ReadFile(argvPath)
	if err != nil || strings.Contains(string(psOutput), token) {
		t.Fatalf("fake provider argv visible to ps exposed the key: %q err=%v", psOutput, err)
	}
	fakeContents, err := os.ReadFile(fake)
	if err != nil || strings.Contains(string(fakeContents), token) {
		t.Fatalf("fake CLI fixture contains the key: %q err=%v", fakeContents, err)
	}
	err = filepath.WalkDir(state, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), token) {
			t.Errorf("runner artifact %s contains the API key", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestZaiKeyFileDiagnosticUsesCatalogAndRunnableNextCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing")
	_, readErr := readZaiKeyFile(path)
	if readErr == nil {
		t.Fatal("missing key file accepted")
	}
	diagnostic := zaiKeyDiagnostic(runnerRoot{invocation: "/tmp/kb-runner"}, readErr)
	text := renderDiagnostic(diagnostic.(*diag.Diag))
	if !strings.Contains(text, "KB_RUNNER_ZAI_KEY_FILE_INVALID") || !strings.Contains(text, "'/tmp/kb-runner' agent --help") || strings.Contains(text, "secret") {
		t.Fatalf("diagnostic=%s", text)
	}
}

func TestZaiKeyFileRefusesMissingEmptyAndOverbroadModes(t *testing.T) {
	tests := []struct {
		name string
		mode os.FileMode
		body string
	}{
		{name: "empty", mode: 0o600},
		{name: "group readable", mode: 0o640, body: "key"},
		{name: "owner executable", mode: 0o700, body: "key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "key")
			if err := os.WriteFile(path, []byte(test.body), test.mode); err != nil {
				t.Fatal(err)
			}
			if _, err := readZaiKeyFile(path); err == nil {
				t.Fatal("unsafe key file was accepted")
			}
		})
	}
	if _, err := readZaiKeyFile(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing key file was accepted")
	}
}

func TestZaiModelMappingCanBeConfigured(t *testing.T) {
	t.Setenv("ZAI_OPUS_MODEL", "glm-custom-opus")
	env, err := vendorAgentEnvironment("zai", nil, AgentRequest{StateDir: t.TempDir(), JobID: "job-config"}, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "ANTHROPIC_DEFAULT_OPUS_MODEL=glm-custom-opus") {
		t.Fatalf("custom model mapping missing: %s", joined)
	}
}

func TestZaiLimitsRecordGrantAndDisplaysLedger(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	for _, job := range []Job{
		{ID: "zai-1", Vendor: "zai", StartedAt: time.Date(2026, 10, 24, 1, 0, 0, 0, time.UTC), Tokens: 125},
		{ID: "zai-2", Vendor: "zai", StartedAt: time.Date(2026, 10, 24, 2, 0, 0, 0, time.UTC), Tokens: 75},
	} {
		if _, err := store.Create(job); err != nil {
			t.Fatal(err)
		}
	}
	var out, errOut strings.Builder
	code, err := limitsRecordCommand(runnerRoot{invocation: "kb-runner"}, []string{"zai", "--state", state, "--grant", "500M"}, &out)
	if code != 0 || err != nil {
		t.Fatalf("record grant: code=%d err=%v out=%s", code, err, out.String())
	}
	code, err = limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state}, &out, &errOut, func(string) (limitsProvider, error) {
		return fakeLimitProvider{}, nil
	})
	if code != 0 || err != nil || !strings.Contains(out.String(), "zai spent 75 tokens (this job) / 200 total; remaining 499999800") {
		t.Fatalf("limits display: code=%d err=%v out=%s", code, err, out.String())
	}
	if strings.Contains(out.String(), "gemini") {
		t.Fatal("Gemini unexpectedly appears in limits")
	}
	var jsonOut strings.Builder
	code, err = limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state, "--json"}, &jsonOut, &errOut, func(string) (limitsProvider, error) {
		return fakeLimitProvider{}, nil
	})
	var limits []VendorLimit
	if code != 0 || err != nil || json.Unmarshal([]byte(jsonOut.String()), &limits) != nil {
		t.Fatalf("limits JSON: code=%d err=%v output=%s", code, err, jsonOut.String())
	}
	var sawSpend bool
	for _, limit := range limits {
		if limit.Vendor == "gemini" {
			t.Fatal("Gemini unexpectedly appears in limits JSON")
		}
		if limit.Vendor == "zai" && limit.Spend != nil && limit.Spend.Total == 200 {
			sawSpend = true
		}
	}
	if !sawSpend {
		t.Fatalf("limits JSON omitted z.ai ledger: %+v", limits)
	}
	var grant vendorGrant
	data, err := os.ReadFile(filepath.Join(state, "limits", "zai.grant.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &grant); err != nil || grant.Tokens != 500_000_000 || grant.RecordedAt.IsZero() {
		t.Fatalf("persisted grant=%+v err=%v", grant, err)
	}
}

func TestZaiUsageEventsAccumulateInputAndOutputTokens(t *testing.T) {
	job := Job{Vendor: "zai"}
	for _, line := range []string{
		`{"type":"usage","usage":{"input_tokens":10,"output_tokens":2}}`,
		`{"type":"usage","usage":{"input_tokens":4,"output_tokens":8}}`,
	} {
		event, err := parseVendorEvent("claude", []byte(line))
		if err != nil {
			t.Fatal(err)
		}
		job.InputTokens += event.InputTokens
		job.OutputTokens += event.OutputTokens
		job.Tokens += event.InputTokens + event.OutputTokens
	}
	if job.InputTokens != 14 || job.OutputTokens != 10 || job.Tokens != 24 {
		t.Fatalf("usage totals=%+v", job)
	}
}
