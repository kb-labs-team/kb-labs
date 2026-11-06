//go:build darwin || linux

package main

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaudeRecordedReadingRoundTrip(t *testing.T) {
	location := fixedLocation(t)
	now := time.Date(2026, time.October, 22, 10, 0, 0, 0, location)
	store := newClaudeReadingStore(t.TempDir(), func() time.Time { return now }, location)
	if err := store.Record(47, "1h 43m", 56, "Tue 00:00"); err != nil {
		t.Fatal(err)
	}

	limits, pace, err := store.Limits()
	if err != nil {
		t.Fatal(err)
	}
	if len(limits) != 2 {
		t.Fatalf("got %d readings: %+v", len(limits), limits)
	}
	if limits[0].Window != "session" || limits[0].UsedPercent != 47 || limits[0].Source != "recorded" || limits[0].Confidence != "recorded" {
		t.Fatalf("unexpected session reading: %+v", limits[0])
	}
	if limits[0].ResetsAt == nil || !limits[0].ResetsAt.Equal(now.UTC().Add(103*time.Minute)) {
		t.Fatalf("relative reset wasn't normalized to UTC: %+v", limits[0])
	}
	weeklyReset := time.Date(2026, time.October, 27, 0, 0, 0, 0, location).UTC()
	if limits[1].Window != "week" || limits[1].UsedPercent != 56 || limits[1].Source != "recorded" || limits[1].Confidence != "recorded" || limits[1].ResetsAt == nil || !limits[1].ResetsAt.Equal(weeklyReset) {
		t.Fatalf("unexpected weekly reading: %+v", limits[1])
	}
	for _, limit := range limits {
		if limit.RecordedAt == nil || !limit.RecordedAt.Equal(now.UTC()) || limit.Age == "" || limit.Stale {
			t.Fatalf("reading metadata wasn't populated: %+v", limit)
		}
	}
	if pace.Verdict == "" || pace.RemainingPercent != 44 || pace.HoursLeft <= 0 {
		t.Fatalf("weekly pacing wasn't returned: %+v", pace)
	}

	data, err := os.ReadFile(filepath.Join(store.dir, "claude.recorded.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted struct {
		RecordedAt      time.Time `json:"recordedAt"`
		SessionPercent  float64   `json:"sessionPercent"`
		WeeklyPercent   float64   `json:"weeklyPercent"`
		SessionResetsAt time.Time `json:"sessionResetsAt"`
		WeeklyResetsAt  time.Time `json:"weeklyResetsAt"`
	}
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if !persisted.RecordedAt.Equal(now.UTC()) || persisted.SessionPercent != 47 || persisted.WeeklyPercent != 56 || !persisted.SessionResetsAt.Equal(limits[0].ResetsAt.UTC()) || !persisted.WeeklyResetsAt.Equal(weeklyReset) {
		t.Fatalf("persisted reading=%+v", persisted)
	}
}

func TestClaudeResetParsingUsesProvidedLocationAndClock(t *testing.T) {
	location := fixedLocation(t)
	now := time.Date(2026, time.October, 22, 10, 0, 0, 0, location)
	tests := []struct {
		name string
		mode claudeResetMode
		text string
		want time.Time
	}{
		{name: "relative duration", mode: claudeResetRelativeOrAbsolute, text: "1 hr 43 min", want: now.Add(103 * time.Minute)},
		{name: "absolute local time", mode: claudeResetRelativeOrAbsolute, text: "2026-10-24 12:30", want: time.Date(2026, 10, 24, 12, 30, 0, 0, location)},
		{name: "weekday local time", mode: claudeResetWeekdayOrAbsolute, text: "Tue 00:00", want: time.Date(2026, 10, 27, 0, 0, 0, 0, location)},
		{name: "weekday twelve-hour local time", mode: claudeResetWeekdayOrAbsolute, text: "Tue 12:00 AM", want: time.Date(2026, 10, 27, 0, 0, 0, 0, location)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseClaudeReset(test.text, test.mode, now, location)
			if err != nil {
				t.Fatal(err)
			}
			if !got.Equal(test.want.UTC()) || got.Location() != time.UTC {
				t.Fatalf("reset=%s want=%s", got, test.want.UTC())
			}
		})
	}
}

