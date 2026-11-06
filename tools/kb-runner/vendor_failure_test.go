//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

// writeZcodeFake writes a fake ZCode CLI whose runs are driven by a call
// schedule. Each invocation appends to <dir>/calls and records the --resume
// session id and --prompt value it received under <dir>.
//
// The ZCode adapter refuses to start where macOS cannot apply its sandbox-exec
// policy (nested-confinement environments); those tests need a host session
// that can apply the profile.
func writeZcodeFake(t *testing.T, dir, schedule string) string {
	t.Helper()
	fake := filepath.Join(dir, "zcode")
	script := `#!/bin/sh
dir=$(dirname "$0")
count=$(cat "$dir/calls")
count=$((count+1))
printf '%s' "$count" > "$dir/calls"
resume=""
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--resume" ]; then resume="$arg"; fi
  if [ "$prev" = "--prompt" ]; then prompt="$arg"; fi
  prev="$arg"
done
printf '%s' "$resume" > "$dir/resume-$count"
printf '%s' "$prompt" > "$dir/prompt-$count"
` + schedule + `
exit 99
`
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "calls"), []byte("0"), 0o600); err != nil {
		t.Fatal(err)
	}
	return fake
}

// S-237.61
func TestZcodeTransientFailuresResumeSameSessionUntilSuccess(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ZCode retry flow requires the macOS sandbox-exec boundary")
	}
	dir := t.TempDir()
	schedule := `case "$count" in
  1) printf '%s\n' '{"type":"session.created","sessionId":"zcode-transient-session"}' '{"type":"turn.failed","sessionId":"zcode-transient-session","payload":{"error":{"message":"model concurrency limit exceeded","attribution":{"providerErrorCode":"3009","statusCode":429,"source":"provider","exceptionKind":"provider_business","retryable":false}}}}'
     exit 1 ;;
  2) printf '%s\n' '{"type":"turn.failed","sessionId":"zcode-transient-session","payload":{"error":{"message":"Network connection failed for the provider request.","attribution":{"source":"network","exceptionKind":"transport","errorPhase":"connect","retryable":true}}}}'
     exit 1 ;;
  3) printf '%s\n' '{"type":"session.resumed","sessionId":"zcode-transient-session"}' '{"type":"result","sessionId":"zcode-transient-session","response":"recovered and finished","usage":{"inputTokens":11,"outputTokens":5}}'
     exit 0 ;;
esac
`
	// The fake runs under the ZCode sandbox profile, which only allows writes
	// inside the agent worktree, so the fake and its recording files live in
	// the workdir the job passes to the sandbox.
	state := filepath.Join(dir, "state")
	work := filepath.Join(dir, "work")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	fake := writeZcodeFake(t, work, schedule)
	t.Setenv("ZCODE_BIN", fake)
	prompt := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(prompt, []byte("do the long task"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newJobStore(state).Create(Job{ID: "zcode-transient", Stream: "transient", Vendor: "zcode", State: JobQueued, Phase: PhaseWorktree}); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"--job-id", "zcode-transient", "--state", state, "--stream", "transient",
		"--vendor", "zcode", "--workdir", work, "--prompt-file", prompt,
	}, &out, &errOut)
	if err != nil || code != 0 {
		t.Fatalf("transient recovery start = %d, %v; stdout=%s stderr=%s", code, err, out.String(), errOut.String())
	}
	calls, err := os.ReadFile(filepath.Join(work, "calls"))
	if err != nil || string(calls) != "3" {
		t.Fatalf("vendor invocations = %q, %v; want 3", calls, err)
	}
	job, err := newJobStore(state).Get("zcode-transient")
	if err != nil || job.State != JobOK {
		t.Fatalf("recovered job = %+v, %v", job, err)
	}
	if job.SessionID != "zcode-transient-session" {
		t.Fatalf("job session = %q", job.SessionID)
	}
	if job.Tokens != 16 {
		t.Fatalf("job tokens = %d; want the final result usage 16", job.Tokens)
	}
	if len(job.Attempts) != 3 {
		t.Fatalf("attempts = %+v; want one per provider run", job.Attempts)
	}
	for index, want := range []struct {
		outcome string
		usage   string
	}{
		{"paused", attemptUsageUnknown},
		{"paused", attemptUsageUnknown},
		{"ok", attemptUsageRecorded},
	} {
		attempt := job.Attempts[index]
		if attempt.Outcome != want.outcome || attempt.Usage != want.usage {
			t.Fatalf("attempt %d = %+v; want outcome %q usage %q", index+1, attempt, want.outcome, want.usage)
		}
	}
	for _, run := range []string{"2", "3"} {
		session, err := os.ReadFile(filepath.Join(work, "resume-"+run))
		if err != nil || string(session) != "zcode-transient-session" {
			t.Fatalf("resume %s session = %q, %v; want the failed run's session id", run, session, err)
		}
		continued, err := os.ReadFile(filepath.Join(work, "prompt-"+run))
		if err != nil || !strings.Contains(string(continued), providerContinuationPrompt) {
			t.Fatalf("resume %s prompt = %q, %v; want the fixed continuation prompt", run, continued, err)
		}
		if strings.Contains(string(continued), "do the long task") {
			t.Fatalf("resume %s resent the original task prompt: %q", run, continued)
		}
	}
	original, err := os.ReadFile(filepath.Join(work, "prompt-1"))
	if err != nil || string(original) != "do the long task" {
		t.Fatalf("initial prompt = %q, %v", original, err)
	}
}

