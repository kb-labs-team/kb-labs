//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const realCodexRateLimitsFixture = `{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","primary":{"usedPercent":82,"windowDurationMins":300,"resetsAt":1792775628},"secondary":{"usedPercent":24,"windowDurationMins":10080,"resetsAt":1793298749},"credits":{"hasCredits":true},"planType":"plus","rateLimitReachedType":null,"spendControlReached":false},"rateLimitsByLimitId":{"codex":{"limitId":"codex"}},"accountId":"private-account"}`

func TestDecodeCodexAppServerRealRateLimitShape(t *testing.T) {
	limits := decodeCodexLimits([]byte(realCodexRateLimitsFixture), time.Now)
	byWindow := map[string]VendorLimit{}
	for _, limit := range limits {
		byWindow[limit.Window] = limit
	}
	five, hasFive := byWindow["5h"]
	week, hasWeek := byWindow["week"]
	if !hasFive || !hasWeek || five.UsedPercent != 82 || week.UsedPercent != 24 {
		t.Fatalf("unexpected decoded Codex windows: %+v", limits)
	}
	if five.ResetsAt == nil || five.ResetsAt.Unix() != 1792775628 || week.ResetsAt == nil || week.ResetsAt.Unix() != 1793298749 {
		t.Fatalf("epoch reset values were not preserved: %+v", limits)
	}
	blocked := decodeCodexLimits([]byte(strings.Replace(realCodexRateLimitsFixture, `"rateLimitReachedType":null`, `"rateLimitReachedType":"primary"`, 1)), time.Now)
	if !quotaBlocked(blocked, 95, 98) {
		t.Fatalf("rateLimitReachedType did not block admission: %+v", blocked)
	}
	if nextBlockedReset(blocked, 95, 98) == nil {
		t.Fatalf("rateLimitReachedType block had no reset to await: %+v", blocked)
	}
	spendBlocked := decodeCodexLimits([]byte(strings.Replace(realCodexRateLimitsFixture, `"spendControlReached":false`, `"spendControlReached":true`, 1)), time.Now)
	if !quotaBlocked(spendBlocked, 95, 98) {
		t.Fatalf("spendControlReached did not block admission: %+v", spendBlocked)
	}
}

func TestCodexAppServerKeepsStdinOpenAndIgnoresNotifications(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "codex-app-server")
	script := "#!/bin/sh\nwhile IFS= read -r line; do\ncase \"$line\" in\n*'\"id\":1'*) printf '%s\\n' '{\"id\":1,\"result\":{}}' ;;\n*'account/rateLimits/read'*) printf '%s\\n' '{\"method\":\"remoteControl/status/changed\"}' '{\"method\":\"account/updated\"}' '{\"id\":2,\"result\":" + realCodexRateLimitsFixture + "}'; exit 0 ;;\nesac\ndone\n"
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	limits, _, err := readCodexLimitsDetailed(context.Background(), fake)
	if err != nil {
		t.Fatal(err)
	}
	if !hasVendorLimits(limits) {
		t.Fatalf("app-server response after notifications was lost: %+v", limits)
	}
}

func TestLimitCaptureRedactsSensitiveStructuredFields(t *testing.T) {
	input := json.RawMessage(`{"accountId":"private","email":"person@example.test","nested":{"accessToken":"opaque","apiKey":"opaque","secretValue":"opaque","usedPercent":42}}`)
	got, err := redactLimitPayload(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"accountId", "email", "person@example.test", "accessToken", "apiKey", "secretValue", "opaque"} {
		if strings.Contains(string(got), forbidden) {
			t.Fatalf("capture retained sensitive field %q: %s", forbidden, got)
		}
	}
	if !strings.Contains(string(got), `"usedPercent":42`) {
		t.Fatalf("capture discarded non-sensitive response fields: %s", got)
	}
}

func TestLimitsCaptureKeepsCodexStructuredSourceAndRecordedClaude(t *testing.T) {
	codex := filepath.Join(t.TempDir(), "codex-app-server")
	codexScript := "#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in *'\"id\":1'*) printf '%s\\n' '{\"id\":1,\"result\":{}}';; *'\"id\":2'*) printf '%s\\n' '{\"id\":2,\"result\":" + realCodexRateLimitsFixture + "}'; exit 0;; esac; done\n"
	if err := os.WriteFile(codex, []byte(codexScript), 0o700); err != nil {
		t.Fatal(err)
	}
	captureDir, state := t.TempDir(), t.TempDir()
	store := newClaudeReadingStore(state, time.Now, time.Local)
	if err := store.Record(47, "1h 43m", 56, "Tue 00:00"); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	factory := func(vendor string) (limitsProvider, error) {
		if vendor != "codex" {
			return nil, fmt.Errorf("unexpected automatic provider %q", vendor)
		}
		return commandAdapter{vendor: vendor, binary: codex}, nil
	}
	code, err := limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state, "--capture", captureDir, "--json"}, &stdout, &stderr, factory)
	if err != nil || code != 0 {
		t.Fatalf("limits --capture: exit=%d err=%v stdout=%s stderr=%s", code, err, stdout.String(), stderr.String())
	}
	var limits []VendorLimit
	if err := json.Unmarshal([]byte(stdout.String()), &limits); err != nil {
		t.Fatal(err)
	}
	byVendor := map[string][]VendorLimit{}
	for _, limit := range limits {
		byVendor[limit.Vendor] = append(byVendor[limit.Vendor], limit)
	}
	if len(byVendor["codex"]) != 2 || byVendor["codex"][0].Source != "app-server" || len(byVendor["claude"]) != 2 || byVendor["claude"][0].Source != "recorded" || len(byVendor["gemini"]) != 0 {
		t.Fatalf("limits vendors or sources=%+v", byVendor)
	}
	path := limitCapturePath(captureDir, "codex", "app-server")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing Codex app-server capture: %v", err)
	}
	if strings.Contains(string(data), "private-account") || strings.Contains(string(data), "accountId") {
		t.Fatalf("Codex capture leaked account data: %s", data)
	}
}
