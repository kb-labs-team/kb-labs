//go:build darwin || linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func TestProviderTestsUseOnlyTemporaryHomeAndExplicitExecutables(t *testing.T) {
	home := os.Getenv("HOME")
	if home == "" || filepath.Clean(home) != testIsolatedHome {
		t.Fatalf("test HOME is not isolated: %q", home)
	}
	seenBinaries := map[string]bool{}
	for _, vendor := range vendors() {
		spec := vendorRegistry[vendor]
		if !spec.agent || seenBinaries[spec.binaryEnv] {
			continue
		}
		seenBinaries[spec.binaryEnv] = true
		name := spec.binaryEnv
		path := os.Getenv(name)
		if path == "" || !strings.HasPrefix(path, home+string(os.PathSeparator)) {
			t.Fatalf("%s is not an explicit fake under temporary HOME: %q", name, path)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("fake executable %s is unavailable: %v", name, err)
		}
	}
}

func TestClaudeAdapterFakeStartResumeAndInterrupt(t *testing.T) {
	work := t.TempDir()
	fake := filepath.Join(t.TempDir(), "claude")
	script := "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"session_started\",\"session_id\":\"claude-test-session\"}' '{\"type\":\"result\",\"result\":\"done\"}'\n"
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	adapter := commandAdapter{vendor: "claude", binary: fake}
	request := AgentRequest{Prompt: "safe test prompt", Workdir: work, StateDir: t.TempDir(), JobID: "adapter-start"}
	start, err := adapter.Start(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if start.Dir != work || !slices.Contains(start.Args, "--output-format") || !slices.Contains(start.Args, "stream-json") {
		t.Fatalf("Claude start command=%q dir=%q", start.Args, start.Dir)
	}
	output, err := start.Output()
	if err != nil || !strings.Contains(string(output), "claude-test-session") {
		t.Fatalf("Claude fake start: %v output=%s", err, output)
	}
	request.SessionID = "resume-session"
	resume, err := adapter.Resume(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(resume.Args, "--resume") || !slices.Contains(resume.Args, request.SessionID) {
		t.Fatalf("Claude resume command omitted session: %q", resume.Args)
	}
	if _, err := resume.Output(); err != nil {
		t.Fatalf("Claude fake resume: %v", err)
	}
	child := exec.Command("/bin/sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if child.Process != nil {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	})
	if err := adapter.Interrupt(child.Process); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err == nil {
		t.Fatal("interrupt left the fake Claude process running")
	}
}

func TestCodexAdapterArgumentsMatchRecordedExecHelp(t *testing.T) {
	workdir := filepath.Join(t.TempDir(), "work dir")
	addDir := filepath.Join(t.TempDir(), "add dir")
	request := AgentRequest{
		Workdir: workdir, WritableDirs: []string{addDir}, SessionID: "session-1",
		Effort: "high", Model: "gpt-test", FinalPath: filepath.Join(t.TempDir(), "final.txt"),
		StateDir: t.TempDir(), JobID: "codex-resume-contract",
	}
	adapter := commandAdapter{vendor: "codex", binary: "codex"}
	start, err := adapter.Start(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	resume, err := adapter.Resume(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	execHelp, err := os.ReadFile("testdata/codex/exec-help.txt")
	if err != nil {
		t.Fatal(err)
	}
	resumeHelp, err := os.ReadFile("testdata/codex/exec-resume-help.txt")
	if err != nil {
		t.Fatal(err)
	}
	assertArgumentsSupportedByHelp(t, "codex exec", start.Args[1:], execHelp)
	assertArgumentsSupportedByHelp(t, "codex exec resume", resume.Args[2:], resumeHelp)

	if got := resume.Args[len(resume.Args)-2:]; got[0] != request.SessionID || got[1] != "-" {
		t.Fatalf("resume positional arguments = %q, want session ID then stdin marker", got)
	}
	for _, want := range []string{
		`sandbox_mode="workspace-write"`,
		"sandbox_workspace_write.network_access=true",
		"sandbox_workspace_write.writable_roots=[" + strconv.Quote(workdir) + "," + strconv.Quote(addDir) + "]",
	} {
		if !slices.Contains(resume.Args, want) {
			t.Errorf("Codex resume args %q omit config value %q", resume.Args, want)
		}
	}
}

func assertArgumentsSupportedByHelp(t *testing.T, command string, args []string, help []byte) {
	t.Helper()
	options := make(map[string]struct{})
	readingOptions := false
	for _, line := range strings.Split(string(help), "\n") {
		if line == "Options:" {
			readingOptions = true
			continue
		}
		if !readingOptions {
			continue
		}
		for _, field := range strings.Fields(line) {
			if strings.HasPrefix(field, "-") {
				options[strings.TrimRight(field, ",")] = struct{}{}
			}
		}
	}
	if !readingOptions {
		t.Fatalf("recorded %s help has no Options section", command)
	}
	for _, arg := range args {
		if arg == "-" || !strings.HasPrefix(arg, "-") {
			continue
		}
		if _, ok := options[arg]; !ok {
			t.Errorf("%s does not document emitted flag %q", command, arg)
		}
	}
}

func TestVendorAdapterChildEnvironmentExcludesParentSession(t *testing.T) {
	for _, name := range []string{"CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID", "CLAUDE_OTHER_PARENT_FLAG", "CODEX_PARENT_SESSION"} {
		t.Setenv(name, "parent-session-secret")
	}
	for _, vendor := range []string{"codex", "claude"} {
		t.Run(vendor, func(t *testing.T) {
			fake := filepath.Join(t.TempDir(), vendor)
			if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec /usr/bin/env\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			adapter := commandAdapter{vendor: vendor, binary: fake, childEnv: []string{"VENDOR_REQUIRED=test-required"}}
			cmd, err := adapter.Start(context.Background(), AgentRequest{Workdir: t.TempDir(), Prompt: "safe", StateDir: t.TempDir(), JobID: "adapter-start"})
			if err != nil {
				t.Fatal(err)
			}
			if cmd.Env == nil {
				t.Fatal("vendor child inherits the parent environment")
			}
			output, err := cmd.Output()
			if err != nil {
				t.Fatal("fake vendor CLI failed")
			}
			for _, entry := range strings.Split(string(output), "\n") {
				name, _, _ := strings.Cut(entry, "=")
				if strings.HasPrefix(name, "CLAUDE") || name == "CODEX_PARENT_SESSION" {
					t.Fatalf("vendor child inherited parent session variable %s", name)
				}
			}
			if !strings.Contains(string(output), "VENDOR_REQUIRED=test-required") {
				t.Fatal("vendor child omitted its adapter-declared environment")
			}
		})
	}
}

func TestVendorWorkerEnvironmentCarriesExplicitFakeBinaryWithoutParentSession(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "codex")
	t.Setenv("CODEX_BIN", fake)
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-session-secret")

	env, err := vendorWorkerEnvironment("codex")
	if err != nil {
		t.Fatal(err)
	}
	values := make(map[string]string, len(env))
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("invalid environment entry %q", entry)
		}
		values[name] = value
	}
	if values["CODEX_BIN"] != fake {
		t.Fatalf("worker environment lost explicit provider binary: CODEX_BIN=%q want %q", values["CODEX_BIN"], fake)
	}
	if _, ok := values["CLAUDE_CODE_MESSAGING_TOKEN"]; ok {
		t.Fatal("worker environment forwarded parent-session token")
	}
}

func TestProviderFailureDiagnosticIncludesStderrTail(t *testing.T) {
	detail := providerFailureDetail("provider command exited with code 23", strings.Repeat("x", 5000)+"\nlast diagnostic line\n")
	if !strings.Contains(detail, "provider command exited with code 23") || !strings.Contains(detail, "last diagnostic line") {
		t.Fatalf("provider failure diagnostic=%q", detail)
	}
	if strings.Contains(detail, strings.Repeat("x", 5000)) {
		t.Fatalf("provider diagnostic did not keep a tail: %q", detail)
	}
}

func TestAgentProcessFailureSurfacesPersistedProviderDiagnostic(t *testing.T) {
	store := newJobStore(t.TempDir())
	if _, err := store.Create(Job{ID: "provider-failed", Stream: "diagnostic", Vendor: "codex", State: JobRunning, Phase: PhaseRun}); err != nil {
		t.Fatal(err)
	}
	detail := providerFailureDetail("provider command exited with code 23", "provider stderr detail")
	if err := store.Terminate("provider-failed", JobTerminal{State: JobFailed, Phase: PhaseRun, Reason: ReasonVendorError, Error: detail, Next: "kb-runner status"}); err != nil {
		t.Fatal(err)
	}
	failure := agentProcessFailure(store, "provider-failed", errors.New("exit status 1"), runnerRoot{invocation: "kb-runner"})
	if !strings.Contains(failure.Error(), "provider stderr detail") || !strings.Contains(failure.Error(), "status --json") {
		t.Fatalf("agent start failure=%q", failure)
	}
	job, err := store.Get("provider-failed")
	if err != nil || job.Final == nil || !strings.Contains(job.Final.Error, "provider stderr detail") {
		t.Fatalf("terminal provider diagnostic=%+v err=%v", job.Final, err)
	}
}

func TestAgentWorkerPersistsAndReturnsProviderStderr(t *testing.T) {
	base := t.TempDir()
	state := filepath.Join(base, "state")
	work := filepath.Join(base, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(base, "prompt")
	if err := os.WriteFile(prompt, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(base, "codex")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' 'provider stderr marker' >&2\nexit 23\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", fake)
	id := "provider-stderr"
	store := newJobStore(state)
	if _, err := store.Create(Job{ID: id, Stream: "stderr", Vendor: "codex", State: JobQueued, Phase: PhaseWorktree}); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{"--job-id", id, "--state", state, "--stream", "stderr", "--vendor", "codex", "--workdir", work, "--prompt-file", prompt}, &stdout, &stderr)
	if code != 1 || err == nil || !strings.Contains(err.Error(), "provider stderr marker") {
		t.Fatalf("worker failure code=%d err=%v stdout=%s stderr=%s", code, err, stdout.String(), stderr.String())
	}
	job, err := store.Get(id)
	if err != nil || job.Final == nil || !strings.Contains(job.Final.Error, "provider stderr marker") {
		t.Fatalf("terminal diagnostic=%+v err=%v", job.Final, err)
	}
}

func TestAgentWaitCLIBlocksUntilTerminalRecord(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	job, err := store.Create(Job{ID: "wait-cli-job", Stream: "wait-cli", Vendor: "claude", State: JobRunning, Phase: PhaseRun})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Terminate(job.ID, JobTerminal{State: JobOK, Phase: PhaseRun, Next: "kb-runner status"}); err != nil {
		t.Fatal(err)
	}
	runner := buildRunnerBinary(t)
	command := exec.Command(runner, "wait", "--any", "--state", state, "--json", job.ID)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("wait CLI: %v output=%s", err, output)
	}
	if !strings.Contains(string(output), `"terminal":{"state":"ok"`) {
		t.Fatalf("wait CLI omitted terminal job: %s", output)
	}
}

func TestAgentStartUsesSharedProcessOwnerAndAdmission(t *testing.T) {
	base := t.TempDir()
	state := filepath.Join(base, "state")
	work := filepath.Join(base, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(base, "prompt")
	if err := os.WriteFile(prompt, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(base, "codex")
	envDump := filepath.Join(base, "vendor-environment")
	quotedEnvDump := "'" + strings.ReplaceAll(envDump, "'", "'\\''") + "'"
	script := "#!/bin/sh\n/usr/bin/env > " + quotedEnvDump + "\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"owned-session\"}' '{\"type\":\"turn.completed\",\"message\":\"done\"}'\n"
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", fake)
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-session-secret")
	runner := buildRunnerBinary(t)
	cmd := exec.Command(runner, "agent", "start", "--state", state, "--stream", "owned-stream", "--vendor", "codex", "--workdir", work, "--prompt-file", prompt, "--slot-group", "codex-test", "--slots", "1", "--hold-gate", "batch", "--min-free", "1")
	cmd.Env = os.Environ()
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("agent start: %v output=%s", err, output)
	}
	jobs, err := newJobStore(state).List()
	if err != nil || len(jobs) != 1 || jobs[0].State != JobOK || jobs[0].SessionID != "owned-session" {
		t.Fatalf("jobs=%+v err=%v", jobs, err)
	}
	childEnv, err := os.ReadFile(envDump)
	if err != nil {
		t.Fatalf("fake Codex did not dump its child environment: %v", err)
	}
	for _, entry := range strings.Split(string(childEnv), "\n") {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "CLAUDE") {
			t.Fatalf("agent provider inherited parent-session variable %s", name)
		}
	}
	listing := proc.List(state)
	if listing.Error != nil || len(listing.Runs) != 1 {
		t.Fatalf("process owner listing=%+v", listing)
	}
	if listing.Runs[0].SlotGroup != "codex-test" || listing.Runs[0].Tag != "agent:"+jobs[0].ID {
		t.Fatalf("process record did not retain agent admission identity: %+v", listing.Runs[0])
	}
	if _, held, err := proc.GateStatus(state, "batch"); err != nil || held {
		t.Fatalf("completed agent left batch gate held=%v err=%v", held, err)
	}
}

func TestAgentJobLifecycleAndTerminalUniqueness(t *testing.T) {
	for _, tc := range []struct {
		name   string
		phase  JobPhase
		state  JobState
		reason JobReason
	}{
		{"setup failure", PhaseWorktree, JobFailed, ReasonSetup},
		{"install failure", PhaseInstall, JobFailed, ReasonSetup},
		{"build failure", PhaseBuild, JobFailed, ReasonSetup},
		{"quota admission", PhaseAdmission, JobQuotaWait, ReasonQuota},
		{"provider outage", PhaseRun, JobPaused, ReasonProviderUnreachable},
		{"successful run", PhaseRun, JobOK, ReasonNone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newJobStore(t.TempDir())
			job, err := s.Create(Job{ID: "j-1", Stream: "x", Vendor: "codex", Phase: tc.phase, State: tc.state, Reason: tc.reason, StartedAt: time.Now().UTC()})
			if err != nil {
				t.Fatal(err)
			}
			got, err := s.Get(job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Phase != tc.phase || got.State != tc.state || got.Reason != tc.reason {
				t.Fatalf("round-trip = %+v", got)
			}
			if tc.state.Terminal() {
				if err := s.Terminate(job.ID, JobTerminal{State: tc.state, Phase: tc.phase, Reason: tc.reason, Next: "kb-runner status", MessagePath: "/tmp/final.md", SessionID: "session"}); err != nil {
					t.Fatal(err)
				}
				if err := s.Terminate(job.ID, JobTerminal{State: JobFailed, Phase: tc.phase, Reason: ReasonVendorError}); err == nil {
					t.Fatal("second terminal record accepted")
				}
				got, _ = s.Get(job.ID)
				if got.Final == nil || got.Final.SessionID != "session" {
					t.Fatalf("terminal record = %+v", got.Final)
				}
			}
		})
	}
}

func TestAgentPersistenceFailureWritesFallbackAndNamesStatusCommand(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	if _, err := store.Create(Job{ID: "persist-failure", Stream: "stream", Vendor: "codex"}); err != nil {
		t.Fatal(err)
	}
	jobPath := store.path("persist-failure")
	if err := os.Rename(jobPath, jobPath+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(jobPath, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := failAgentJob(store, "persist-failure", PhaseBuild, ReasonSetup, runnerRoot{invocation: "kb-runner"}, "", errors.New("build failed"))
	if err == nil || !strings.Contains(err.Error(), "build failed") {
		t.Fatalf("job failure was not reported after terminal persistence: %v", err)
	}
	want := "next: " + shellQuote("kb-runner") + " status --state " + shellQuote(state) + " --json"
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("persistence failure omitted exact next command %q: %v", want, err)
	}
	job, err := store.Get("persist-failure")
	if err != nil || job.Final == nil || job.Final.State != JobFailed || job.Final.Phase != PhaseBuild || job.Final.Reason != ReasonSetup || job.Final.Next != strings.TrimPrefix(want, "next: ") {
		t.Fatalf("terminal record was not recoverable after primary record failure: job=%+v err=%v", job, err)
	}
	jobs, err := store.List()
	if err != nil || len(jobs) != 1 || jobs[0].ID != job.ID || jobs[0].Final == nil {
		t.Fatalf("job listing omitted recovered terminal record: jobs=%+v err=%v", jobs, err)
	}
	if err := store.Terminate(job.ID, JobTerminal{State: JobFailed, Phase: PhaseBuild, Reason: ReasonSetup, Next: want}); err == nil || !strings.Contains(err.Error(), "already has a terminal record") {
		t.Fatalf("fallback allowed a duplicate terminal record: %v", err)
	}
}

func TestAgentWaitCursorReturnsUnacknowledgedTerminalExactlyOnce(t *testing.T) {
	s := newJobStore(t.TempDir())
	for _, id := range []string{"b", "a"} {
		_, err := s.Create(Job{ID: id, Stream: id, Vendor: "codex", Phase: PhaseRun, State: JobOK, StartedAt: time.Now().UTC()})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Terminate(id, JobTerminal{State: JobOK, Phase: PhaseRun, Next: "kb-runner status"}); err != nil {
			t.Fatal(err)
		}
	}
	jobs, cursor, err := s.Wait([]string{"a", "b"}, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].ID != "b" || cursor == "" {
		t.Fatalf("wait(any) = %v cursor %q", jobs, cursor)
	}
	jobs, _, err = s.Wait([]string{"a", "b"}, false, cursor)
	if err != nil || len(jobs) != 1 || jobs[0].ID != "a" {
		t.Fatalf("wait(any,since) = %v, %v", jobs, err)
	}
	jobs, _, err = s.Wait([]string{"a", "b"}, true, "")
	if err != nil || len(jobs) != 2 {
		t.Fatalf("wait(all) = %v, %v", jobs, err)
	}
}

func TestAgentVendorStreamEventsNormalizeWithoutTransientPause(t *testing.T) {
	for _, tc := range []struct {
		name, vendor, line string
		kind               EventKind
	}{
		{"codex started", "codex", `{"type":"thread.started","thread_id":"s1"}`, EventStarted},
		{"codex usage", "codex", `{"type":"token_count","total_token_usage":{"total_tokens":42}}`, EventUsage},
		{"claude tool", "claude", `{"type":"tool_use","session_id":"s2","name":"Read"}`, EventTool},
		{"rate limit", "codex", `{"type":"error","message":"rate limit exceeded; try again at 12:00 PM"}`, EventRateLimited},
		{"transient network noise", "codex", `{"type":"error","message":"failed to refresh available models: request timed out"}`, EventVendorError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, err := parseVendorEvent(tc.vendor, []byte(tc.line))
			if err != nil {
				t.Fatal(err)
			}
			if e.Kind != tc.kind {
				t.Fatalf("kind=%s want %s (%+v)", e.Kind, tc.kind, e)
			}
			if tc.name == "transient network noise" && e.Kind == EventProviderUnreachable {
				t.Fatal("single line classified as sustained outage")
			}
		})
	}
}

func TestAgentLimitsCacheAndUnavailableSchema(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "limits.json")
	provider := fakeLimitProvider{limits: []VendorLimit{{Vendor: "codex", Window: "5h", UsedPercent: 96, Confidence: "vendor", Source: "fake"}}}
	first, err := cachedLimits(cache, time.Minute, provider, time.Now)
	if err != nil || len(first) != 1 || first[0].UsedPercent != 96 {
		t.Fatalf("limits=%+v err=%v", first, err)
	}
	second, err := cachedLimits(cache, time.Minute, fakeLimitProvider{err: os.ErrPermission}, time.Now)
	if err != nil || len(second) != 1 {
		t.Fatalf("cache did not shield repeat request: %+v %v", second, err)
	}
	unavailable := decodeCodexLimits([]byte(`{"unexpected":true}`), time.Now)
	if len(unavailable) == 0 || unavailable[0].Confidence != "unavailable" || strings.TrimSpace(unavailable[0].Error) == "" {
		t.Fatalf("schema drift = %+v", unavailable)
	}
	valid := decodeCodexLimits([]byte(realCodexRateLimitsFixture), time.Now)
	if len(valid) != 2 || valid[0].Confidence != "vendor" || valid[0].Window != "5h" || valid[0].UsedPercent != 82 || valid[0].ResetsAt == nil || valid[0].ResetsAt.Unix() != 1792775628 {
		t.Fatalf("Codex limits=%+v", valid)
	}
	b, _ := json.Marshal(first)
	if strings.Contains(string(b), "token") {
		t.Fatalf("limit result leaked credential-related field: %s", b)
	}
}

func TestAgentStatusAndWaitCommandsReadPersistedJobs(t *testing.T) {
	state := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	fakeCodex := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(fakeCodex, []byte("#!/bin/sh\necho '{\"id\":2,\"result\":{}}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", fakeCodex)
	s := newJobStore(state)
	_, err := s.Create(Job{ID: "status-job", Stream: "stream", Vendor: "claude", Model: "sonnet", Phase: PhaseRun, State: JobRunning, RunID: "missing-run", WorkerPID: 2147483647, WorkerStartedAt: "0:1", StartedAt: time.Now().Add(-time.Minute).UTC(), SessionID: "sess"})
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	code, err := agentStatusCommand([]string{"--state", state, "--json"}, &out)
	if err != nil || code != 0 {
		t.Fatalf("status: %d %v", code, err)
	}
	var payload AgentStatus
	if err := json.Unmarshal([]byte(out.String()), &payload); err != nil || len(payload.Jobs) != 1 || payload.Jobs[0].ID != "status-job" {
		t.Fatalf("status payload=%s err=%v", out.String(), err)
	}
}

func TestQuotaAdmissionUsesPerWindowThresholdAndUnavailableAdmits(t *testing.T) {
	for _, tc := range []struct {
		name    string
		limit   VendorLimit
		blocked bool
	}{
		{"5h at threshold", VendorLimit{Window: "5h", UsedPercent: 95, Confidence: "vendor"}, true},
		{"week below threshold", VendorLimit{Window: "week", UsedPercent: 97.99, Confidence: "vendor"}, false},
		{"week at threshold", VendorLimit{Window: "week", UsedPercent: 98, Confidence: "vendor"}, true},
		{"unavailable admits", VendorLimit{Window: "5h", UsedPercent: 100, Confidence: "unavailable"}, false},
		{"estimate admits", VendorLimit{Window: "5h", UsedPercent: 100, Confidence: "estimate"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := quotaBlocked([]VendorLimit{tc.limit}, 95, 98); got != tc.blocked {
				t.Fatalf("blocked=%v want %v", got, tc.blocked)
			}
		})
	}
}

type sequenceLimitProvider struct {
	results [][]VendorLimit
	calls   int
}

func (p *sequenceLimitProvider) Limits(context.Context) ([]VendorLimit, error) {
	result := p.results[min(p.calls, len(p.results)-1)]
	p.calls++
	return result, nil
}

func TestQuotaWaitSurvivesUntilResetThenRechecksAndAdmits(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	job, err := store.Create(Job{ID: "quota-job", Stream: "quota-stream", Vendor: "codex", State: JobRunning, Phase: PhaseAdmission})
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	reset := started.Add(50 * time.Millisecond)
	initial := []VendorLimit{{Vendor: "codex", Window: "5h", UsedPercent: 96, ResetsAt: &reset, Confidence: "vendor"}}
	provider := &sequenceLimitProvider{results: [][]VendorLimit{
		{{Vendor: "codex", Window: "5h", UsedPercent: 44, Confidence: "vendor"}},
	}}
	if err := waitForQuotaAdmission(context.Background(), initial, provider, store, job.ID, 95, 98, realQuotaAdmissionClock{}); err != nil {
		t.Fatal(err)
	}
	if provider.calls != 1 {
		t.Fatalf("quota source was checked %d times; want one recheck after reset", provider.calls)
	}
	if elapsed := time.Since(started); elapsed < 40*time.Millisecond {
		t.Fatalf("quota source was rechecked before its reset: elapsed=%s", elapsed)
	}
	got, err := store.Get(job.ID)
	if err != nil || got.State != JobRunning || got.Phase != PhaseAdmission || got.Reason != ReasonNone {
		t.Fatalf("re-admitted job=%+v err=%v", got, err)
	}
}

func TestProviderUnreachableRequiresConfiguredConsecutiveFailures(t *testing.T) {
	tracker := newHealthTracker(3)
	line := []byte(`{"type":"error","message":"request timed out"}`)
	for i := 0; i < 2; i++ {
		event, err := tracker.Observe("codex", line)
		if err != nil {
			t.Fatal(err)
		}
		if event.Kind == EventProviderUnreachable {
			t.Fatal("brief outage was escalated")
		}
	}
	event, err := tracker.Observe("codex", line)
	if err != nil {
		t.Fatal(err)
	}
	if event.Kind != EventProviderUnreachable {
		t.Fatalf("third timeout = %+v", event)
	}
}

func TestDailyTokenTotalsAggregateDurableJobsByVendorAndUTCDate(t *testing.T) {
	day := time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)
	got := dailyTokenTotals([]Job{{Vendor: "codex", StartedAt: day, Tokens: 20}, {Vendor: "codex", StartedAt: day.Add(time.Hour), Tokens: 22}, {Vendor: "claude", StartedAt: day, Tokens: 7}})
	if len(got) != 2 || got[0].Vendor != "claude" || got[1].Tokens != 42 {
		t.Fatalf("daily totals=%+v", got)
	}
}

func TestAgentStartPersistsSingleJobAcrossPhasesAndProviderEvents(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	prompt := filepath.Join(dir, "prompt.md")
	work := filepath.Join(dir, "work")
	if err := os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prompt, []byte("do the task"), 0600); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nif [ \"$1\" = app-server ]; then while IFS= read -r line; do case \"$line\" in *'\"id\":1'*) echo '{\"id\":1,\"result\":{}}';; *'\"id\":2'*) echo '{\"id\":2,\"result\":{}}'; exit;; esac; done; fi\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"session-1\"}' '{\"type\":\"token_count\",\"total_token_usage\":{\"total_tokens\":42}}' '{\"type\":\"turn.completed\",\"message\":\"final answer\"}'\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", bin)
	state := filepath.Join(dir, "state")
	_, err := newJobStore(state).Create(Job{ID: "job-success", Stream: "stream-a", Vendor: "codex", State: JobQueued, Phase: PhaseWorktree})
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{"--job-id", "job-success", "--state", state, "--stream", "stream-a", "--vendor", "codex", "--workdir", work, "--prompt-file", prompt, "--worktree-command", "true", "--install-command", "true", "--build-command", "true"}, &out, &strings.Builder{})
	if err != nil || code != 0 {
		t.Fatalf("start=%d %v output=%s", code, err, out.String())
	}
	jobs, err := newJobStore(state).List()
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs=%+v err=%v", jobs, err)
	}
	j := jobs[0]
	if j.State != JobOK || j.Final == nil || j.Phase != PhaseRun || j.Tokens != 42 || j.SessionID != "session-1" {
		t.Fatalf("job=%+v", j)
	}
	final, err := os.ReadFile(j.Final.MessagePath)
	if err != nil || string(final) != "final answer" {
		t.Fatalf("final message=%q err=%v", final, err)
	}
}