// S-237.62
func TestZcodePermanentFailureEndsJobWithoutRetry(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("ZCode retry flow requires the macOS sandbox-exec boundary")
	}
	dir := t.TempDir()
	schedule := `printf '%s\n' '{"type":"session.created","sessionId":"zcode-permanent-session"}' '{"type":"turn.failed","sessionId":"zcode-permanent-session","payload":{"error":{"message":"provider authentication failed","attribution":{"providerErrorCode":"3007","statusCode":403,"source":"provider","exceptionKind":"provider_business","retryable":false}}}}'
exit 1
`
	state := filepath.Join(dir, "state")
	work := filepath.Join(dir, "work")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	fake := writeZcodeFake(t, work, schedule)
	t.Setenv("ZCODE_BIN", fake)
	prompt := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(prompt, []byte("do the task"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newJobStore(state).Create(Job{ID: "zcode-permanent", Stream: "permanent", Vendor: "zcode", State: JobQueued, Phase: PhaseWorktree}); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"--job-id", "zcode-permanent", "--state", state, "--stream", "permanent",
		"--vendor", "zcode", "--workdir", work, "--prompt-file", prompt,
	}, &out, &errOut)
	if code != 1 || err == nil {
		t.Fatalf("permanent failure = code %d, err %v; want a failed job", code, err)
	}
	calls, err := os.ReadFile(filepath.Join(work, "calls"))
	if err != nil || string(calls) != "1" {
		t.Fatalf("vendor invocations = %q, %v; want exactly 1 without a resume", calls, err)
	}
	job, err := newJobStore(state).Get("zcode-permanent")
	if err != nil || job.Final == nil {
		t.Fatalf("terminal job = %+v, %v", job, err)
	}
	if job.Final.State != JobFailed || job.Final.Reason != ReasonAuthExpired {
		t.Fatalf("terminal record = %+v; want failed with auth_expired", job.Final)
	}
	if !strings.Contains(job.Final.Next, "status") {
		t.Fatalf("terminal next command = %q", job.Final.Next)
	}
	if len(job.Attempts) != 1 || job.Attempts[0].Outcome != "failed" || job.Attempts[0].Reason != ReasonAuthExpired {
		t.Fatalf("attempts = %+v; want one closed failed attempt", job.Attempts)
	}
}

