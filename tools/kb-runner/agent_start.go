//go:build darwin || linux

package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

const defaultAgentStall = 30 * time.Minute

// maxProviderRecoveryAttempts bounds how many times one job resumes the same
// vendor session after transient provider failures.
const maxProviderRecoveryAttempts = 3

// providerContinuationPrompt is the fixed message a resumed session receives
// after a transient provider failure. The vendor keeps the session state, so
// the prompt only has to point the agent back at the interrupted task.
const providerContinuationPrompt = "The provider connection dropped mid-task (transient vendor error). Continue the same task from where you were. Re-check the worktree state first (git status, your notes), do not redo finished steps, and keep the final report current."

func agentCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := fmt.Fprintf(out, "Usage: %s agent <launch|resume|review|rework> <stream> [--state <dir>] | %s agent start --stream <name> --vendor <%s> --workdir <path> --prompt-file <path> [--test-channel on|off] [phase commands]\n", root.Name(), root.Name(), strings.Join(vendorNamesFor(nil), "|"))
		return 0, err
	}
	if len(args) == 0 {
		return 2, fmt.Errorf("%s agent: operation required; next: %s agent --help", root.Name(), root.InvocationCommand())
	}
	if args[0] != "start" {
		return agentLifecycleCommand(root, args, out)
	}
	return agentStartCommand(root, args[1:], out, errOut)
}

func agentStartCommand(root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return agentStartCommandWithContext(ctx, root, args, out, errOut)
}