func TestClaudeRecordedReadingBecomesStaleAfterReset(t *testing.T) {
	location := fixedLocation(t)
	now := time.Date(2026, time.October, 22, 10, 0, 0, 0, location)
	current := now
	store := newClaudeReadingStore(t.TempDir(), func() time.Time { return current }, location)
	if err := store.Record(47, "1h", 56, "Tue 00:00"); err != nil {
		t.Fatal(err)
	}
	current = now.Add(2 * time.Hour)
	limits, _, err := store.Limits()
	if err != nil {
		t.Fatal(err)
	}
	if len(limits) != 2 || !limits[0].Stale || limits[0].UsedPercent != 47 || limits[0].Confidence != "recorded" || limits[0].Age == "" {
		t.Fatalf("expired session was silently reset or lost: %+v", limits)
	}
	if limits[1].Stale || limits[1].UsedPercent != 56 {
		t.Fatalf("unexpired weekly reading became stale: %+v", limits[1])
	}
	current = time.Date(2026, time.October, 27, 0, 0, 0, 0, location)
	limits, pace, err := store.Limits()
	if err != nil || !limits[1].Stale || limits[1].UsedPercent != 56 || pace.Verdict != "stale" || limits[1].Pace == nil || limits[1].Pace.Verdict != "stale" {
		t.Fatalf("expired weekly reading wasn't explicitly stale: limits=%+v pace=%+v err=%v", limits, pace, err)
	}
}

func TestClaudePacingArithmetic(t *testing.T) {
	location := fixedLocation(t)
	now := time.Date(2026, time.October, 22, 0, 0, 0, 0, location)
	reset := time.Date(2026, time.October, 27, 0, 0, 0, 0, location).UTC()
	limit := VendorLimit{Vendor: "claude", Window: "week", UsedPercent: 56, ResetsAt: &reset, Confidence: "recorded", Source: "recorded"}
	pace := claudeWeeklyPace(limit, now)
	if pace.RemainingPercent != 44 || pace.HoursLeft != 120 || math.Abs(pace.RemainingPerDay-8.8) > 0.000001 || pace.Verdict != "over" {
		t.Fatalf("pace=%+v; want 44%% / 120h = 8.8%% per day and over pace", pace)
	}
	if got := formatClaudePace(pace); !strings.Contains(got, "44% remaining / 120h → 8.8%/day") || !strings.HasSuffix(got, "over") {
		t.Fatalf("pacing line=%q", got)
	}
	for _, test := range []struct {
		name    string
		used    float64
		verdict string
	}{
		{name: "under", used: 10, verdict: "under"},
		{name: "on", used: 100 - (120.0 / 168.0 * 100), verdict: "on"},
	} {
		t.Run(test.name, func(t *testing.T) {
			limit.UsedPercent = test.used
			if got := claudeWeeklyPace(limit, now).Verdict; got != test.verdict {
				t.Fatalf("verdict=%s want=%s", got, test.verdict)
			}
		})
	}
}

func TestLimitsExcludeGeminiAndHaveNoCredentialStorePath(t *testing.T) {
	for _, vendor := range vendors() {
		if vendor == "gemini" {
			t.Fatal("Gemini still has a quota source")
		}
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".claude")); !os.IsNotExist(err) {
		t.Fatalf("test HOME unexpectedly has Claude credentials: %v", err)
	}
	state := t.TempDir()
	location := fixedLocation(t)
	now := time.Date(2026, time.October, 22, 10, 0, 0, 0, location)
	store := newClaudeReadingStore(state, func() time.Time { return now }, location)
	if err := store.Record(47, "1h", 56, "Tue 00:00"); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	code, err := limitsCommand(runnerRoot{invocation: "kb-runner"}, []string{"--state", state, "--json"}, &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("limits with isolated HOME: code=%d err=%v stdout=%s stderr=%s", code, err, stdout.String(), stderr.String())
	}
	var limits []VendorLimit
	if err := json.Unmarshal([]byte(stdout.String()), &limits); err != nil {
		t.Fatal(err)
	}
	var claudeCount int
	for _, limit := range limits {
		if limit.Vendor == "gemini" {
			t.Fatalf("limits emitted Gemini without a quota source: %+v", limits)
		}
		if limit.Vendor == "claude" {
			claudeCount++
			if limit.Source != "recorded" || limit.Confidence != "recorded" || limit.Age == "" || limit.RecordedAt == nil {
				t.Fatalf("Claude limits were not sourced from the owner record: %+v", limit)
			}
		}
	}
	if claudeCount != 2 {
		t.Fatalf("limits returned %d Claude windows: %+v", claudeCount, limits)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HOME"), ".claude")); !os.IsNotExist(err) {
		t.Fatalf("limits created or read the Claude credential directory: %v", err)
	}
}

