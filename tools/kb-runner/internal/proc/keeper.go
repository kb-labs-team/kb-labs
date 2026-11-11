//go:build darwin || linux

package proc

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/proc/child"
)

const (
	stallCheckInterval     = 200 * time.Millisecond
	metricSampleInterval   = 5 * time.Second
	governorSampleInterval = 2 * time.Second
)

type activityWriter struct {
	file     *os.File
	terminal *os.File
	activity *atomic.Int64
}

func (writer activityWriter) Write(data []byte) (int, error) {
	writer.activity.Store(time.Now().UnixNano())
	if err := writeOutput(writer.file, data); err != nil {
		return 0, err
	}
	if writer.terminal != nil {
		if err := writeOutput(writer.terminal, data); err != nil {
			return 0, err
		}
	}
	return len(data), nil
}

func runKeeper(cfg keeperConfig) int {
	ready := os.NewFile(3, "proc-ready")
	if ready == nil {
		return 2
	}
	launcher := os.NewFile(4, "proc-launcher-lifetime")
	if launcher == nil {
		if err := ready.Close(); err != nil {
			fmt.Fprintln(os.Stderr, "proc: close readiness pipe without launcher lifetime descriptor:", err)
		}
		return 2
	}
	defer func() {
		if err := launcher.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			fmt.Fprintln(os.Stderr, "proc: close launcher lifetime pipe:", err)
		}
	}()
	parentGone, monitorErr := monitorLauncher(cfg.ParentPID, cfg.ParentIdentity, launcher)
	return runKeeperWithMonitor(cfg, ready, parentGone, monitorErr)
}

func runKeeperWithReady(cfg keeperConfig, ready *os.File) int {
	parentGone, monitorErr := monitorParent(cfg.ParentPID, cfg.ParentIdentity)
	return runKeeperWithMonitor(cfg, ready, parentGone, monitorErr)
}

type runRecordWriter interface {
	Write(record) error
}

type durableRunRecordWriter struct{}

func (durableRunRecordWriter) Write(rec record) error { return writeRecord(rec) }

func runKeeperWithReadyAndRecordWriter(cfg keeperConfig, ready *os.File, writer runRecordWriter) int {
	parentGone, monitorErr := monitorParent(cfg.ParentPID, cfg.ParentIdentity)
	return runKeeperWithMonitorAndRecordWriter(cfg, ready, parentGone, monitorErr, writer)
}

func runKeeperWithMonitor(cfg keeperConfig, ready *os.File, parentGone <-chan error, monitorErr error) int {
	return runKeeperWithMonitorAndRecordWriter(cfg, ready, parentGone, monitorErr, durableRunRecordWriter{})
}