func agentStartCommandWithContext(ctx context.Context, root runnerRoot, args []string, out, errOut io.Writer) (int, error) {
	fs := flag.NewFlagSet("agent start", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	state := fs.String("state", defaultRunnerState(), "durable runner state directory")
	stream := fs.String("stream", "", "stable stream name")
	vendor := fs.String("vendor", defaultAgentVendor, "agent provider; reserve vendors require explicit selection")
	model := fs.String("model", "", "provider model")
	workdir := fs.String("workdir", "", "agent working directory")
	promptFile := fs.String("prompt-file", "", "prompt or resume message file")
	session := fs.String("session", "", "resume this vendor session")
	effort := fs.String("effort", "high", "reasoning effort")
	message := fs.String("message", "", "final message output path")
	setup := fs.String("worktree-command", "", "optional worktree preparation command")
	install := fs.String("install-command", "", "dependency installation command")
	build := fs.String("build-command", "", "workspace build command")
	jobID := fs.String("job-id", "", "internal persisted job identifier")
	recoveryAttempt := fs.Int("recovery-attempt", 0, "internal bounded provider recovery attempt")
	slots := fs.Int("slots", 5, "maximum concurrent jobs in slot group")
	slotGroup := fs.String("slot-group", "", "vendor capacity group")
	waitGate := fs.String("wait-gate", "", "wait for this shared batch gate")
	holdGate := fs.String("hold-gate", "", "hold this batch gate while the job runs")
	minFree := fs.String("min-free", "", "minimum free disk bytes required for admission")
	cost := fs.String("cost", "light", "expected resource cost class: light or heavy")
	costKey := fs.String("cost-key", "", "key used to learn completed run resource costs")
	priority := fs.Int("priority", 0, "run priority; lower values are paused first under hard pressure")
	stall := fs.Duration("stall", defaultAgentStall, "fail the job after this no-output interval")
	fiveHour := fs.Float64("five-hour-threshold", 95, "quota admission threshold")
	week := fs.Float64("week-threshold", 98, "weekly quota admission threshold")
	providerFailureThreshold := fs.Int("provider-failure-threshold", 3, "consecutive transient provider errors before recording a sustained outage")
	testChannel := fs.String("test-channel", "on", "outside Go test channel: on or off")
	var writable pathListFlag
	fs.Var(&writable, "add-dir", "additional writable directory (repeatable)")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if *stream == "" || *workdir == "" || *promptFile == "" {
		return 2, fmt.Errorf("%s agent start: --stream, --workdir, and --prompt-file are required; next: %s agent --help", root.Name(), root.InvocationCommand())
	}
	if *testChannel != "on" && *testChannel != "off" {
		return 2, fmt.Errorf("%s agent start: --test-channel must be on or off; next: %s agent start --help", root.Name(), root.InvocationCommand())
	}
	resolvedState, err := resolveRunnerState(root, "agent start", *state)
	if err != nil {
		return 2, fmt.Errorf("%s agent start: invalid runner state path: %w; next: %s agent start --help", root.Name(), err, root.InvocationCommand())
	}
	*state = resolvedState
	costClass, err := proc.ParseCostClass(*cost)
	if err != nil {
		return 2, fmt.Errorf("%s agent start: %w; next: %s agent start --help", root.Name(), err, root.InvocationCommand())
	}
	if *slotGroup == "" {
		*slotGroup = *vendor
	}
	if *jobID == "" {
		id, err := newJobID(*stream)
		if err != nil {
			return 1, err
		}
		store := newJobStore(*state)
		if _, err := store.List(); err != nil {
			return 1, fmt.Errorf("agent start: reconcile prior jobs before admission: %w", err)
		}
		finalPath := *message
		if finalPath == "" {
			finalPath = filepath.Join(*state, "jobs", id+".last.md")
		}
		if _, err := store.Create(Job{ID: id, Stream: *stream, Vendor: *vendor, Model: *model, State: JobQueued, Phase: PhaseWorktree, SlotGroup: *slotGroup, SlotCeiling: *slots, MessagePath: finalPath}); err != nil {
			return 1, err
		}
		if *testChannel == "on" {
			spool := testChannelSpool(*state, id)
			if err := os.MkdirAll(spool, 0o700); err != nil {
				return failAgentJob(store, id, PhaseWorktree, ReasonSetup, root, finalPath, fmt.Errorf("create outside test request spool: %w", err))
			}
		}
		minFreeBytes := uint64(0)
		if *minFree != "" {
			minFreeBytes, err = strconv.ParseUint(*minFree, 10, 64)
			if err != nil {
				return failAgentJob(store, id, PhaseAdmission, ReasonSetup, root, finalPath, fmt.Errorf("invalid --min-free bytes: %w", err))
			}
		}
		helper, err := root.executablePath()
		if err != nil {
			return failAgentJob(store, id, PhaseWorktree, ReasonSetup, root, finalPath, fmt.Errorf("locate agent process owner: %w", err))
		}
		argsForWorker := append([]string{"__agent_worker", "--job-id", id}, args...)
		workerEnv, envErr := vendorWorkerEnvironment(*vendor)
		if envErr != nil {
			var keyErr zaiKeyFileError
			if errors.As(envErr, &keyErr) {
				return failZaiKeySetup(store, id, root, finalPath, envErr)
			}
			return failAgentJob(store, id, PhaseWorktree, ReasonSetup, root, finalPath, envErr)
		}
		stdoutPath := filepath.Join(*state, "jobs", id+".stdout.log")
		stderrPath := filepath.Join(*state, "jobs", id+".stderr.log")
		leasePaths, err := runnerWorktreeLeasePaths(*workdir)
		if err != nil {
			return failAgentJob(store, id, PhaseAdmission, ReasonSetup, root, finalPath, fmt.Errorf("resolve agent worktree lease: %w", err))
		}
		run, err := root.jobSupervisor().Start(ctx, proc.Config{StateDir: *state, Tag: "agent:" + id, LatestTag: "agent:" + *stream, Stall: *stall, StdoutPath: stdoutPath, StderrPath: stderrPath, SlotGroup: *slotGroup, Slots: *slots, WaitGate: *waitGate, HoldGate: *holdGate, MinFree: minFreeBytes, CostKey: *costKey, CostClass: costClass, Priority: *priority, CleanEnv: true, Env: workerEnv, Keep: []string{stdoutPath, stderrPath}, SharedLeasePaths: leasePaths, Command: append([]string{helper}, argsForWorker...)})
		if err != nil {
			return failAgentJob(store, id, PhaseAdmission, ReasonSetup, root, finalPath, fmt.Errorf("agent process admission failed: %w", err))
		}
		waitErr := run.Wait()
		if job, getErr := store.Get(id); getErr == nil && job.Final == nil {
			terminalState, reason := JobFailed, ReasonVendorError
			if ctx.Err() != nil {
				terminalState, reason = JobCancelled, ReasonNone
			} else if waitErr != nil {
				var exitErr *exec.ExitError
				if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 137 {
					terminalState, reason = JobStalled, ReasonStall
				} else {
					terminalState, reason = JobLost, ReasonProcessLost
				}
			}
			if err := store.Terminate(id, JobTerminal{State: terminalState, Phase: job.Phase, Reason: reason, Next: root.InvocationCommand() + " status --json", MessagePath: finalPath, SessionID: job.SessionID}); err != nil {
				return 1, fmt.Errorf("agent process ended but terminal job record could not be persisted: %w", err)
			}
		}
		if waitErr != nil {
			return 1, agentProcessFailure(store, id, waitErr, root)
		}
		_, err = fmt.Fprintf(out, "job %s completed\n", id)
		return 0, err
	}
	adapter, err := newAdapter(*vendor)
	if err != nil {
		return 2, zaiKeyDiagnostic(root, err)
	}
	prompt, err := os.ReadFile(*promptFile)
	if err != nil {
		return 1, fmt.Errorf("agent start: read prompt: %w", err)
	}
	id := *jobID
	store := newJobStore(*state)
	logs := filepath.Join(*state, "jobs", id+".jsonl")
	finalPath := *message
	if finalPath == "" {
		finalPath = filepath.Join(*state, "jobs", id+".last.md")
	}
	spool := ""
	if *testChannel == "on" {
		spool = testChannelSpool(*state, id)
		if err := os.MkdirAll(spool, 0o700); err != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("create outside test request spool: %w", err))
		}
	}
	workerIdentity, workerAlive, identityErr := proc.ProcessIdentity(os.Getpid())
	if identityErr != nil {
		return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("inspect agent worker identity: %w", identityErr))
	}
	if !workerAlive {
		return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, errors.New("agent worker process identity is not live"))
	}
	runID := proc.CurrentRunID()
	if err := store.Update(id, func(job *Job) error {
		if runID != "" {
			job.RunID = runID
		}
		job.WorkerPID = os.Getpid()
		job.WorkerStartedAt = workerIdentity
		return nil
	}); err != nil {
		return 1, fmt.Errorf("record agent worker identity: %w", err)
	}
	phases := []struct {
		phase   JobPhase
		command string
	}{{PhaseWorktree, *setup}, {PhaseInstall, *install}, {PhaseBuild, *build}}
	for _, phase := range phases {
		if *recoveryAttempt > 0 {
			break
		}
		if phase.command == "" {
			continue
		}
		if err = store.Update(id, func(j *Job) error { j.State = JobRunning; j.Phase = phase.phase; return nil }); err != nil {
			return 1, err
		}
		cmd := exec.Command("/bin/sh", "-c", phase.command)
		cmd.Dir = *workdir
		cmd.Env, err = vendorChildEnvironment(*vendor)
		if err != nil {
			return failAgentJob(store, id, phase.phase, ReasonSetup, root, finalPath, fmt.Errorf("build %s child environment: %w", phase.phase, err))
		}
		output, e := cmd.CombinedOutput()
		if logErr := appendJobEvent(logs, map[string]any{"phase": phase.phase, "output": string(output), "time": time.Now().UTC()}); logErr != nil {
			return failAgentJob(store, id, phase.phase, ReasonSetup, root, finalPath, fmt.Errorf("record phase output: %w", logErr))
		}
		if e != nil {
			reason := ReasonSetup
			return failAgentJob(store, id, phase.phase, reason, root, finalPath, fmt.Errorf("agent job %s failed in %s: %s", id, phase.phase, exitSummary(e)))
		}
	}
	if *recoveryAttempt == 0 {
		if err = store.Update(id, func(j *Job) error { j.State = JobRunning; j.Phase = PhaseAdmission; return nil }); err != nil {
			return 1, err
		}
		limitCtx, limitCancel := context.WithTimeout(context.Background(), 10*time.Second)
		limits, limitErr := adapter.Limits(limitCtx)
		limitCancel()
		if limitErr != nil {
			limits = nil
		}
		if err := waitForQuotaAdmission(context.Background(), limits, adapter, store, id, *fiveHour, *week, realQuotaAdmissionClock{}); err != nil {
			return failAgentJob(store, id, PhaseAdmission, ReasonQuota, root, finalPath, err)
		}
	}
	if err = store.Update(id, func(j *Job) error { j.State = JobRunning; j.Phase = PhaseRun; return nil }); err != nil {
		return 1, err
	}
	if err = store.Update(id, func(job *Job) error {
		job.Attempts = append(job.Attempts, ProviderAttempt{Number: *recoveryAttempt + 1, StartedAt: time.Now().UTC(), SessionID: *session, Outcome: "running"})
		return nil
	}); err != nil {
		return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("record provider attempt: %w", err))
	}
	req := AgentRequest{Prompt: string(prompt), Workdir: *workdir, Effort: *effort, Model: *model, SessionID: *session, WritableDirs: writable, TestChannelSpool: spool, FinalPath: finalPath, StateDir: *state, JobID: id}
	channelContext, stopTestChannel := context.WithCancel(context.Background())
	channelErrors := make(chan error, 1)
	if spool != "" {
		broker := &testChannelBroker{state: *state, jobID: id, stream: *stream, worktree: *workdir, spool: spool, executor: newTestChannelExecutor()}
		go func() { channelErrors <- broker.serve(channelContext) }()
	}
	defer stopTestChannel()
	var cmd *exec.Cmd
	if *session != "" {
		cmd, err = adapter.Resume(context.Background(), req)
	} else {
		cmd, err = adapter.Start(context.Background(), req)
	}
	if err != nil {
		closeErr := closeProviderAttempt(store, id, *session, "failed", ReasonVendorError, attemptUsageFor(*vendor, "failed"))
		if closeErr != nil {
			err = errors.Join(err, fmt.Errorf("record failed provider attempt: %w", closeErr))
		}
		var sandboxErr zcodeSandboxError
		if errors.As(err, &sandboxErr) {
			return failZcodeSandboxJob(store, id, root, finalPath, err)
		}
		return failAgentJob(store, id, PhaseRun, ReasonVendorError, root, finalPath, fmt.Errorf("agent job %s could not start provider: %v", id, err))
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		if closeErr := closeProviderAttempt(store, id, *session, "failed", ReasonVendorError, attemptUsageFor(*vendor, "failed")); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("record failed provider attempt: %w", closeErr))
		}
		return failAgentJob(store, id, PhaseRun, ReasonVendorError, root, finalPath, err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		if closeErr := closeProviderAttempt(store, id, *session, "failed", ReasonVendorError, attemptUsageFor(*vendor, "failed")); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("record failed provider attempt: %w", closeErr))
		}
		return failAgentJob(store, id, PhaseRun, ReasonVendorError, root, finalPath, err)
	}
	health := newHealthTracker(*providerFailureThreshold)
	failures := vendorRegistry[*vendor].failures
	var final strings.Builder
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var scanErr error
	var streamFailure vendorFailure
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		event, e := health.Observe(*vendor, line)
		if e != nil {
			scanErr = fmt.Errorf("parse provider event: %w", e)
			break
		}
		event.Message = adapter.Redact(event.Message)
		event.FinalMessage = adapter.Redact(event.FinalMessage)
		event.SessionID = adapter.Redact(event.SessionID)
		event.Tool = adapter.Redact(event.Tool)
		if logErr := appendJobEvent(logs, event); logErr != nil {
			scanErr = logErr
			break
		}
		if updateErr := store.Update(id, func(j *Job) error {
			j.LastActivity = time.Now().UTC()
			if event.SessionID != "" {
				j.SessionID = event.SessionID
			}
			if event.Kind == EventUsage || (vendorRegistry[*vendor].limitsMode == vendorLimitsLedger && event.Kind == EventFinal && (event.InputTokens != 0 || event.OutputTokens != 0)) {
				if vendorRegistry[*vendor].limitsMode == vendorLimitsLedger {
					j.InputTokens += event.InputTokens
					j.OutputTokens += event.OutputTokens
					j.Tokens = j.InputTokens + j.OutputTokens
				} else if event.Tokens != 0 {
					j.Tokens = event.Tokens
				}
			}
			return nil
		}); updateErr != nil {
			scanErr = updateErr
			break
		}
		if event.Kind == EventFinal {
			if event.FinalMessage != "" {
				final.WriteString(event.FinalMessage)
			}
			// The vendor recovered after an earlier failure event: the run
			// completed, so the failure no longer decides the outcome.
			streamFailure = unrelatedFailure
			if updateErr := store.Update(id, func(j *Job) error {
				if j.State == JobPaused {
					j.State = JobRunning
					j.Reason = ReasonNone
				}
				return nil
			}); updateErr != nil {
				scanErr = updateErr
				break
			}
			continue
		}
		failure := failures.classify(event)
		if failure.class == failureUnrelated {
			continue
		}
		streamFailure = failure
		if updateErr := store.Update(id, func(j *Job) error {
			j.Reason = failure.reason
			if failure.class == failureTransient {
				j.State = JobPaused
			}
			return nil
		}); updateErr != nil {
			scanErr = updateErr
			break
		}
	}
	if e := scanner.Err(); e != nil {
		scanErr = fmt.Errorf("read provider event stream: %w", e)
	}
	if scanErr != nil {
		killErr := cmd.Process.Kill()
		if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			scanErr = errors.Join(scanErr, fmt.Errorf("stop provider after stream failure: %w", killErr))
		}
	}
	waitErr := cmd.Wait()
	stopTestChannel()
	if spool != "" {
		if channelErr := <-channelErrors; channelErr != nil {
			waitErr = errors.Join(waitErr, fmt.Errorf("outside test channel broker failed: %w", channelErr))
		}
	}
	if scanErr != nil {
		waitErr = errors.Join(waitErr, scanErr)
	}
	completedJob, getErr := store.Get(id)
	if getErr != nil {
		return 1, getErr
	}
	failure := streamFailure
	if failure.class == failureUnrelated {
		if classified, ok := failures.classifyStderr(adapter.Redact(stderr.String())); ok {
			failure = classified
		}
	}
	if failure.resetAt != nil {
		if _, err := newVendorLimitStateStore(*state, time.Now).Record(*vendor, *failure.resetAt, adapter.Redact(failure.message)); err != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("record vendor limit reset: %w", err))
		}
	}
	if waitErr != nil && failure.class == failureTransient && completedJob.SessionID != "" && *recoveryAttempt < maxProviderRecoveryAttempts {
		nextAttempt := *recoveryAttempt + 1
		if updateErr := closeProviderAttempt(store, id, completedJob.SessionID, "paused", failure.reason, attemptUsageFor(*vendor, "paused")); updateErr != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("record paused provider attempt: %w", updateErr))
		}
		if err := store.Update(id, func(job *Job) error {
			job.State = JobPaused
			job.Reason = failure.reason
			return nil
		}); err != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("record paused provider state: %w", err))
		}
		if err := waitForProviderRecovery(context.Background(), adapter, *vendor, failure.reason, nextAttempt, *fiveHour, *week, failure.resetAt); err != nil {
			return failAgentJob(store, id, PhaseRun, failure.reason, root, finalPath, err)
		}
		retryArgs, err := continuationRetryArgs(root, args, *state, id, completedJob.SessionID, nextAttempt)
		if err != nil {
			return failAgentJob(store, id, PhaseRun, failure.reason, root, finalPath, err)
		}
		return agentStartCommand(root, retryArgs, out, errOut)
	}
	if waitErr == nil {
		if updateErr := closeProviderAttempt(store, id, completedJob.SessionID, "ok", ReasonNone, attemptUsageFor(*vendor, "ok")); updateErr != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, fmt.Errorf("record completed provider attempt: %w", updateErr))
		}
	}
	if waitErr == nil {
		if e := os.MkdirAll(filepath.Dir(finalPath), 0700); e != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, e)
		}
		if _, statErr := os.Stat(finalPath); errors.Is(statErr, os.ErrNotExist) {
			if e := os.WriteFile(finalPath, []byte(final.String()), 0600); e != nil {
				return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, e)
			}
		} else if statErr != nil {
			return failAgentJob(store, id, PhaseRun, ReasonSetup, root, finalPath, statErr)
		}
		if completedJob.State == JobPaused {
			err = store.Terminate(id, JobTerminal{State: JobFailed, Phase: PhaseRun, Reason: completedJob.Reason, Next: root.InvocationCommand() + " status --json", MessagePath: finalPath, SessionID: completedJob.SessionID})
		} else {
			err = store.Terminate(id, JobTerminal{State: JobOK, Phase: PhaseRun, Next: root.InvocationCommand() + " status", MessagePath: finalPath, SessionID: completedJob.SessionID})
		}
	} else {
		terminalState := JobFailed
		reason := ReasonVendorError
		if errors.Is(waitErr, context.DeadlineExceeded) {
			terminalState = JobStalled
			reason = ReasonStall
		} else if failure.class != failureUnrelated {
			reason = failure.reason
		}
		diagnostic := providerFailureDetail(exitSummary(waitErr), adapter.Redact(stderr.String()))
		if failure.class == failureTransient && terminalState == JobFailed {
			resumeNext, resumeErr := manualResumeCommand(root, args, *state, id, completedJob.SessionID)
			if resumeErr != nil {
				diagnostic = fmt.Sprintf("transient provider failure persisted after %d recovery attempts and the continuation prompt could not be written: %v; %s", maxProviderRecoveryAttempts, resumeErr, diagnostic)
			} else {
				diagnostic = fmt.Sprintf("transient provider failure persisted after %d recovery attempts; resume the session manually:\n%s\n%s", maxProviderRecoveryAttempts, resumeNext, diagnostic)
			}
		}
		if updateErr := closeProviderAttempt(store, id, completedJob.SessionID, "failed", reason, attemptUsageFor(*vendor, "failed")); updateErr != nil {
			diagnostic = providerFailureDetail(fmt.Sprintf("%v; also could not record the failed provider attempt: %v", waitErr, updateErr), adapter.Redact(stderr.String()))
		}
		err = store.Terminate(id, JobTerminal{State: terminalState, Phase: PhaseRun, Reason: reason, Error: diagnostic, Next: root.InvocationCommand() + " status", MessagePath: finalPath, SessionID: completedJob.SessionID})
	}
	if err != nil {
		return 1, err
	}
	if waitErr != nil {
		return 1, fmt.Errorf("agent job %s ended in %s: %s; next: %s status", id, PhaseRun, providerFailureDetail(exitSummary(waitErr), adapter.Redact(stderr.String())), root.InvocationCommand())
	}
	_, err = fmt.Fprintf(out, "job %s ok\n", id)
	return 0, err
}