func TestLimitsRecordSubcommandPersistsClaudeReading(t *testing.T) {
	state := t.TempDir()
	var stdout, stderr strings.Builder
	code, err := limitsCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"record", "claude", "--state", state,
		"--session", "47", "--session-resets", "1 hr 43 min",
		"--weekly", "56", "--weekly-resets", "Tue 00:00",
	}, &stdout, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("limits record claude: code=%d err=%v stdout=%s stderr=%s", code, err, stdout.String(), stderr.String())
	}
	store := newClaudeReadingStore(state, time.Now, time.Local)
	limits, _, err := store.Limits()
	if err != nil || len(limits) != 2 || limits[0].UsedPercent != 47 || limits[1].UsedPercent != 56 {
		t.Fatalf("recorded limits=%+v err=%v", limits, err)
	}
}

func TestLimitsRecordWriteFailureNamesInspectionCommand(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state-is-a-file")
	if err := os.WriteFile(state, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	code, err := limitsCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"record", "claude", "--state", state,
		"--session", "47", "--session-resets", "1 hr 43 min",
		"--weekly", "56", "--weekly-resets", "Tue 00:00",
	}, &stdout, &stderr)
	wantNext := "next: ls -ld " + shellQuote(state) + " " + shellQuote(filepath.Join(state, "limits"))
	if code != 1 || err == nil || !strings.Contains(err.Error(), wantNext) {
		t.Fatalf("write failure code=%d err=%v; wanted next command %q", code, err, wantNext)
	}
}

func TestLimitsPrintClaudePaceAndCodexWindowsOnly(t *testing.T) {
	state := t.TempDir()
	claudeStore := newClaudeReadingStore(state, time.Now, time.Local)
	if err := claudeStore.Record(47, "1 hr 43 min", 56, "Tue 00:00"); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	factory := func(vendor string) (limitsProvider, error) {
		if vendor != "codex" {
			t.Fatalf("unexpected provider request for %q", vendor)
		}
		return fakeLimitProvider{limits: []VendorLimit{
			{Vendor: "codex", Window: "5h", UsedPercent: 82, Confidence: "vendor", Source: "app-server"},
			{Vendor: "codex", Window: "week", UsedPercent: 24, Confidence: "vendor", Source: "app-server"},
		}}, nil
	}
	code, err := limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state}, &stdout, &stderr, factory)
	if err != nil || code != 0 {
		t.Fatalf("limits: code=%d err=%v stdout=%s stderr=%s", code, err, stdout.String(), stderr.String())
	}
	text := stdout.String()
	if !strings.Contains(text, "pace claude ") || !strings.Contains(text, "remaining") || !strings.Contains(text, "/day") || !strings.Contains(text, "codex") {
		t.Fatalf("limits omitted Claude pacing or Codex windows: %s", text)
	}
	if strings.Contains(text, "gemini") || strings.Count(text, "pace claude ") != 1 || strings.Contains(text, "pace codex") {
		t.Fatalf("limits output has unsupported or duplicate pacing: %s", text)
	}
}

func TestLimitsDoesNotFallBackToRemovedClaudeTTYCache(t *testing.T) {
	state := t.TempDir()
	limitDir := filepath.Join(state, "limits")
	if err := os.MkdirAll(limitDir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := []VendorLimit{{Vendor: "claude", Window: "week", UsedPercent: 12, Confidence: "vendor", Source: "tty", FetchedAt: time.Now().UTC()}}
	data, err := json.Marshal(struct {
		At     time.Time     `json:"at"`
		Limits []VendorLimit `json:"limits"`
	}{At: time.Now().UTC(), Limits: old})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(limitDir, "claude.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	factory := func(string) (limitsProvider, error) {
		return fakeLimitProvider{limits: []VendorLimit{{Vendor: "codex", Window: "week", Confidence: "vendor", Source: "app-server"}}}, nil
	}
	code, err := limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state, "--json"}, &stdout, &stderr, factory)
	if err != nil || code != 0 {
		t.Fatalf("limits: code=%d err=%v stdout=%s stderr=%s", code, err, stdout.String(), stderr.String())
	}
	var limits []VendorLimit
	if err := json.Unmarshal([]byte(stdout.String()), &limits); err != nil {
		t.Fatal(err)
	}
	foundUnavailable := false
	for _, limit := range limits {
		if limit.Vendor == "claude" && (limit.UsedPercent == 12 || limit.Source == "tty") {
			t.Fatalf("removed Claude TTY cache was used as a fallback: %+v", limit)
		}
		if limit.Vendor == "claude" && limit.Confidence == "unavailable" && strings.Contains(limit.Error, "limits record claude --help") {
			foundUnavailable = true
		}
	}
	if !foundUnavailable {
		t.Fatalf("missing Claude reading did not name the record command: %+v", limits)
	}
}

func fixedLocation(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	return location
}