func runKeeperWithMonitorAndRecordWriter(cfg keeperConfig, ready *os.File, parentGone <-chan error, monitorErr error, writer runRecordWriter) int {
	// The readiness descriptor belongs only to the keeper. Prevent commands
	// started below this boundary from inheriting it across exec.
	syscall.CloseOnExec(int(ready.Fd()))
	defer func() {
		if ready != nil {
			if err := ready.Close(); err != nil {
				fmt.Fprintln(os.Stderr, "proc: close readiness pipe:", err)
			}
		}
	}()
	if monitorErr != nil {
		writeReadyError(ready, monitorErr)
		return 1
	}
	if err := prepareKeeperPlatform(); err != nil {
		writeReadyError(ready, err)
		return 1
	}
	defer func() {
		if err := finishKeeperPlatform(); err != nil {
			fmt.Fprintln(os.Stderr, "proc: restore keeper platform state:", err)
		}
	}()
	if err := os.MkdirAll(liveRecordsDir(cfg.StateDir), 0o700); err != nil {
		writeReadyError(ready, err)
		return 1
	}
	scratch, err := runScratchPath(cfg.RunID)
	if err != nil {
		writeReadyError(ready, err)
		return 1
	}
	// The run directory contains the durable run record and owned scratch.
	runDirectory := filepath.Join(cfg.StateDir, "runs", cfg.RunID)
	runDirectoryIdentity, runDirectoryOwned, err := createOwnedDirectory(runDirectory, unixScratchDirectoryOps{})
	if err != nil {
		var cleanupErr error
		if runDirectoryOwned {
			cleanupErr = removeOwnedPathRelative(cfg.StateDir, runDirectory, runDirectoryIdentity, "", nil)
		}
		writeReadyError(ready, errors.Join(fmt.Errorf("create run directory: %w", err), cleanupErr))
		return 1
	}
	scratchIdentity, scratchOwned, err := createOwnedDirectory(scratch, unixScratchDirectoryOps{})
	if err != nil {
		cleanupErr := removeOwnedPathRelative(cfg.StateDir, runDirectory, runDirectoryIdentity, "", nil)
		if scratchOwned {
			cleanupErr = errors.Join(cleanupErr, removeScratchPathRelative(cfg.StateDir, scratch, scratchIdentity, nil))
		}
		writeReadyError(ready, errors.Join(fmt.Errorf("create run scratch directory: %w", err), cleanupErr))
		return 1
	}
	if err := inspectCreatedScratch(cfg.StateDir, scratch, scratchIdentity); err != nil {
		cleanupErr := removeOwnedPathRelative(cfg.StateDir, runDirectory, runDirectoryIdentity, "", nil)
		writeReadyError(ready, errors.Join(err, cleanupErr))
		return 1
	}
	cfg.Keep = resolveKeepPaths(scratch, cfg.Keep)
	rec := record{RunID: cfg.RunID, Tag: cfg.Tag, PID: os.Getpid(), Command: cfg.Command, StateDir: cfg.StateDir, Status: StatusStarting, Scratch: scratch, ScratchDevice: scratchIdentity.Device, ScratchInode: scratchIdentity.Inode, Keep: append([]string(nil), cfg.Keep...), CostClass: cfg.CostClass,
		ProtectedAncestors: []ProcessIdentityEvidence{{PID: cfg.ParentPID, Identity: cfg.ParentIdentity}}}
	runToken, err := createRunToken(scratch)
	if err != nil {
		return keeperError(rec, "create run ownership token", err)
	}
	runTokenReleased := false
	runTokenClosed := false
	closeRunToken := func() error {
		if runTokenClosed {
			return nil
		}
		if err := runToken.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			return err
		}
		runTokenClosed = true
		return nil
	}
	defer func() {
		if runTokenReleased {
			return
		}
		if err := closeRunToken(); err != nil {
			fmt.Fprintln(os.Stderr, "proc: close run ownership token:", err)
		}
		if err := removeRunToken(cfg.RunID); err != nil {
			fmt.Fprintln(os.Stderr, "proc: remove run ownership token:", err)
		}
	}()
	startedAt, ok, identityErr := ProcessIdentity(os.Getpid())
	if identityErr != nil {
		return keeperError(rec, "inspect keeper process identity", identityErr)
	}
	if !ok {
		writeReadyError(ready, errors.New("cannot determine keeper process start identity"))
		return keeperError(rec, "inspect keeper process identity", errors.New("cannot determine keeper process start identity"))
	}
	rec.StartedAt = startedAt
	rec.LatestTag = cfg.LatestTag
	if err := writer.Write(rec); err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "record run", err)
	}
	if err := claimGate(cfg.StateDir, cfg.RunID, cfg.HoldGate, rec.PID, rec.StartedAt); err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "claim held gate", err)
	}
	stdout, err := openOutput(cfg.StdoutPath)
	if err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "open stdout", err)
	}
	defer func() {
		if err := stdout.Close(); err != nil {
			fmt.Fprintln(os.Stderr, "proc: close stdout log:", err)
		}
	}()
	stderr, err := openOutput(cfg.StderrPath)
	if err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "open stderr", err)
	}
	defer func() {
		if err := stderr.Close(); err != nil {
			fmt.Fprintln(os.Stderr, "proc: close stderr log:", err)
		}
	}()

	cmd := exec.Command(cfg.Command[0], cfg.Command[1:]...)
	cmd.Dir = cfg.Dir
	cmd.Env = environmentFor(cfg.Config, os.Environ())
	// ExtraFiles is the only inheritance path for the close-on-exec token.
	cmd.ExtraFiles = []*os.File{runToken}
	if err := configureCommand(cmd, cfg.Config, cfg.RunID, cfg.StateDir, scratch); err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "configure command", err)
	}
	if cfg.StdinPath != "" {
		stdin, err := os.Open(cfg.StdinPath)
		if err != nil {
			writeReadyError(ready, fmt.Errorf("open command stdin %s: %w", cfg.StdinPath, err))
			return keeperError(rec, "open command stdin", err)
		}
		defer func() {
			if err := stdin.Close(); err != nil {
				fmt.Fprintln(os.Stderr, "proc: close command stdin:", err)
			}
		}()
		cmd.Stdin = stdin
	}
	stdoutPipe, stdoutWriter, err := os.Pipe()
	if err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "create stdout pipe", err)
	}
	defer stdoutPipe.Close()
	defer stdoutWriter.Close()
	stderrPipe, stderrWriter, err := os.Pipe()
	if err != nil {
		writeReadyError(ready, err)
		return keeperError(rec, "create stderr pipe", err)
	}
	defer stderrPipe.Close()
	defer stderrWriter.Close()
	var lastOutput atomic.Int64
	rec.StartedAtTime = cfg.RunStartedAt
	if rec.StartedAtTime.IsZero() {
		rec.StartedAtTime = time.Now().UTC()
	}
	lastOutput.Store(rec.StartedAtTime.UnixNano())
	cmd.Stdout = stdoutWriter
	cmd.Stderr = stderrWriter
	limitsAdvisory, cleanupLimits, startErr := startWithRunLimits(cfg.Config, cfg.RunID, cmd)
	defer cleanupLimits()
	if startErr != nil {
		writeReadyError(ready, startErr)
		return keeperError(rec, "start command", startErr)
	}
	// Keep the token only in the supervised command after Start returns.
	if err := closeRunToken(); err != nil {
		if killErr := child.KillStartedProcess(cmd.Process); killErr != nil {
			fmt.Fprintln(os.Stderr, "proc: stop command after run token close failure:", killErr)
		}
		if waitErr := cmd.Wait(); waitErr != nil {
			fmt.Fprintln(os.Stderr, "proc: wait after run token close failure:", waitErr)
		}
		writeReadyError(ready, fmt.Errorf("close keeper copy of run ownership token: %w", err))
		return keeperErrorWithDirectChild(rec, "close keeper run token after command start", err, cmd.Process)
	}
	commandIdentity, commandAlive, commandIdentityErr := ProcessIdentity(cmd.Process.Pid)
	if commandIdentityErr != nil {
		if killErr := child.KillStartedProcess(cmd.Process); killErr != nil {
			fmt.Fprintln(os.Stderr, "proc: stop command after identity observation failure:", killErr)
		}
		if waitErr := cmd.Wait(); waitErr != nil {
			fmt.Fprintln(os.Stderr, "proc: wait after identity observation failure:", waitErr)
		}
		writeReadyError(ready, fmt.Errorf("observe started command PID %d: %w", cmd.Process.Pid, commandIdentityErr))
		return keeperErrorWithDirectChild(rec, "observe started command", commandIdentityErr, cmd.Process)
	}
	if commandAlive {
		rec.Observed = append(rec.Observed, Process{
			PID: cmd.Process.Pid, PPID: os.Getpid(), Command: filepath.Base(cfg.Command[0]),
			Identity: commandIdentity,
		})
	}
	if err := errors.Join(stdoutWriter.Close(), stderrWriter.Close()); err != nil {
		if killErr := child.KillStartedProcess(cmd.Process); killErr != nil {
			fmt.Fprintln(os.Stderr, "proc: stop command after output pipe close failure:", killErr)
		}
		if waitErr := cmd.Wait(); waitErr != nil {
			fmt.Fprintln(os.Stderr, "proc: wait after output pipe close failure:", waitErr)
		}
		writeReadyError(ready, err)
		return keeperErrorWithDirectChild(rec, "close command output pipes", err, cmd.Process)
	}
	rec.Status = StatusRunning
	rec.LimitsAdvisory = limitsAdvisory
	rec.LastOutputAt = rec.StartedAtTime
	rec.StallMS = cfg.Stall.Milliseconds()
	if err := updateRecord(cfg.StateDir, rec.RunID, func(stored *record) error {
		rec.SlotGroup, rec.Slots, rec.QueueOrder = stored.SlotGroup, stored.Slots, stored.QueueOrder
		rec.EnqueuedAt, rec.WaitGate, rec.HoldGate = stored.EnqueuedAt, stored.WaitGate, stored.HoldGate
		rec.CostKey, rec.CostClass, rec.MemoryBytes, rec.CPUsMin, rec.CPUsMax, rec.DiskBytes = stored.CostKey, stored.CostClass, stored.MemoryBytes, stored.CPUsMin, stored.CPUsMax, stored.DiskBytes
		rec.GrantedCPUs, rec.ResourceNotice = stored.GrantedCPUs, stored.ResourceNotice
		*stored = rec
		return nil
	}); err != nil {
		writeReadyError(ready, err)
		return keeperErrorWithDirectChild(rec, "record command start", err, cmd.Process)
	}
	if err := appendEvent(cfg.StateDir, eventFor(rec, EventStart)); err != nil {
		writeReadyError(ready, err)
		return keeperErrorWithDirectChild(rec, "record command start", err, cmd.Process)
	}
	if err := json.NewEncoder(ready).Encode(readyMessage{Record: rec}); err != nil {
		if killErr := child.KillStartedProcess(cmd.Process); killErr != nil {
			fmt.Fprintln(os.Stderr, "proc: stop command after readiness failure:", killErr)
		}
		if waitErr := cmd.Wait(); waitErr != nil {
			fmt.Fprintln(os.Stderr, "proc: wait for command after readiness failure:", waitErr)
		}
		return keeperErrorWithDirectChild(rec, "signal readiness", err, cmd.Process)
	}
	if err := ready.Close(); err != nil {
		if killErr := child.KillStartedProcess(cmd.Process); killErr != nil {
			fmt.Fprintln(os.Stderr, "proc: stop command after readiness close failure:", killErr)
		}
		if waitErr := cmd.Wait(); waitErr != nil {
			fmt.Fprintln(os.Stderr, "proc: wait for command after readiness close failure:", waitErr)
		}
		ready = nil
		return keeperErrorWithDirectChild(rec, "close readiness", err, cmd.Process)
	}
	ready = nil
	var initialSampleError error
	if ancestrySampleInterval > 0 {
		rec.Observed, initialSampleError = sampleDescendants(rec, rec.Observed)
		if initialSampleError != nil {
			fmt.Fprintln(os.Stderr, "proc: sample initial descendant tree:", initialSampleError)
		}
		if err := saveProgress(rec, lastOutput.Load()); err != nil {
			fmt.Fprintln(os.Stderr, "proc: save initial descendant sample:", err)
		}
	}
	copyDone := make(chan error, 2)
	go func() {
		copyDone <- copyOutput(stdoutPipe, activityWriter{file: stdout, terminal: os.Stdout, activity: &lastOutput})
	}()
	go func() {
		copyDone <- copyOutput(stderrPipe, activityWriter{file: stderr, terminal: os.Stderr, activity: &lastOutput})
	}()
	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()
	stall := time.NewTicker(stallCheckInterval)
	defer stall.Stop()
	metrics := time.NewTicker(metricSampleInterval)
	defer metrics.Stop()
	governor := time.NewTicker(governorSampleInterval)
	defer governor.Stop()
	var treeSamples <-chan time.Time
	var treeTicker *time.Ticker
	if ancestrySampleInterval > 0 {
		treeTicker = time.NewTicker(ancestrySampleInterval)
		treeSamples = treeTicker.C
		defer treeTicker.Stop()
	}
	metricStarted := time.Now()
	var previousCPU, cpuUsed float64
	var metricSamples int
	var metricsPartial bool
	var waitErr error
	var commandExitedAt time.Time
	var commandFinished bool
	stallReported := false
	var parentMonitorError string
	var cleanupError error = initialSampleError
	var pausedSince time.Time
	cleanup := treeCleanup{Reaped: []Process{}, Unverified: []Process{}}
	var eventError error
	var outputError error
	readersRemaining := 2
	for !commandFinished {
		select {
		case waitErr = <-waitDone:
			commandExitedAt = time.Now().UTC()
			commandFinished = true
		case copyErr := <-copyDone:
			readersRemaining--
			if copyErr != nil {
				outputError = errors.Join(outputError, copyErr)
				result := killTreeWithProtectedAncestorsAndDirectChild(rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors, cmd.Process)
				cleanup = mergeCleanup(cleanup, result)
				cleanupError = errors.Join(cleanupError, result.err)
				var stopErr error
				waitErr, stopErr = waitForCommandAfterTreeCleanup(waitDone, cmd, result)
				cleanupError = errors.Join(cleanupError, stopErr)
				commandExitedAt = time.Now().UTC()
				commandFinished = true
			}
		case parentErr := <-parentGone:
			if parentErr != nil {
				parentMonitorError = parentErr.Error()
			}
			result := killTreeWithProtectedAncestorsAndDirectChild(rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors, cmd.Process)
			cleanup = mergeCleanup(cleanup, result)
			cleanupError = errors.Join(cleanupError, result.err)
			var stopErr error
			waitErr, stopErr = waitForCommandAfterTreeCleanup(waitDone, cmd, result)
			cleanupError = errors.Join(cleanupError, stopErr)
			commandExitedAt = time.Now().UTC()
			commandFinished = true
		case <-treeSamples:
			observed, observeErr := sampleDescendants(rec, rec.Observed)
			if observeErr != nil {
				cleanupError = errors.Join(cleanupError, observeErr)
				fmt.Fprintln(os.Stderr, "proc: sample descendant tree:", observeErr)
			}
			rec.Observed = observed
		case <-governor.C:
			if err := reconcileHostGovernor(cfg.StateDir, systemHostResourceSource()); err != nil {
				fmt.Fprintln(os.Stderr, "proc: reconcile host resource governor:", err)
				cleanupError = errors.Join(cleanupError, err)
			}
		case <-metrics.C:
			rss, cpu, partial, metricErr := sampleRunMetrics(rec)
			if metricErr != nil {
				partial = true
				fmt.Fprintln(os.Stderr, "proc: sample resource use:", metricErr)
			}
			metricsPartial = metricsPartial || partial
			if rss > rec.PeakRSSBytes {
				rec.PeakRSSBytes = rss
			}
			if metricSamples == 0 {
				cpuUsed = cpu
			} else if cpu >= previousCPU {
				cpuUsed += cpu - previousCPU
			}
			previousCPU = cpu
			metricSamples++
			if seconds := time.Since(metricStarted).Seconds(); seconds > 0 {
				rec.AverageCPU = cpuUsed / seconds
			}
			rec.MeasurementPartial = metricsPartial
			emitted, observationErr := recordResourceObservation(cfg.StateDir, rec.RunID, rss, rec.AverageCPU, rec.MeasurementPartial)
			if observationErr != nil {
				eventError = errors.Join(eventError, observationErr)
			}
			rec.OverBudget = rec.OverBudget || emitted
			if err := saveProgress(rec, lastOutput.Load()); err != nil {
				fmt.Fprintln(os.Stderr, "proc: persist sampled resource use:", err)
				cleanupError = errors.Join(cleanupError, err)
			}
		case <-stall.C:
			if err := saveProgress(rec, lastOutput.Load()); err != nil {
				fmt.Fprintln(os.Stderr, "proc: update run progress:", err)
				cleanupError = errors.Join(cleanupError, err)
			}
			var paused bool
			if err := withStateLock(cfg.StateDir, func() error {
				stored, readErr := readRecordLocked(cfg.StateDir, rec.RunID)
				if readErr == nil {
					paused = stored.Status == StatusPaused
				}
				return readErr
			}); err != nil {
				cleanupError = errors.Join(cleanupError, err)
			}
			if paused {
				if pausedSince.IsZero() {
					pausedSince = time.Now()
				}
				continue
			}
			if !pausedSince.IsZero() {
				lastOutput.Store(outputTimeAfterPause(lastOutput.Load(), pausedSince, time.Now()))
				pausedSince = time.Time{}
			}
			if !stallReported && time.Since(time.Unix(0, lastOutput.Load())) >= cfg.Stall {
				e := eventFor(rec, EventStall)
				leaves, leafErr := ProcessLeavesWithHistory(rec.PID, rec.RunID, rec.Observed)
				e.Leaves = leaves
				if leafErr != nil {
					e.Error = "unverified/failed observation: " + leafErr.Error()
					cleanupError = errors.Join(cleanupError, leafErr)
				}
				if err := appendEvent(cfg.StateDir, e); err != nil {
					fmt.Fprintln(os.Stderr, "proc: append stall event:", err)
					eventError = errors.Join(eventError, err)
				}
				stallReported = true
			}
		}
	}
	if metricSamples == 0 {
		rec.MeasurementPartial = true
	}
	result := killTreeWithProtectedAncestorsAndDirectChild(rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors, cmd.Process)
	cleanup = mergeCleanup(cleanup, result)
	cleanupError = errors.Join(cleanupError, result.err)
	if result.err == nil && len(result.Remaining) == 0 {
		if reapErr := reapAdopted(); reapErr != nil {
			cleanupError = errors.Join(cleanupError, reapErr)
		} else {
			verified := killTreeWithProtectedAncestorsAndDirectChild(rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors, cmd.Process)
			cleanup = mergeCleanup(cleanup, verified)
			cleanupError = errors.Join(cleanupError, verified.err)
		}
	}
	if err := closeRunToken(); err != nil {
		cleanupError = errors.Join(cleanupError, fmt.Errorf("close run ownership token: %w", err))
	}
	if err := removeRunToken(cfg.RunID); err != nil {
		cleanupError = errors.Join(cleanupError, err)
	}
	runTokenReleased = true
	if cleanupError != nil || len(cleanup.Remaining) > 0 {
		for readersRemaining > 0 {
			select {
			case copyErr := <-copyDone:
				if copyErr != nil {
					outputError = errors.Join(outputError, copyErr)
				}
				readersRemaining--
			default:
				outputError = errors.Join(outputError, errors.New("stop waiting for inherited command output because process-tree teardown was incomplete"))
				readersRemaining = 0
			}
		}
	} else {
		for readersRemaining > 0 {
			if copyErr := <-copyDone; copyErr != nil {
				outputError = errors.Join(outputError, copyErr)
			}
			readersRemaining--
		}
	}
	code, signal, exitError := platformExit(waitErr)
	exitEvent := eventFor(rec, EventExit)
	exitEvent.At = commandExitedAt
	exitEvent.DurationMS = commandExitedAt.Sub(rec.StartedAtTime).Milliseconds()
	exitEvent.ExitCode = code
	exitEvent.Signal = signal
	exitEvent.Error = exitError
	exitEvent.Unverified = append(exitEvent.Unverified, cleanup.Unverified...)
	if exitEvent.Error == "" {
		exitEvent.Error = parentMonitorError
	}
	if outputError != nil {
		if exitEvent.Error == "" {
			exitEvent.Error = outputError.Error()
		} else {
			exitEvent.Error = errors.Join(errors.New(exitEvent.Error), outputError).Error()
		}
	}
	if cleanupError != nil {
		if exitEvent.Error == "" {
			exitEvent.Error = cleanupError.Error()
		} else {
			exitEvent.Error = errors.Join(errors.New(exitEvent.Error), cleanupError).Error()
		}
	}
	if eventError != nil {
		if exitEvent.Error == "" {
			exitEvent.Error = eventError.Error()
		} else {
			exitEvent.Error = errors.Join(errors.New(exitEvent.Error), eventError).Error()
		}
	}
	exitEvent.Status = exitStatus(code, signal, exitEvent.Error)
	if err := appendEvent(cfg.StateDir, exitEvent); err != nil {
		fmt.Fprintln(os.Stderr, "proc: append exit event:", err)
		eventError = errors.Join(eventError, err)
	}
	if reapErr := reapAdopted(); reapErr != nil {
		cleanupError = errors.Join(cleanupError, reapErr)
	}
	reapEvent := eventFor(rec, EventTeardown)
	reapEvent.Status = exitEvent.Status
	reapEvent.DurationMS = exitEvent.DurationMS
	applyCleanupToEvent(&reapEvent, cleanup)
	resourceFailure := false
	if cleanupError != nil {
		reapEvent.Error = cleanupError.Error()
	}
	resourceOutcomes := cleanupResources(cfg.StateDir, cfg.RunID)
	if resourceErr := resourceOutcomesError(resourceOutcomes); resourceErr != nil {
		resourceFailure = true
		cleanupError = errors.Join(cleanupError, resourceErr)
		if reapEvent.Error == "" {
			reapEvent.Error = cleanupError.Error()
		} else {
			reapEvent.Error = errors.Join(errors.New(reapEvent.Error), resourceErr).Error()
		}
	}
	scratchOutcome, scratchErr := cleanupScratchOutcome(cfg.StateDir, scratch, fileIdentity{Device: rec.ScratchDevice, Inode: rec.ScratchInode}, cfg.Keep)
	if scratch != "" {
		if err := appendResourceOutcome(cfg.StateDir, cfg.RunID, scratchOutcome); err != nil {
			scratchErr = errors.Join(scratchErr, fmt.Errorf("persist scratch cleanup outcome: %w", err))
		}
	}
	if scratchErr != nil {
		reapEvent.Status = StatusDirty
		err := scratchErr
		cleanupError = errors.Join(cleanupError, fmt.Errorf("remove run scratch: %w", err))
		if dirtyErr := markRunDirty(cfg.StateDir, cfg.RunID, "scratch cleanup failed: "+err.Error()); dirtyErr != nil {
			cleanupError = errors.Join(cleanupError, dirtyErr)
		}
		if reapEvent.Error == "" {
			reapEvent.Error = cleanupError.Error()
		} else {
			reapEvent.Error = errors.Join(errors.New(reapEvent.Error), cleanupError).Error()
		}
	}
	if eventError != nil {
		if reapEvent.Error == "" {
			reapEvent.Error = eventError.Error()
		} else {
			reapEvent.Error = errors.Join(errors.New(reapEvent.Error), eventError).Error()
		}
	}
	if err := releaseGate(cfg.StateDir, cfg.RunID, cfg.HoldGate); err != nil {
		fmt.Fprintln(os.Stderr, "proc: release held gate:", err)
		cleanupError = errors.Join(cleanupError, err)
	}
	finalStatus := exitEvent.Status
	if resourceFailure || scratchErr != nil {
		finalStatus = StatusDirty
	} else if cleanupError != nil || eventError != nil {
		finalStatus = StatusFailed
	}
	rec.Status = finalStatus
	reapEvent.Status = finalStatus
	if err := completeRecord(cfg.StateDir, cfg.RunID, code, signal, time.Duration(exitEvent.DurationMS)*time.Millisecond, rec); err != nil {
		fmt.Fprintln(os.Stderr, "proc: record completed run:", err)
		cleanupError = errors.Join(cleanupError, err)
		reapEvent.Status = StatusFailed
	}
	if err := appendEvent(cfg.StateDir, reapEvent); err != nil {
		fmt.Fprintln(os.Stderr, "proc: append teardown event:", err)
		eventError = errors.Join(eventError, err)
	}
	if code != nil && *code != 0 {
		return *code
	}
	if signal != "" {
		return 128 + signalNumber(signal)
	}
	if exitError != "" {
		return 1
	}
	if cleanupError != nil {
		return 1
	}
	if eventError != nil {
		return 1
	}
	return 0
}