// continuationRetryArgs builds the worker command line for a resume: the same
// invocation with the prompt replaced by the fixed continuation prompt file,
// the recorded session, and the next recovery attempt number.
func continuationRetryArgs(root runnerRoot, args []string, state, id, sessionID string, nextAttempt int) ([]string, error) {
	continuePath, err := writeContinuationPrompt(state, id)
	if err != nil {
		return nil, err
	}
	retryArgs := replaceFlagValue(args, "prompt-file", continuePath)
	return append(retryArgs, "--session", sessionID, "--recovery-attempt", strconv.Itoa(nextAttempt)), nil
}

// manualResumeCommand renders the exact command an operator runs to resume a
// session whose automatic recovery attempts are exhausted.
func manualResumeCommand(root runnerRoot, args []string, state, id, sessionID string) (string, error) {
	continuePath, err := writeContinuationPrompt(state, id)
	if err != nil {
		return "", err
	}
	resumeArgs := replaceFlagValue(args, "prompt-file", continuePath)
	if sessionID != "" {
		resumeArgs = append(resumeArgs, "--session", sessionID)
	}
	return shellJoin(append([]string{root.Invocation(), "agent", "start"}, resumeArgs...)), nil
}

func writeContinuationPrompt(state, id string) (string, error) {
	continuePath := filepath.Join(state, "jobs", id+".continue.md")
	if err := os.MkdirAll(filepath.Dir(continuePath), 0700); err != nil {
		return "", fmt.Errorf("write continuation prompt: %w", err)
	}
	if err := os.WriteFile(continuePath, []byte(providerContinuationPrompt), 0o600); err != nil {
		return "", fmt.Errorf("write continuation prompt: %w", err)
	}
	return continuePath, nil
}