func TestAgentStartFailureInInstallIsTerminalAndDoesNotRunProvider(t *testing.T) {
	dir := t.TempDir()
	work := filepath.Join(dir, "work")
	_ = os.Mkdir(work, 0700)
	prompt := filepath.Join(dir, "prompt")
	_ = os.WriteFile(prompt, []byte("task"), 0600)
	state := filepath.Join(dir, "state")
	_, createErr := newJobStore(state).Create(Job{ID: "job-install-fail", Stream: "stream-b", Vendor: "codex", State: JobQueued, Phase: PhaseWorktree})
	if createErr != nil {
		t.Fatal(createErr)
	}
	var out, stderr strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{"--job-id", "job-install-fail", "--state", state, "--stream", "stream-b", "--vendor", "codex", "--workdir", work, "--prompt-file", prompt, "--install-command", "exit 7"}, &out, &stderr)
	if err == nil || code == 0 {
		t.Fatalf("failing install returned %d %v", code, err)
	}
	jobs, _ := newJobStore(state).List()
	if len(jobs) != 1 || jobs[0].State != JobFailed || jobs[0].Phase != PhaseInstall || jobs[0].Final == nil {
		t.Fatalf("job=%+v", jobs)
	}
}

func TestProviderUnreachableResumesSameSessionAndRecordsAttempts(t *testing.T) {
	dir := t.TempDir()
	work := filepath.Join(dir, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(dir, "prompt")
	if err := os.WriteFile(prompt, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(dir, "codex")
	script := `#!/bin/sh
if [ "$1" = app-server ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"id":1'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
      *'"id":2'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","primary":{"usedPercent":82,"windowDurationMins":300,"resetsAt":1792775628},"secondary":{"usedPercent":24,"windowDurationMins":10080,"resetsAt":1793298749},"credits":{"hasCredits":true},"planType":"plus","rateLimitReachedType":null,"spendControlReached":false},"rateLimitsByLimitId":{"codex":{"limitId":"codex"}},"accountId":"private-account"}}' ;;
    esac
  done
  exit 0
fi
if [ "$1" = exec ] && [ "$2" = resume ]; then
  printf '%s\n' '{"type":"result","result":"recovered"}'
  exit 0
fi
printf '%s\n' '{"type":"thread.started","thread_id":"persistent-session"}' '{"type":"error","message":"network request timed out"}' '{"type":"error","message":"network request timed out"}' '{"type":"error","message":"network request timed out"}'
exit 1
`
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", fake)
	state := filepath.Join(dir, "state")
	_, err := newJobStore(state).Create(Job{ID: "recovery-job", Stream: "recovery", Vendor: "codex", State: JobQueued, Phase: PhaseWorktree})
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"--job-id", "recovery-job", "--state", state, "--stream", "recovery", "--vendor", "codex", "--workdir", work, "--prompt-file", prompt}
	var out, stderr strings.Builder
	code, err := agentStartCommand(runnerRoot{invocation: "kb-runner"}, args, &out, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("recovery start=%d err=%v stdout=%s stderr=%s", code, err, out.String(), stderr.String())
	}
	job, err := newJobStore(state).Get("recovery-job")
	if err != nil || job.State != JobOK || job.SessionID != "persistent-session" || len(job.Attempts) != 2 {
		t.Fatalf("recovered job=%+v err=%v", job, err)
	}
	if job.Attempts[0].Outcome != "paused" || job.Attempts[0].SessionID != "persistent-session" || job.Attempts[1].Outcome != "ok" {
		t.Fatalf("attempt history=%+v", job.Attempts)
	}
}