// S-237.63
func TestLimitsShowUnknownUsageForFailedAttempts(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	if _, err := store.Create(Job{
		ID: "zcode-unknown-usage", Stream: "spend", Vendor: "zcode", State: JobOK, Phase: PhaseRun, Tokens: 20,
		Attempts: []ProviderAttempt{
			{Number: 1, Outcome: "paused", Usage: attemptUsageUnknown},
			{Number: 2, Outcome: "ok", Usage: attemptUsageRecorded},
		},
	}); err != nil {
		t.Fatal(err)
	}
	limit, err := vendorSpendLimit("zcode", state, mustListJobs(t, store))
	if err != nil {
		t.Fatal(err)
	}
	if limit.Spend == nil || limit.Spend.UnknownAttempts != 1 {
		t.Fatalf("spend = %+v; want one unknown-usage attempt", limit.Spend)
	}
	display := formatVendorSpend("zcode", *limit.Spend)
	if !strings.Contains(display, "usage unknown for 1 attempt") {
		t.Fatalf("spend display %q does not mark the unknown attempt", display)
	}
	var out, errOut strings.Builder
	code, err := limitsCommandWithProviderFactory(runnerRoot{invocation: "kb-runner"}, []string{"--state", state}, &out, &errOut, func(string) (limitsProvider, error) {
		return fakeLimitProvider{}, nil
	})
	if code != 0 || err != nil {
		t.Fatalf("limits command = %d, %v; output=%s", code, err, out.String())
	}
	if !strings.Contains(out.String(), "usage unknown for 1 attempt") {
		t.Fatalf("limits output does not show unknown usage: %s", out.String())
	}
}

// S-237.61, S-237.62
func TestVendorFailureTablesClassifyEveryRegisteredVendor(t *testing.T) {
	for _, vendor := range vendors() {
		table := vendorRegistry[vendor].failures
		if table.classify(VendorEvent{Kind: EventVendorError}) == unrelatedFailure {
			t.Fatalf("vendor %q table cannot classify a bare provider failure", vendor)
		}
		if table.classify(VendorEvent{Kind: EventActivity}) != unrelatedFailure {
			t.Fatalf("vendor %q table classifies activity as a failure", vendor)
		}
	}
	zcode := vendorRegistry["zcode"].failures
	for _, tc := range []struct {
		name  string
		event VendorEvent
		want  vendorFailure
	}{
		{"concurrency code", VendorEvent{Kind: EventVendorError, ProviderCode: "3009"}, transientRateLimitFailure},
		{"retryable rate code", VendorEvent{Kind: EventVendorError, ProviderCode: "1302"}, transientRateLimitFailure},
		{"server status", VendorEvent{Kind: EventVendorError, StatusCode: 502}, transientUnreachableFailure},
		{"network attribution", VendorEvent{Kind: EventVendorError, FailureSource: "network"}, transientUnreachableFailure},
		{"auth code", VendorEvent{Kind: EventVendorError, ProviderCode: "3007"}, permanentAuthFailure},
		{"quota exhaustion code", VendorEvent{Kind: EventVendorError, ProviderCode: "2056"}, permanentVendorFailure},
		{"invalid request status", VendorEvent{Kind: EventVendorError, StatusCode: 400}, permanentVendorFailure},
		{"unclassified failure", VendorEvent{Kind: EventVendorError, Message: "provider failed"}, opaqueVendorFailure},
		{"final event", VendorEvent{Kind: EventFinal}, unrelatedFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := zcode.classify(tc.event); got != tc.want {
				t.Fatalf("classify = %+v; want %+v", got, tc.want)
			}
		})
	}
	text := vendorRegistry["codex"].failures
	for _, tc := range []struct {
		name  string
		event VendorEvent
		want  vendorFailure
	}{
		{"rate limited", VendorEvent{Kind: EventRateLimited}, transientRateLimitFailure},
		{"auth expired", VendorEvent{Kind: EventAuthExpired}, permanentAuthFailure},
		{"sustained outage", VendorEvent{Kind: EventProviderUnreachable}, transientUnreachableFailure},
		{"network text", VendorEvent{Kind: EventVendorError, Message: "request timed out"}, transientUnreachableFailure},
		{"unknown text", VendorEvent{Kind: EventVendorError, Message: "provider failed"}, opaqueVendorFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := text.classify(tc.event); got != tc.want {
				t.Fatalf("classify = %+v; want %+v", got, tc.want)
			}
		})
	}
	if failure, ok := vendorRegistry["zcode"].failures.classifyStderr("Error: provider code 3009 exceeded"); !ok || failure != transientRateLimitFailure {
		t.Fatalf("zcode stderr classification = %+v, %v; want the structured provider code", failure, ok)
	}
	if failure, ok := vendorRegistry["codex"].failures.classifyStderr("provider exited: rate limit exceeded"); !ok || failure.class != transientRateLimitFailure.class || failure.reason != transientRateLimitFailure.reason {
		t.Fatalf("codex stderr classification = %+v, %v; want the rate-limit phrase", failure, ok)
	}
}