// replaceFlagValue rewrites the value of a flag in a command line, accepting
// both "--name value" and "--name=value" spellings.
func replaceFlagValue(args []string, name, value string) []string {
	replaced := append([]string(nil), args...)
	for index := 0; index < len(replaced); index++ {
		arg := replaced[index]
		if arg == "--"+name && index+1 < len(replaced) {
			replaced[index+1] = value
			index++
			continue
		}
		if strings.HasPrefix(arg, "--"+name+"=") {
			replaced[index] = "--" + name + "=" + value
		}
	}
	return replaced
}

// closeProviderAttempt closes the in-flight provider attempt with its outcome
// and spend accounting.
func closeProviderAttempt(store *jobStore, id, sessionID, outcome string, reason JobReason, usage string) error {
	return store.Update(id, func(job *Job) error {
		if len(job.Attempts) == 0 {
			return fmt.Errorf("job %q has no provider attempt to close", id)
		}
		attempt := &job.Attempts[len(job.Attempts)-1]
		attempt.FinishedAt = time.Now().UTC()
		attempt.SessionID = sessionID
		attempt.Reason = reason
		attempt.Outcome = outcome
		attempt.Usage = usage
		return nil
	})
}

// attemptUsageFor resolves the spend accounting of a closed attempt: vendors
// that stream usage before the final result always record what they observed;
// the rest expose no usage for an attempt that never produced one.
func attemptUsageFor(vendor, outcome string) string {
	if outcome == "ok" || vendorRegistry[vendor].usageOnFailure == usagePartialOnFailure {
		return attemptUsageRecorded
	}
	return attemptUsageUnknown
}