func outputTimeAfterPause(lastOutput int64, pausedAt, resumedAt time.Time) int64 {
	return lastOutput + resumedAt.Sub(pausedAt).Nanoseconds()
}

func sampleRunMetrics(rec record) (uint64, float64, bool, error) {
	return sampleRunMetricsWithSource(rec, osProcessSource{})
}

func sampleRunMetricsWithSource(rec record, source processSource) (uint64, float64, bool, error) {
	tree, err := processTreeWithHistorySource(source, rec.PID, rec.RunID, rec.Observed)
	if metricsSource, ok := source.(processMetricsSource); ok {
		var metricsErr error
		tree, metricsErr = metricsSource.Metrics(tree)
		err = errors.Join(err, metricsErr)
	}
	var rss uint64
	var cpu float64
	partial := false
	if len(tree) == 0 {
		partial = true
	}
	for _, process := range tree {
		if process.Unverified {
			partial = true
			continue
		}
		if !process.MetricsAvailable {
			partial = true
			continue
		}
		rss += process.RSSBytes
		cpu += process.CPUSeconds
	}
	return rss, cpu, partial || err != nil, err
}

func copyOutput(src io.Reader, dst activityWriter) error {
	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("copy command output: %w", err)
	}
	return nil
}

func waitForCommandAfterTreeCleanup(waitDone <-chan error, command *exec.Cmd, cleanup treeCleanup) (error, error) {
	if cleanup.err == nil && len(cleanup.Remaining) == 0 {
		return <-waitDone, nil
	}
	select {
	case waitErr := <-waitDone:
		return waitErr, nil
	default:
	}
	if command == nil || command.Process == nil {
		return <-waitDone, errors.New("process-tree cleanup failed before the command process handle was available")
	}
	stopErr := child.KillStartedProcess(command.Process)
	if errors.Is(stopErr, os.ErrProcessDone) {
		stopErr = nil
	}
	if stopErr != nil {
		stopErr = fmt.Errorf("force-stop command after incomplete process-tree cleanup: %w", stopErr)
	}
	return <-waitDone, stopErr
}