// case: S-237.61
func TestCodexUsageLimitMessageCarriesLocalResetTime(t *testing.T) {
	utc := time.UTC
	msk := time.FixedZone("MSK", 3*60*60)
	nepal := time.FixedZone("NPT", 5*60*60+45*60)
	for _, tc := range []struct {
		name     string
		location *time.Location
		now      time.Time
		message  string
		want     time.Time
	}{
		{
			name:     "same day",
			location: msk,
			now:      time.Date(2026, time.October, 27, 10, 38, 0, 0, msk),
			message:  "You've hit your usage limit … try again at 11:01 AM",
			want:     time.Date(2026, time.October, 27, 11, 1, 0, 0, msk),
		},
		{
			name:     "rollover past midnight",
			location: utc,
			now:      time.Date(2026, time.October, 27, 23, 50, 0, 0, utc),
			message:  "You've hit your usage limit … try again at 12:05 AM",
			want:     time.Date(2026, time.October, 28, 0, 5, 0, 0, utc),
		},
		{
			name:     "non-UTC local zone",
			location: nepal,
			now:      time.Date(2026, time.October, 27, 10, 30, 0, 0, nepal),
			message:  "You've hit your usage limit … try again at 11:01 AM",
			want:     time.Date(2026, time.October, 27, 11, 1, 0, 0, nepal),
		},
		{
			name:     "equal time rolls to tomorrow",
			location: time.FixedZone("EDT", -4*60*60),
			now:      time.Date(2026, time.October, 27, 11, 1, 0, 0, time.FixedZone("EDT", -4*60*60)),
			message:  "You've hit your usage limit … try again at 11:01 AM",
			want:     time.Date(2026, time.October, 28, 11, 1, 0, 0, time.FixedZone("EDT", -4*60*60)),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure := vendorRegistry["codex"].failures.classifyAt(
				VendorEvent{Kind: EventRateLimited, Message: tc.message}, tc.now, tc.location,
			)
			if failure.class != failureTransient || failure.reason != ReasonRateLimited || failure.resetAt == nil || !failure.resetAt.Equal(tc.want) {
				t.Fatalf("Codex usage-limit failure = %+v; want rate-limited with reset %s", failure, tc.want)
			}
		})
	}
}