func agentProcessFailure(store *jobStore, id string, waitErr error, root runnerRoot) error {
	detail := exitSummary(waitErr)
	job, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("agent job %s failed under process owner: %s; terminal diagnostic unavailable: %w; next: %s status --json", id, detail, err, root.InvocationCommand())
	}
	if job.Final != nil && job.Final.Error != "" {
		detail = job.Final.Error
	}
	return fmt.Errorf("agent job %s failed under process owner: %s; next: %s status --json", id, detail, root.InvocationCommand())
}

func providerFailureDetail(summary, stderr string) string {
	const maxTailBytes = 4096
	tail := strings.TrimSpace(stderr)
	if len(tail) > maxTailBytes {
		tail = strings.ToValidUTF8(tail[len(tail)-maxTailBytes:], "�")
	}
	if tail == "" {
		return summary
	}
	return summary + "\nstderr tail:\n" + tail
}

func failAgentJob(store *jobStore, id string, phase JobPhase, reason JobReason, root runnerRoot, messagePath string, cause error) (int, error) {
	next := root.InvocationCommand() + " status --state " + shellQuote(filepath.Dir(store.dir)) + " --json"
	terminalErr := store.Terminate(id, JobTerminal{State: JobFailed, Phase: phase, Reason: reason, Next: next, MessagePath: messagePath})
	if terminalErr != nil {
		return 1, fmt.Errorf("%v; also could not persist terminal job record: %w; next: %s", cause, terminalErr, next)
	}
	return 1, fmt.Errorf("%v; next: %s", cause, next)
}