func writeReadyError(ready *os.File, cause error) {
	if err := json.NewEncoder(ready).Encode(readyMessage{Error: cause.Error()}); err != nil {
		fmt.Fprintln(os.Stderr, "proc: report keeper startup failure:", err)
	}
}

func writeOutput(output *os.File, data []byte) error {
	written, err := output.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	return nil
}

func openOutput(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
}

func keeperError(rec record, action string, err error) int {
	return keeperErrorWithSignalOwner(rec, action, err, osProcessSource{}, nil)
}

func keeperErrorWithDirectChild(rec record, action string, err error, directChild *os.Process) int {
	return keeperErrorWithSignalOwner(rec, action, err, osProcessSource{}, directChild)
}

func keeperErrorWithSignalOwner(rec record, action string, err error, source processSource, directChild *os.Process) int {
	fmt.Fprintf(os.Stderr, "proc: %s: %v\n", action, err)
	e := eventFor(rec, EventExit)
	e.Error = err.Error()
	if cleanupErr := cleanupTreeWithProtectedSourceAndDirectChild(rec.PID, rec.RunID, rec.Observed, rec.ProtectedAncestors, source, directChild).err; cleanupErr != nil {
		e.Error = errors.Join(err, cleanupErr).Error()
		fmt.Fprintln(os.Stderr, "proc: reap command tree:", cleanupErr)
	}
	if tokenErr := removeRunToken(rec.RunID); tokenErr != nil {
		e.Error = errors.Join(errors.New(e.Error), tokenErr).Error()
	}
	if appendErr := appendEvent(rec.StateDir, e); appendErr != nil {
		fmt.Fprintln(os.Stderr, "proc: record command failure:", appendErr)
	}
	reapEvent := eventFor(rec, EventTeardown)
	reapEvent.Error = e.Error
	resourceOutcomes := cleanupResources(rec.StateDir, rec.RunID)
	if resourceErr := resourceOutcomesError(resourceOutcomes); resourceErr != nil {
		reapEvent.Error = errors.Join(errors.New(reapEvent.Error), resourceErr).Error()
	}
	scratch := rec.Scratch
	if scratch != "" {
		scratchOutcome, scratchErr := cleanupScratchOutcome(rec.StateDir, scratch, fileIdentity{Device: rec.ScratchDevice, Inode: rec.ScratchInode}, rec.Keep)
		if persistErr := appendResourceOutcome(rec.StateDir, rec.RunID, scratchOutcome); persistErr != nil {
			scratchErr = errors.Join(scratchErr, fmt.Errorf("persist scratch cleanup outcome: %w", persistErr))
		}
		if scratchErr != nil {
			if dirtyErr := markRunDirty(rec.StateDir, rec.RunID, "scratch cleanup failed: "+scratchErr.Error()); dirtyErr != nil {
				fmt.Fprintln(os.Stderr, "proc: mark scratch cleanup failure dirty:", dirtyErr)
			}
		}
	}
	if appendErr := appendEvent(rec.StateDir, reapEvent); appendErr != nil {
		fmt.Fprintln(os.Stderr, "proc: record teardown:", appendErr)
	}
	if releaseErr := releaseGate(rec.StateDir, rec.RunID, rec.HoldGate); releaseErr != nil {
		fmt.Fprintln(os.Stderr, "proc: release gate after keeper error:", releaseErr)
	}
	return 1
}

