//go:build darwin || linux

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/kb-runner/internal/proc"
)

// case: S-237.66
func TestTerminalJobReapsOnlyItsReadOnlyZcodeTemp(t *testing.T) {
	for _, terminalState := range []JobState{JobOK, JobFailed, JobCancelled} {
		t.Run(string(terminalState), func(t *testing.T) {
			state := t.TempDir()
			store := newJobStore(state)
			jobID := "zcode-readonly-temp"
			jobTemp := zcodeJobTemp(AgentRequest{StateDir: state, JobID: jobID})
			siblingTemp := zcodeJobTemp(AgentRequest{StateDir: state, JobID: "sibling"})
			t.Cleanup(func() {
				if err := filepath.WalkDir(jobTemp, func(path string, entry os.DirEntry, walkErr error) error {
					if walkErr != nil {
						t.Logf("restore temp permissions at %s: %v", path, walkErr)
						return nil
					}
					if entry.IsDir() {
						if err := os.Chmod(path, 0o700); err != nil {
							t.Logf("restore directory permissions at %s: %v", path, err)
						}
					} else if info, err := entry.Info(); err == nil && info.Mode().IsRegular() {
						if err := os.Chmod(path, 0o600); err != nil {
							t.Logf("restore file permissions at %s: %v", path, err)
						}
					}
					return nil
				}); err != nil && !os.IsNotExist(err) {
					t.Logf("walk temp to restore permissions: %v", err)
				}
			})
			for _, dir := range []string{jobTemp, siblingTemp} {
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			siblingFile := filepath.Join(siblingTemp, "keep")
			if err := os.WriteFile(siblingFile, []byte("sibling"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := store.Create(Job{ID: jobID, Vendor: "zcode", State: JobRunning}); err != nil {
				t.Fatal(err)
			}
			writer := exec.Command("/bin/sh", "-c", `set -e; mkdir "$TMPDIR/nested"; printf 'toolchain-cache' > "$TMPDIR/nested/cache"; chmod 400 "$TMPDIR/nested/cache"; chmod 500 "$TMPDIR/nested"; chmod 500 "$TMPDIR"`)
			writer.Env = append(os.Environ(), "TMPDIR="+jobTemp)
			if output, err := writer.CombinedOutput(); err != nil {
				t.Fatalf("fake vendor temp write: %s: %v", output, err)
			}
			if err := store.Terminate(jobID, JobTerminal{State: terminalState, Phase: PhaseRun, Next: "kb-runner status"}); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(jobTemp); !os.IsNotExist(err) {
				t.Fatalf("terminal job temp still exists: %v", err)
			}
			if _, err := os.Stat(siblingFile); err != nil {
				t.Fatalf("sibling job temp was removed: %v", err)
			}
			job, err := store.Get(jobID)
			if err != nil {
				t.Fatal(err)
			}
			if job.Final.TempReclaimedBytes == nil || *job.Final.TempReclaimedBytes != uint64(len("toolchain-cache")) {
				t.Fatalf("reclaimed bytes = %v, want %d", job.Final.TempReclaimedBytes, len("toolchain-cache"))
			}
		})
	}
}

// case: S-237.66
func TestDotComponentJobIDsCannotReapOutsideTheirJobDirectory(t *testing.T) {
	for _, jobID := range []string{".", ".."} {
		t.Run(jobID, func(t *testing.T) {
			state := t.TempDir()
			store := newJobStore(state)
			temp := zcodeJobTemp(AgentRequest{StateDir: state, JobID: jobID})
			if err := os.MkdirAll(temp, 0o700); err != nil {
				t.Fatal(err)
			}
			sentinel := filepath.Join(temp, "outside-sentinel")
			if err := os.WriteFile(sentinel, []byte("preserve"), 0o600); err != nil {
				t.Fatal(err)
			}
			_, createErr := store.Create(Job{ID: jobID, Vendor: "zcode", State: JobRunning})
			if createErr == nil {
				_ = store.Terminate(jobID, JobTerminal{State: JobOK, Phase: PhaseRun, Next: "kb-runner status"})
			}
			if _, err := os.Stat(sentinel); err != nil {
				t.Fatalf("dot-component job ID removed outside sentinel: %v", err)
			}
			if createErr == nil {
				t.Fatalf("job ID %q was accepted; want shared job-ID validation to reject path components", jobID)
			}
		})
	}
}

// case: S-237.66
func TestNonterminalJobTransitionPreservesTempForReadableAndUnreadableRecords(t *testing.T) {
	for _, unreadable := range []bool{false, true} {
		name := "readable record"
		if unreadable {
			name = "unreadable record"
		}
		t.Run(name, func(t *testing.T) {
			state := t.TempDir()
			store := newJobStore(state)
			jobID := "invalid-terminal-transition"
			if unreadable {
				if err := os.MkdirAll(store.dir, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(store.path(jobID), []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else if _, err := store.Create(Job{ID: jobID, Vendor: "zcode", State: JobRunning}); err != nil {
				t.Fatal(err)
			}
			tempDir := zcodeJobTemp(AgentRequest{StateDir: state, JobID: jobID})
			if err := os.MkdirAll(tempDir, 0o700); err != nil {
				t.Fatal(err)
			}
			cachePath := filepath.Join(tempDir, "cache")
			if err := os.WriteFile(cachePath, []byte("preserve-this-cache"), 0o400); err != nil {
				t.Fatal(err)
			}
			if err := store.Terminate(jobID, JobTerminal{State: JobRunning, Phase: PhaseRun, Next: "kb-runner status"}); err == nil || !strings.Contains(err.Error(), "not terminal") {
				t.Fatalf("nonterminal transition error = %v; want a terminal-state validation error", err)
			}
			contents, err := os.ReadFile(cachePath)
			if err != nil || string(contents) != "preserve-this-cache" {
				t.Fatalf("rejected transition changed job temp contents: contents=%q err=%v", contents, err)
			}
			if _, err := os.Stat(tempDir); err != nil {
				t.Fatalf("rejected transition removed job temp tree: %v", err)
			}
			if _, err := os.Stat(store.terminalPath(jobID)); !os.IsNotExist(err) {
				t.Fatalf("rejected transition wrote a terminal record: %v", err)
			}
		})
	}
}

// case: S-237.67
func TestFirstJobReadMarksDeadOrReusedWorkerIdentityLost(t *testing.T) {
	for _, tc := range []struct {
		name  string
		pid   int
		start string
	}{
		{name: "dead pid", pid: 2147483647, start: "0:1"},
		{name: "reused pid", pid: os.Getpid(), start: "different-start-identity"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := t.TempDir()
			store := newJobStore(state)
			jobTemp := zcodeJobTemp(AgentRequest{StateDir: state, JobID: "lost-worker"})
			if err := os.MkdirAll(jobTemp, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(jobTemp, "cache"), []byte("lost-cache"), 0o400); err != nil {
				t.Fatal(err)
			}
			job := Job{ID: "lost-worker", Vendor: "zcode", State: JobRunning, RunID: "foreign-run", WorkerPID: tc.pid, WorkerStartedAt: tc.start}
			if err := os.MkdirAll(store.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(job)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(store.path(job.ID), encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			jobs, err := store.List()
			if err != nil {
				t.Fatal(err)
			}
			if len(jobs) != 1 || jobs[0].State != JobLost || jobs[0].Reason != ReasonProcessLost {
				t.Fatalf("first read jobs = %+v; want one lost/process_lost job", jobs)
			}
			if _, err := os.Stat(jobTemp); !os.IsNotExist(err) {
				t.Fatalf("lost worker temp remains after first read: %v", err)
			}
			if jobs[0].Final == nil || jobs[0].Final.TempReclaimedBytes == nil || *jobs[0].Final.TempReclaimedBytes != uint64(len("lost-cache")) {
				t.Fatalf("lost terminal cleanup record = %+v", jobs[0].Final)
			}
			if _, alive, err := proc.ProcessIdentity(tc.pid); err != nil {
				t.Fatal(err)
			} else if tc.pid == os.Getpid() && !alive {
				t.Fatal("test process unexpectedly not alive")
			}
		})
	}
}

// case: S-237.67
func TestJobWithoutRunIdentityRemainsUnknown(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	job := Job{ID: "unidentified-worker", State: JobRunning, WorkerPID: os.Getpid(), WorkerStartedAt: "present-but-unowned"}
	if _, err := store.Create(job); err != nil {
		t.Fatal(err)
	}
	if _, err := store.List(); err == nil || !strings.Contains(err.Error(), "process liveness is unknown") || !strings.Contains(err.Error(), "next: ") {
		t.Fatalf("job list error = %v; want explicit unknown liveness", err)
	}
	persisted, err := readJobFile(store.path(job.ID))
	if err != nil || persisted.State != JobRunning || persisted.Final != nil {
		t.Fatalf("unknown worker was mutated during reconciliation: job=%+v err=%v", persisted, err)
	}
}

func TestStatusAndWaitReturnLostWorkerOnFirstRead(t *testing.T) {
	for _, read := range []string{"status", "wait"} {
		t.Run(read, func(t *testing.T) {
			state := t.TempDir()
			store := newJobStore(state)
			job := Job{ID: "lost-worker", Stream: "lost-stream", Vendor: "zcode", State: JobRunning, RunID: "missing-run", WorkerPID: 2147483647, WorkerStartedAt: "0:1"}
			if err := os.MkdirAll(store.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(job)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(store.path(job.ID), encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			root := runnerRoot{invocation: "kb-runner"}
			var output strings.Builder
			var code int
			if read == "status" {
				code, err = agentStatusCommandWithRoot(root, []string{"--state", state, "--json"}, &output)
			} else {
				var jobs []Job
				jobs, _, err = store.Wait([]string{"lost-stream"}, false, "")
				if err == nil {
					encoded, err = json.Marshal(jobs)
					if err == nil {
						_, err = output.Write(encoded)
					}
				}
			}
			want := `"state":"lost"`
			if err != nil || code != 0 || !strings.Contains(output.String(), want) {
				t.Fatalf("%s first read: code=%d err=%v output=%s", read, code, err, output.String())
			}
		})
	}
}

// case: S-237.67
func TestPSAndEventsReconcileJobsBeforeReadingRunState(t *testing.T) {
	for _, read := range []string{"ps", "events"} {
		t.Run(read, func(t *testing.T) {
			state := t.TempDir()
			store := newJobStore(state)
			job := Job{ID: "lost-worker", Vendor: "zcode", State: JobRunning, RunID: "missing-run", WorkerPID: 2147483647, WorkerStartedAt: "0:1"}
			if err := os.MkdirAll(store.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(job)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(store.path(job.ID), encoded, 0o600); err != nil {
				t.Fatal(err)
			}
			wantOutput := "No supervised runs.\n"
			if read == "events" {
				event := proc.Event{Schema: "kb-runner/v1", Type: proc.EventExit, RunID: "fixture", Tag: "fixture"}
				encodedEvent, marshalErr := json.Marshal(event)
				if marshalErr != nil {
					t.Fatal(marshalErr)
				}
				if err := os.WriteFile(filepath.Join(state, "events.jsonl"), append(encodedEvent, '\n'), 0o600); err != nil {
					t.Fatal(err)
				}
				wantOutput = string(append(encodedEvent, '\n'))
			}
			root := runnerRoot{invocation: "kb-runner"}
			var output strings.Builder
			var code int
			if read == "ps" {
				code, err = psCommand(root, []string{"--state", state}, &output)
			} else {
				code, err = eventsCommand(root, []string{"--state", state}, &output)
			}
			if err != nil || code != 0 || output.String() != wantOutput {
				t.Fatalf("%s process-state read returned code %d err=%v output=%q; want output=%q", read, code, err, output.String(), wantOutput)
			}
			job, err = store.Get(job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if job.State != JobLost || job.Final == nil || job.Reason != ReasonProcessLost {
				t.Fatalf("%s read left job unreconciled: %+v", read, job)
			}
		})
	}
}

// case: S-237.67
func TestAgentAdmissionReconcilesStaleJobBeforeProceeding(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	lost := Job{ID: "lost-before-admission", Vendor: "zcode", State: JobRunning, RunID: "missing-run", WorkerPID: 2147483647, WorkerStartedAt: "0:1"}
	if err := os.MkdirAll(store.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(lost)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.path(lost.ID), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	lostTemp := zcodeJobTemp(AgentRequest{StateDir: state, JobID: lost.ID})
	if err := os.MkdirAll(lostTemp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lostTemp, "cache"), []byte("cache"), 0o400); err != nil {
		t.Fatal(err)
	}
	workdir := t.TempDir()
	prompt := filepath.Join(t.TempDir(), "prompt.md")
	if err := os.WriteFile(prompt, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	var output, stderr strings.Builder
	code, startErr := agentStartCommand(runnerRoot{invocation: "kb-runner"}, []string{
		"--state", state, "--stream", "new-stream", "--vendor", "codex", "--workdir", workdir, "--prompt-file", prompt, "--min-free", "not-bytes",
	}, &output, &stderr)
	if code == 0 || startErr == nil {
		t.Fatalf("agent start result = %d, %v; want invalid min-free to stop after reconciliation", code, startErr)
	}
	updated, err := store.Get(lost.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.State != JobLost || updated.Reason != ReasonProcessLost || updated.Final == nil || updated.Final.TempReclaimedBytes == nil || *updated.Final.TempReclaimedBytes != uint64(len("cache")) {
		t.Fatalf("admission did not reconcile stale job before proceeding: %+v", updated)
	}
	if _, err := os.Stat(lostTemp); !os.IsNotExist(err) {
		t.Fatalf("stale job temp remains after admission reconciliation: %v", err)
	}
}

func TestConcurrentTerminalTransitionsReapAndAccountOnce(t *testing.T) {
	state := t.TempDir()
	store := newJobStore(state)
	jobID := "concurrent-terminal"
	if _, err := store.Create(Job{ID: jobID, Vendor: "zcode", State: JobRunning}); err != nil {
		t.Fatal(err)
	}
	jobTemp := zcodeJobTemp(AgentRequest{StateDir: state, JobID: jobID})
	if err := os.MkdirAll(jobTemp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(jobTemp, "cache"), []byte("cache-once"), 0o400); err != nil {
		t.Fatal(err)
	}
	const callers = 8
	results := make(chan error, callers)
	for range callers {
		go func() {
			results <- newJobStore(state).Terminate(jobID, JobTerminal{State: JobOK, Phase: PhaseRun, Next: "kb-runner status"})
		}()
	}
	successes := 0
	for range callers {
		if err := <-results; err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("successful terminal transitions = %d, want exactly one", successes)
	}
	job, err := store.Get(jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Final == nil || job.Final.TempReclaimedBytes == nil || *job.Final.TempReclaimedBytes != uint64(len("cache-once")) || job.Final.TempCleanupError != "" {
		t.Fatalf("terminal cleanup accounted more or less than once: %+v", job.Final)
	}
}