type quotaAdmissionClock interface {
	Now() time.Time
	WaitUntil(context.Context, time.Time) error
}

type realQuotaAdmissionClock struct{}

func (realQuotaAdmissionClock) Now() time.Time { return time.Now() }

func (realQuotaAdmissionClock) WaitUntil(ctx context.Context, deadline time.Time) error {
	delay := time.Until(deadline)
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func waitForQuotaAdmission(ctx context.Context, limits []VendorLimit, provider limitsProvider, store *jobStore, id string, fiveHour, week float64, clock quotaAdmissionClock) error {
	job, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("read job before quota admission: %w", err)
	}
	limitStore := newVendorLimitStateStore(filepath.Dir(store.dir), clock.Now)
	limits, err = limitsWithRecordedVendorState(limits, limitStore, job.Vendor)
	if err != nil {
		return fmt.Errorf("read recorded vendor limit: %w", err)
	}
	for quotaBlocked(limits, fiveHour, week) {
		if err := store.Update(id, func(job *Job) error {
			job.State = JobQuotaWait
			job.Phase = PhaseAdmission
			job.Reason = ReasonQuota
			return nil
		}); err != nil {
			return fmt.Errorf("persist quota-wait state: %w", err)
		}
		reset := nextBlockedReset(limits, fiveHour, week)
		if reset == nil {
			return nil
		}
		for clock.Now().Before(*reset) {
			if err := clock.WaitUntil(ctx, *reset); err != nil {
				return err
			}
		}
		probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		refreshed, err := provider.Limits(probeCtx)
		cancel()
		if err != nil {
			return nil
		}
		limits, err = limitsWithRecordedVendorState(refreshed, limitStore, job.Vendor)
		if err != nil {
			return fmt.Errorf("refresh recorded vendor limit: %w", err)
		}
	}
	return store.Update(id, func(job *Job) error {
		job.State = JobRunning
		job.Phase = PhaseAdmission
		job.Reason = ReasonNone
		return nil
	})
}