// case: S-237.61
func TestRecordedCodexLimitProducesOneNamedEventAndBlocksLaterJobs(t *testing.T) {
	location := time.FixedZone("MSK", 3*60*60)
	now := time.Date(2026, time.October, 27, 10, 38, 0, 0, location)
	reset := time.Date(2026, time.October, 27, 11, 1, 0, 0, location)
	clock := func() time.Time { return now }
	state := t.TempDir()
	limits := newVendorLimitStateStore(state, clock)
	changed, err := limits.Record("codex", reset, "You've hit your usage limit … try again at 11:01 AM")
	if err != nil || !changed {
		t.Fatalf("record Codex limit = changed %t, err %v", changed, err)
	}
	changed, err = limits.Record("codex", reset, "duplicate Codex usage-limit failure")
	if err != nil || changed {
		t.Fatalf("duplicate Codex limit = changed %t, err %v; want one named transition", changed, err)
	}
	events, err := os.ReadFile(limits.eventsPath())
	if err != nil {
		t.Fatal(err)
	}
	var event vendorLimitEvent
	if err := proc.ReadJSONL(bytes.NewReader(events), func(line []byte) error {
		return json.Unmarshal(line, &event)
	}); err != nil {
		t.Fatal(err)
	}
	if event.Kind != "vendor_limit.recorded" || event.Vendor != "codex" || !event.ResetAt.Equal(reset) {
		t.Fatalf("limit event = %+v; want one named Codex event with reset %s", event, reset)
	}
	if bytes.Count(events, []byte("vendor_limit.recorded")) != 1 {
		t.Fatalf("limit event log = %q; want exactly one recorded event", events)
	}
	merged, err := limitsWithRecordedVendorState(nil, limits, "codex")
	blockedReset := nextBlockedReset(merged, 95, 98)
	if err != nil || !quotaBlocked(merged, 95, 98) || blockedReset == nil || !blockedReset.Equal(reset) {
		t.Fatalf("later-job Codex limits = %+v, err=%v; want blocked through %s", merged, err, reset)
	}
	now = reset.Add(time.Second)
	merged, err = limitsWithRecordedVendorState(nil, limits, "codex")
	if err != nil || quotaBlocked(merged, 95, 98) {
		t.Fatalf("expired Codex limit = %+v, err=%v; want admission unblocked", merged, err)
	}
}

type controlledQuotaAdmissionClock struct {
	mu      sync.Mutex
	now     time.Time
	waiting chan time.Time
	wake    chan struct{}
}

func (c *controlledQuotaAdmissionClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *controlledQuotaAdmissionClock) WaitUntil(ctx context.Context, deadline time.Time) error {
	select {
	case c.waiting <- deadline:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-c.wake:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *controlledQuotaAdmissionClock) Tick() {
	c.wake <- struct{}{}
}

func (c *controlledQuotaAdmissionClock) Advance(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
	c.wake <- struct{}{}
}

type observedQuotaLimitProvider struct {
	calls  atomic.Int32
	called chan struct{}
	limits []VendorLimit
}

func (p *observedQuotaLimitProvider) Limits(context.Context) ([]VendorLimit, error) {
	p.calls.Add(1)
	p.called <- struct{}{}
	return p.limits, nil
}

// case: S-237.61
func TestQuotaAdmissionWaitsForRecordedCodexResetBeforeProbing(t *testing.T) {
	state := t.TempDir()
	jobs := newJobStore(state)
	job, err := jobs.Create(Job{ID: "later-codex", Stream: "later", Vendor: "codex", State: JobQueued, Phase: PhaseAdmission})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, time.October, 27, 10, 38, 0, 0, time.UTC)
	reset := start.Add(time.Hour)
	clock := &controlledQuotaAdmissionClock{
		now: start, waiting: make(chan time.Time, 2), wake: make(chan struct{}, 2),
	}
	if _, err := newVendorLimitStateStore(state, clock.Now).Record("codex", reset, "usage limited"); err != nil {
		t.Fatal(err)
	}
	provider := &observedQuotaLimitProvider{
		called: make(chan struct{}, 1),
		limits: []VendorLimit{{Vendor: "codex", Window: "5h", UsedPercent: 44, Confidence: "vendor"}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- waitForQuotaAdmission(ctx, nil, provider, jobs, job.ID, 95, 98, clock)
	}()

	select {
	case deadline := <-clock.waiting:
		if !deadline.Equal(reset) {
			t.Fatalf("admission wait deadline = %s, want recorded reset %s", deadline, reset)
		}
	case err := <-result:
		t.Fatalf("admission returned before waiting through the recorded reset: %v", err)
	}
	assertQuotaAdmissionPending(t, result, provider, jobs, job.ID)

	clock.Tick()
	select {
	case <-clock.waiting:
	case err := <-result:
		t.Fatalf("admission returned after a wake before the reset: %v", err)
	}
	assertQuotaAdmissionPending(t, result, provider, jobs, job.ID)

	clock.Advance(reset.Add(time.Nanosecond))
	select {
	case <-provider.called:
	case err := <-result:
		t.Fatalf("admission returned without rechecking provider limits after reset: %v", err)
	}
	if got := provider.calls.Load(); got != 1 {
		t.Fatalf("provider probes after reset = %d, want exactly one", got)
	}
	if err := <-result; err != nil {
		t.Fatalf("admission after reset: %v", err)
	}
	got, err := jobs.Get(job.ID)
	if err != nil || got.State != JobRunning || got.Reason != ReasonNone {
		t.Fatalf("admitted Codex job = %+v, err=%v; want running after post-reset probe", got, err)
	}
}

func assertQuotaAdmissionPending(t *testing.T, result <-chan error, provider *observedQuotaLimitProvider, jobs *jobStore, id string) {
	t.Helper()
	select {
	case err := <-result:
		t.Fatalf("quota admission returned before reset: %v", err)
	default:
	}
	if got := provider.calls.Load(); got != 0 {
		t.Fatalf("provider probes before reset = %d, want zero", got)
	}
	job, err := jobs.Get(id)
	if err != nil || job.State != JobQuotaWait || job.Reason != ReasonQuota {
		t.Fatalf("later Codex job = %+v, err=%v; want persisted quota-wait", job, err)
	}
}

func mustListJobs(t *testing.T, store *jobStore) []Job {
	t.Helper()
	jobs, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	return jobs
}

func TestProviderRecoveryWaitsOnlyWhereVendorLimitsExist(t *testing.T) {
	// Ledger vendors have no vendor-confidence limits source; the wait must
	// complete on backoff alone instead of failing its probes.
	if err := waitForProviderRecovery(context.Background(), commandAdapter{vendor: "zcode"}, "zcode", ReasonProviderUnreachable, 1, 95, 98, nil); err != nil {
		t.Fatalf("zcode recovery wait: %v", err)
	}
}

// writeClaudeFake writes a fake Claude CLI (the vendor adapter without the
// macOS sandbox boundary, sharing the resume flow and the unknown-usage-on-
// failure accounting with zcode) recording its --resume and -p arguments.
func writeClaudeFake(t *testing.T, dir, schedule string) string {
	t.Helper()
	fake := filepath.Join(dir, "claude")
	script := `#!/bin/sh
dir=$(dirname "$0")
count=$(cat "$dir/calls")
count=$((count+1))
printf '%s' "$count" > "$dir/calls"
resume=""
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--resume" ]; then resume="$arg"; fi
  if [ "$prev" = "-p" ]; then prompt="$arg"; fi
  prev="$arg"
done
printf '%s' "$resume" > "$dir/resume-$count"
printf '%s' "$prompt" > "$dir/prompt-$count"
` + schedule + `
exit 99
`
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "calls"), []byte("0"), 0o600); err != nil {
		t.Fatal(err)
	}
	return fake
}