func sampleDescendants(rec record, previous []Process) ([]Process, error) {
	observed := make(map[string]Process, len(previous))
	for _, process := range previous {
		identity, alive, err := inspectIdentity(process.PID)
		if err != nil {
			return nil, fmt.Errorf("inspect previously observed process %d: %w", process.PID, err)
		}
		if alive && identity == process.Identity {
			observed[processObservationKey(process)] = process
		}
	}
	tree, err := processTreeWithKnownAncestors(osProcessSource{}, rec.PID, rec.RunID, nil, rec.ProtectedAncestors)
	for _, process := range tree {
		if !process.Unverified {
			observed[processObservationKey(process)] = process
		}
	}
	out := make([]Process, 0, len(observed))
	for _, process := range observed {
		out = append(out, process)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].PID == out[j].PID {
			return out[i].Identity < out[j].Identity
		}
		return out[i].PID < out[j].PID
	})
	return out, err
}

func processObservationKey(process Process) string {
	return fmt.Sprintf("%d:%s", process.PID, process.Identity)
}

func processIdentityEvidenceKey(evidence ProcessIdentityEvidence) string {
	return processObservationKey(Process{PID: evidence.PID, Identity: evidence.Identity})
}

func saveProgress(rec record, lastOutput int64) error {
	last := time.Unix(0, lastOutput).UTC()
	status := StatusRunning
	if rec.StallMS > 0 && time.Since(last) >= time.Duration(rec.StallMS)*time.Millisecond {
		status = StatusStalled
	}
	return updateRecord(rec.StateDir, rec.RunID, func(stored *record) error {
		if stored.Status == StatusPaused {
			stored.LastOutputAt = last
			stored.Observed = rec.Observed
			stored.PeakRSSBytes, stored.AverageCPU = rec.PeakRSSBytes, rec.AverageCPU
			stored.MeasurementPartial, stored.OverBudget = rec.MeasurementPartial, rec.OverBudget
			return nil
		}
		stored.Status = status
		stored.LastOutputAt = last
		stored.Observed = rec.Observed
		stored.PeakRSSBytes, stored.AverageCPU = rec.PeakRSSBytes, rec.AverageCPU
		stored.MeasurementPartial, stored.OverBudget = rec.MeasurementPartial, rec.OverBudget
		return nil
	})
}