func nextBlockedReset(limits []VendorLimit, fiveHour, week float64) *time.Time {
	var next *time.Time
	for _, limit := range limits {
		blocked := limit.Blocked || (limit.Window == "5h" && limit.UsedPercent >= fiveHour) || (limit.Window == "week" && limit.UsedPercent >= week)
		if !blocked || limit.Confidence != "vendor" || limit.ResetsAt == nil {
			continue
		}
		if next == nil || limit.ResetsAt.Before(*next) {
			value := *limit.ResetsAt
			next = &value
		}
	}
	return next
}

func waitForProviderRecovery(ctx context.Context, adapter AgentAdapter, vendor string, reason JobReason, attempt int, fiveHour, week float64, recordedReset *time.Time) error {
	delay := time.Duration(1<<min(attempt-1, 5)) * time.Second
	if reason == ReasonRateLimited {
		var reset *time.Time
		if recordedReset != nil {
			value := *recordedReset
			reset = &value
		}
		limits, err := adapter.Limits(ctx)
		if err == nil {
			if providerReset := nextBlockedReset(limits, fiveHour, week); providerReset != nil && (reset == nil || providerReset.After(*reset)) {
				reset = providerReset
			}
		}
		if reset != nil && time.Until(*reset) > delay {
			delay = time.Until(*reset)
		}
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
	if vendorRegistry[vendor].limitsMode != vendorLimitsAppServer {
		// The vendor exposes no vendor-confidence limits source, so there is
		// nothing to probe: the increasing backoff is the recovery wait.
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
	for probe := 0; probe < 3; probe++ {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		limits, err := adapter.Limits(ctx)
		if err == nil {
			for _, limit := range limits {
				if limit.Confidence == "vendor" {
					return nil
				}
			}
		}
		delay = min(delay*2, 30*time.Second)
	}
	return errors.New("provider recovery probes remained unavailable after three attempts")
}

func newJobID(stream string) (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	safe := strings.NewReplacer("/", "-", "\\", "-", " ", "-").Replace(stream)
	return fmt.Sprintf("%s-%s", safe, hex.EncodeToString(b[:])), nil
}
func appendJobEvent(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	encodeErr := json.NewEncoder(f).Encode(value)
	closeErr := f.Close()
	if encodeErr != nil {
		return encodeErr
	}
	return closeErr
}
func exitSummary(err error) string {
	var e *exec.ExitError
	if errors.As(err, &e) {
		return fmt.Sprintf("provider command exited with code %d", e.ExitCode())
	}
	return "provider command failed"
}