// S-237.61 — the resume flow runs here against the claude adapter, which
// shares the zcode flow: unknown usage on failure and a non-probing recovery
// wait. The zcode-specific structured fields are claimed at parser and
// classification level; the zcode flow fixture is rerun on a host that can
// apply its sandbox profile.
func TestClaudeTransientFailuresResumeSameSessionUntilSuccess(t *testing.T) {
	dir := t.TempDir()
	schedule := `case "$count" in
  1) printf '%s\n' '{"type":"system","session_id":"claude-transient-session"}' '{"type":"error","message":"model concurrency limit exceeded (rate limit)"}'
     exit 1 ;;
  2) printf '%s\n' '{"type":"error","message":"request timed out while contacting the provider"}'
     exit 1 ;;
  3) printf '%s\n' '{"type":"system","session_id":"claude-transient-session"}' '{"type":"result","result":"recovered and finished","usage":{"input_tokens":9,"output_tokens":4}}'
     exit 0 ;;
esac
`
	fake := writeClaudeFake(t, dir, schedule)
	t.Setenv("CLAUDE_BIN", fake)
	state := filepath.Join(dir, "state")
	work := filepath.Join(dir, "work")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(prompt, []byte("do the long task"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newJobStore(state).Create(Job{ID: "claude-transient", Stream: "transient", Vendor: "claude", State: JobQueued, Phase: PhaseWorktree}); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"--job-id", "claude-transient", "--state", state, "--stream", "transient",
		"--vendor", "claude", "--workdir", work, "--prompt-file", prompt,
	}, &out, &errOut)
	if err != nil || code != 0 {
		t.Fatalf("transient recovery start = %d, %v; stdout=%s stderr=%s", code, err, out.String(), errOut.String())
	}
	calls, err := os.ReadFile(filepath.Join(dir, "calls"))
	if err != nil || string(calls) != "3" {
		t.Fatalf("vendor invocations = %q, %v; want 3", calls, err)
	}
	job, err := newJobStore(state).Get("claude-transient")
	if err != nil || job.State != JobOK || job.SessionID != "claude-transient-session" {
		t.Fatalf("recovered job = %+v, %v", job, err)
	}
	for index, want := range []struct {
		outcome string
		usage   string
	}{
		{"paused", attemptUsageUnknown},
		{"paused", attemptUsageUnknown},
		{"ok", attemptUsageRecorded},
	} {
		attempt := job.Attempts[index]
		if attempt.Outcome != want.outcome || attempt.Usage != want.usage {
			t.Fatalf("attempt %d = %+v; want outcome %q usage %q", index+1, attempt, want.outcome, want.usage)
		}
	}
	for _, run := range []string{"2", "3"} {
		session, err := os.ReadFile(filepath.Join(dir, "resume-"+run))
		if err != nil || string(session) != "claude-transient-session" {
			t.Fatalf("resume %s session = %q, %v; want the failed run's session id", run, session, err)
		}
		continued, err := os.ReadFile(filepath.Join(dir, "prompt-"+run))
		if err != nil || !strings.Contains(string(continued), providerContinuationPrompt) {
			t.Fatalf("resume %s prompt = %q, %v; want the fixed continuation prompt", run, continued, err)
		}
		if strings.Contains(string(continued), "do the long task") {
			t.Fatalf("resume %s resent the original task prompt: %q", run, continued)
		}
	}
	original, err := os.ReadFile(filepath.Join(dir, "prompt-1"))
	if err != nil || string(original) != "do the long task" {
		t.Fatalf("initial prompt = %q, %v", original, err)
	}
}