func mergeCleanup(left, right treeCleanup) treeCleanup {
	appendUnique := func(dst, src []Process) []Process {
		seen := make(map[string]bool, len(dst)+len(src))
		for _, process := range dst {
			seen[processObservationKey(process)] = true
		}
		for _, process := range src {
			key := processObservationKey(process)
			if !seen[key] {
				seen[key] = true
				dst = append(dst, process)
			}
		}
		return dst
	}
	left.Reaped = appendUnique(left.Reaped, right.Reaped)
	left.Unverified = appendUnique(left.Unverified, right.Unverified)
	left.Remaining = appendUnique(left.Remaining, right.Remaining)
	seenHistory := make(map[string]bool, len(left.History)+len(right.History))
	for _, evidence := range left.History {
		seenHistory[processIdentityEvidenceKey(evidence)] = true
	}
	for _, evidence := range right.History {
		key := processIdentityEvidenceKey(evidence)
		if !seenHistory[key] {
			seenHistory[key] = true
			left.History = append(left.History, evidence)
		}
	}
	nextInventoryIndex := 1
	if len(left.Inventory) > 0 {
		nextInventoryIndex = left.Inventory[len(left.Inventory)-1].Index + 1
	}
	for _, sample := range right.Inventory {
		sample.Index = nextInventoryIndex
		nextInventoryIndex++
		left.appendInventory(sample)
	}
	left.InventorySamplesOmitted += right.InventorySamplesOmitted
	left.err = errors.Join(left.err, right.err)
	return left
}

func applyCleanupToEvent(event *Event, cleanup treeCleanup) {
	event.Reaped = cleanup.Reaped
	event.Unverified = cleanup.Unverified
	event.Remaining = cleanup.Remaining
	event.TeardownHistory = cleanup.History
	event.TeardownInventory = cleanup.Inventory
	event.TeardownInventoryOmitted = cleanup.InventorySamplesOmitted
}

func signalKeeper(pid RecordedKeeperPID, identity, runID string, signal syscall.Signal, source processSource) error {
	if pid <= 0 {
		return errors.New("proc: invalid keeper pid")
	}
	current, alive, err := source.Identity(int(pid))
	if err != nil {
		return err
	}
	if !alive || current != identity {
		return nil
	}
	if int(pid) == os.Getpid() {
		fmt.Fprintf(os.Stderr, "proc: keeper signal refused pid=%d identity=%q signal=%s run=%q outcome=%q attribution=caller\n", pid, identity, signal, runID, KeeperSignalRefusedCaller)
		return &KeeperSignalError{Outcome: KeeperSignalRefusedCaller, PID: int(pid)}
	}
	parentSource, ok := source.(processParentSource)
	if !ok {
		fmt.Fprintf(os.Stderr, "proc: keeper signal refused pid=%d identity=%q signal=%s run=%q outcome=%q attribution=caller-ancestry-unverifiable\n", pid, identity, signal, runID, KeeperSignalRefusedUnverifiable)
		return &KeeperSignalError{Outcome: KeeperSignalRefusedUnverifiable, PID: int(pid)}
	}
	ancestors, err := callerAncestorPIDs(os.Getpid(), parentSource.ParentPID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "proc: keeper signal refused pid=%d identity=%q signal=%s run=%q outcome=%q attribution=caller-ancestry-unverifiable\n", pid, identity, signal, runID, KeeperSignalRefusedUnverifiable)
		return &KeeperSignalError{Outcome: KeeperSignalRefusedUnverifiable, PID: int(pid)}
	}
	if _, protected := ancestors[int(pid)]; protected {
		fmt.Fprintf(os.Stderr, "proc: keeper signal refused pid=%d identity=%q signal=%s run=%q outcome=%q attribution=caller-ancestor\n", pid, identity, signal, runID, KeeperSignalRefusedCaller)
		return &KeeperSignalError{Outcome: KeeperSignalRefusedCaller, PID: int(pid)}
	}
	fmt.Fprintf(os.Stderr, "proc: keeper signal pid=%d identity=%q signal=%s run=%q attribution=run-record-keeper\n", pid, identity, signal, runID)
	return source.Signal(int(pid), identity, signal)
}

type processParentSource interface {
	ParentPID(pid int) (int, error)
}

func callerAncestorPIDs(callerPID int, parentPID func(int) (int, error)) (map[int]struct{}, error) {
	ancestors := make(map[int]struct{})
	seen := make(map[int]bool)
	for pid := callerPID; pid > 0 && !seen[pid]; {
		seen[pid] = true
		ancestors[pid] = struct{}{}
		if pid == 1 {
			break
		}
		parent, err := parentPID(pid)
		if err != nil {
			return nil, fmt.Errorf("inspect caller ancestry at process %d: %w", pid, err)
		}
		pid = parent
	}
	return ancestors, nil
}