// S-237.62
func TestClaudePermanentFailureEndsJobWithoutRetry(t *testing.T) {
	dir := t.TempDir()
	schedule := `printf '%s\n' '{"type":"system","session_id":"claude-permanent-session"}' '{"type":"error","message":"authentication failed: invalid api key"}'
exit 1
`
	fake := writeClaudeFake(t, dir, schedule)
	t.Setenv("CLAUDE_BIN", fake)
	state := filepath.Join(dir, "state")
	work := filepath.Join(dir, "work")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(prompt, []byte("do the task"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newJobStore(state).Create(Job{ID: "claude-permanent", Stream: "permanent", Vendor: "claude", State: JobQueued, Phase: PhaseWorktree}); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"--job-id", "claude-permanent", "--state", state, "--stream", "permanent",
		"--vendor", "claude", "--workdir", work, "--prompt-file", prompt,
	}, &out, &errOut)
	if code != 1 || err == nil {
		t.Fatalf("permanent failure = code %d, err %v; want a failed job", code, err)
	}
	calls, err := os.ReadFile(filepath.Join(dir, "calls"))
	if err != nil || string(calls) != "1" {
		t.Fatalf("vendor invocations = %q, %v; want exactly 1 without a resume", calls, err)
	}
	job, err := newJobStore(state).Get("claude-permanent")
	if err != nil || job.Final == nil {
		t.Fatalf("terminal job = %+v, %v", job, err)
	}
	if job.Final.State != JobFailed || job.Final.Reason != ReasonAuthExpired {
		t.Fatalf("terminal record = %+v; want failed with auth_expired", job.Final)
	}
	if len(job.Attempts) != 1 || job.Attempts[0].Outcome != "failed" || job.Attempts[0].Usage != attemptUsageUnknown {
		t.Fatalf("attempts = %+v; want one closed failed attempt with unknown usage", job.Attempts)
	}
}
