//go:build darwin || linux

package proc

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"
)

type processCPUSample struct {
	At         time.Time `json:"at"`
	CPUSeconds float64   `json:"cpu_seconds"`
	Command    string    `json:"command,omitempty"`
}

type ungatedHeavyRun struct {
	Record record
	Binary string
	Rate   float64
	Tree   []Process
}

const ungatedHeavyCPUThreshold = 0.5

type governorState struct {
	At               time.Time                   `json:"at"`
	Host             HostResourceSnapshot        `json:"host"`
	Decision         string                      `json:"decision"`
	Reason           string                      `json:"reason,omitempty"`
	Hold             pressureState               `json:"hold"`
	ProcessCPU       map[string]processCPUSample `json:"process_cpu,omitempty"`
	UngatedCPUTokens int                         `json:"ungated_cpu_tokens,omitempty"`
	UngatedCPURate   float64                     `json:"ungated_cpu_rate,omitempty"`
}

func governorHardPressure(sample, previous HostResourceSnapshot, freeDisk, diskFloor uint64) string {
	if diskFloor > 0 && freeDisk < diskFloor {
		return fmt.Sprintf("free disk %s is below floor %s", FormatResourceBytes(freeDisk), FormatResourceBytes(diskFloor))
	}
	if sample.Pressure == "memory critical" || sample.Pressure == "memory psi elevated" {
		return "hard host memory pressure (" + sample.Pressure + ")"
	}
	if sample.PhysicalMemory > 0 && sample.MemoryAvailableKnown && sample.AvailableMemory < sample.PhysicalMemory*lowAvailableMemoryFraction/100 {
		return "hard host pressure (available memory below 10% of physical)"
	}
	if sample.CPUPressure >= pressurePSIThreshold {
		return fmt.Sprintf("hard host CPU pressure (%.2f%% PSI)", sample.CPUPressure)
	}
	if sample.LoadAvailable && sample.LogicalCPUs > 0 && sample.Load1 > highLoadPerLogicalCPU*float64(sample.LogicalCPUs) {
		return fmt.Sprintf("host load %.2f exceeds %.2f per logical CPU across %d CPUs", sample.Load1, highLoadPerLogicalCPU, sample.LogicalCPUs)
	}
	if sample.SwapOutsKnown && previous.SwapOutsKnown && sample.SwapOuts > previous.SwapOuts {
		return fmt.Sprintf("swapouts increased from %d to %d", previous.SwapOuts, sample.SwapOuts)
	}
	if sample.SwapUsedBytes > previous.SwapUsedBytes && previous.SwapUsedBytes > 0 {
		return fmt.Sprintf("swap used increased from %s to %s", FormatResourceBytes(previous.SwapUsedBytes), FormatResourceBytes(sample.SwapUsedBytes))
	}
	return ""
}

func governorAdmissionReason(class CostClass, sample HostResourceSnapshot, freeDisk, diskFloor uint64) string {
	if class != CostHeavy {
		return ""
	}
	if reason := pressureWaitReason(sample); isElevatedPressure(sample) {
		return reason
	}
	if diskFloor > 0 && freeDisk < diskFloor {
		return governorHardPressure(sample, HostResourceSnapshot{}, freeDisk, diskFloor)
	}
	return ""
}

func readGovernorState(stateDir string) (governorState, error) {
	var state governorState
	data, err := os.ReadFile(filepath.Join(stateDir, "governor-state.json"))
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("decode governor state: %w", err)
	}
	return state, nil
}

func writeGovernorState(stateDir string, state governorState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	path := filepath.Join(stateDir, "governor-state.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return errors.Join(err, os.Remove(tmp))
	}
	return nil
}

func reconcileHostGovernor(stateDir string, source HostResourceSource) error {
	return reconcileHostGovernorWithProcessSource(stateDir, source, osProcessSource{})
}

func reconcileHostGovernorWithProcessSource(stateDir string, source HostResourceSource, processSource processSource) error {
	return reconcileHostGovernorWithProcessSourceAndClock(stateDir, source, processSource, realAdmissionClock{})
}

func reconcileHostGovernorWithProcessSourceAndClock(stateDir string, source HostResourceSource, processSource processSource, clock admissionClock) error {
	return withStateLock(stateDir, func() error {
		state, err := readGovernorState(stateDir)
		if err != nil {
			return err
		}
		records, err := readLiveRecordsLocked(stateDir)
		if err != nil {
			return err
		}
		sample := source.Snapshot()
		free, diskErr := hostFreeDiskBytes(stateDir, source)
		if diskErr != nil {
			return diskErr
		}
		sample.FreeDiskBytes, sample.FreeDiskKnown = free, true
		quota, err := effectiveQuota(stateDir, source)
		if err != nil {
			return err
		}
		floor := quota.MinFree
		for _, rec := range records {
			if rec.CostClass == CostHeavy && !rec.Status.Terminal() {
				floor = max(floor, rec.MinFree)
			}
		}
		now := clock.Now()
		ungatedTokens, ungatedRate, ungatedRuns, processSamples, err := sampleUngatedHeavyCPU(records, processSource, state.ProcessCPU, now)
		if err != nil {
			return err
		}
		state.UngatedCPUTokens, state.UngatedCPURate, state.ProcessCPU = ungatedTokens, ungatedRate, processSamples
		reason := governorHardPressure(sample, state.Host, free, floor)
		recovering := false
		if reason != "" {
			state.Hold.blocks(true, now)
			state.Reason = reason
		} else if state.Hold.blocks(false, now) {
			recovering = true
		} else {
			state.Reason = ""
		}
		state.At, state.Host = now.UTC(), sample
		state.Decision = "normal"

		// A lowered quota is enforced against existing grants, not only new
		// admissions. Pause newest grants first until usage fits the new P count.
		for tokenUsage(records) > quota.CPUs {
			target := newestRunningTokenRun(records)
			if target == nil {
				return fmt.Errorf("CPU capacity is %d but active grants use %d and no verified grant can be paused", quota.CPUs, tokenUsage(records))
			}
			if err := pauseRunLocked(stateDir, target, now, "CPU capacity reduced", EventPaused, "", nil, sample, free, floor, processSource); err != nil {
				return err
			}
			state.Decision = fmt.Sprintf("rebalanced CPU capacity to %d", quota.CPUs)
		}

		if reason != "" {
			state.Decision = "pressure"
			// Measured work outside a grant is the first preemption target.
			if len(ungatedRuns) > 0 {
				target := ungatedRuns[0]
				if err := pauseRunLocked(stateDir, findRecord(records, target.Record.RunID), now, reason, EventUngatedHeavy, target.Binary, target.Tree, sample, free, floor, processSource); err != nil {
					return err
				}
				state.UngatedCPURate = math.Max(0, state.UngatedCPURate-target.Rate)
				state.UngatedCPUTokens = int(math.Ceil(state.UngatedCPURate))
				state.Decision = "paused ungated " + target.Record.Tag
			} else if tokenUsage(records) >= quota.CPUs && newestRunningTokenRun(records) != nil {
				target := newestRunningTokenRun(records)
				if err := pauseRunLocked(stateDir, target, now, reason, EventPaused, "", nil, sample, free, floor, processSource); err != nil {
					return err
				}
				state.Decision = "paused " + target.Tag
			} else if target := lowestPriorityHeavy(records); target != nil {
				if err := pauseRunLocked(stateDir, target, now, reason, EventPaused, "", nil, sample, free, floor, processSource); err != nil {
					return err
				}
				state.Decision = "paused " + target.Tag
			}
		} else if !recovering {
			if err := resumePausedRunsLocked(stateDir, records, quota.CPUs, now, sample, processSource); err != nil {
				return err
			}
		} else {
			state.Decision = "recovering"
		}
		return writeGovernorState(stateDir, state)
	})
}

func sampleUngatedHeavyCPU(records []record, source processSource, previous map[string]processCPUSample, now time.Time) (int, float64, []ungatedHeavyRun, map[string]processCPUSample, error) {
	if previous == nil {
		previous = make(map[string]processCPUSample)
	}
	grantedPIDs := make(map[int]string)
	for _, rec := range records {
		if rec.SlotGroup != CPUCommandTokenGroup || !cpuTokenStatusActive(rec.Status) {
			continue
		}
		tree, err := processTreeWithHistorySource(source, rec.PID, rec.RunID, rec.Observed)
		if err != nil {
			return 0, 0, nil, nil, fmt.Errorf("observe granted CPU tree %s: %w", rec.Tag, err)
		}
		for _, process := range tree {
			grantedPIDs[process.PID] = process.Identity
		}
	}
	metricsSource, hasMetrics := source.(processMetricsSource)
	current := make(map[string]processCPUSample)
	seen := make(map[string]struct{})
	var totalRate float64
	var heavy []ungatedHeavyRun
	for _, rec := range records {
		if rec.SlotGroup == CPUCommandTokenGroup || !cpuTokenStatusActive(rec.Status) {
			continue
		}
		tree, err := processTreeWithHistorySource(source, rec.PID, rec.RunID, rec.Observed)
		if err != nil {
			return 0, 0, nil, nil, fmt.Errorf("observe ungranted process tree %s: %w", rec.Tag, err)
		}
		if !hasMetrics {
			return 0, 0, nil, nil, errors.New("process source does not provide CPU metrics for ungranted process trees")
		}
		tree, err = metricsSource.Metrics(tree)
		if err != nil {
			return 0, 0, nil, nil, fmt.Errorf("measure ungranted process tree %s: %w", rec.Tag, err)
		}
		var runRate float64
		var binary string
		var binaryDelta float64
		for _, process := range tree {
			if process.Unverified || !process.MetricsAvailable {
				continue
			}
			if identity, granted := grantedPIDs[process.PID]; granted && identity == process.Identity {
				continue
			}
			key := fmt.Sprintf("%d:%s", process.PID, process.Identity)
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			delta := 0.0
			if old, ok := previous[key]; ok && now.After(old.At) && process.CPUSeconds >= old.CPUSeconds {
				delta = process.CPUSeconds - old.CPUSeconds
				runRate += delta / now.Sub(old.At).Seconds()
			}
			current[key] = processCPUSample{At: now, CPUSeconds: process.CPUSeconds, Command: process.Command}
			if delta > binaryDelta {
				binaryDelta, binary = delta, process.Command
			}
		}
		totalRate += runRate
		if runRate >= ungatedHeavyCPUThreshold {
			heavy = append(heavy, ungatedHeavyRun{Record: rec, Binary: binary, Rate: runRate, Tree: tree})
		}
	}
	sort.Slice(heavy, func(i, j int) bool {
		if heavy[i].Rate != heavy[j].Rate {
			return heavy[i].Rate > heavy[j].Rate
		}
		return heavy[i].Record.QueueOrder < heavy[j].Record.QueueOrder
	})
	return int(math.Ceil(totalRate)), totalRate, heavy, current, nil
}

func findRecord(records []record, runID string) *record {
	for index := range records {
		if records[index].RunID == runID {
			return &records[index]
		}
	}
	return nil
}

func tokenUsage(records []record) int {
	used := 0
	for _, rec := range records {
		if rec.SlotGroup == CPUCommandTokenGroup && cpuTokenStatusActive(rec.Status) {
			used += slotWeight(rec)
		}
	}
	return used
}

func lowestPriorityHeavy(records []record) *record {
	var target *record
	for index := range records {
		rec := &records[index]
		if rec.CostClass != CostHeavy || rec.SlotGroup == CPUCommandTokenGroup || rec.Status == StatusPaused ||
			(rec.Status != StatusRunning && rec.Status != StatusStalled && rec.Status != StatusStarting) {
			continue
		}
		if target == nil || rec.Priority < target.Priority ||
			(rec.Priority == target.Priority && (rec.QueueOrder > target.QueueOrder ||
				(rec.QueueOrder == target.QueueOrder && rec.EnqueuedAt.After(target.EnqueuedAt)))) {
			target = rec
		}
	}
	return target
}

func newestRunningTokenRun(records []record) *record {
	var target *record
	for index := range records {
		rec := &records[index]
		if rec.SlotGroup != CPUCommandTokenGroup || !cpuTokenStatusActive(rec.Status) {
			continue
		}
		if target == nil || rec.QueueOrder > target.QueueOrder {
			target = rec
		}
	}
	return target
}

func pauseRunLocked(stateDir string, rec *record, now time.Time, reason string, eventType EventType, binary string, tree []Process, sample HostResourceSnapshot, free, floor uint64, source processSource) error {
	if rec == nil {
		return errors.New("cannot pause a missing process run")
	}
	previous := *rec
	rec.Status, rec.PausedAt, rec.WaitReason = StatusPaused, now.UTC(), reason
	rec.EnqueuedAt = now.UTC()
	if err := writeRecordAtomic(*rec); err != nil {
		*rec = previous
		return fmt.Errorf("persist paused intent for %s: %w", rec.Tag, err)
	}
	if err := signalRunTreeWithSource(*rec, syscall.SIGSTOP, source); err != nil {
		*rec = previous
		return errors.Join(fmt.Errorf("pause process tree %s: %w", rec.Tag, err), writeRecordAtomic(*rec))
	}
	event := eventFor(*rec, eventType)
	event.Reason, event.Pressure = reason, sample
	event.DiskFreeBytes, event.DiskNeedBytes = free, floor
	event.Binary, event.ProcessTree = binary, append([]Process(nil), tree...)
	if err := appendEvent(stateDir, event); err != nil {
		resumeErr := signalRunTreeWithSource(*rec, syscall.SIGCONT, source)
		if resumeErr == nil {
			*rec = previous
			if writeErr := writeRecordAtomic(*rec); writeErr != nil {
				stopErr := signalRunTreeWithSource(*rec, syscall.SIGSTOP, source)
				return errors.Join(fmt.Errorf("append pause event for %s: %w", rec.Tag, err), writeErr, stopErr)
			}
			return fmt.Errorf("append pause event for %s: %w", rec.Tag, err)
		}
		return errors.Join(fmt.Errorf("append pause event for %s: %w", rec.Tag, err), fmt.Errorf("restore process tree after event failure: %w", resumeErr))
	}
	return nil
}

func resumePausedRunsLocked(stateDir string, records []record, capacity int, now time.Time, sample HostResourceSnapshot, source processSource) error {
	paused := make([]*record, 0)
	for index := range records {
		if records[index].Status == StatusPaused {
			paused = append(paused, &records[index])
		}
	}
	sort.Slice(paused, func(i, j int) bool {
		if !paused[i].EnqueuedAt.Equal(paused[j].EnqueuedAt) {
			return paused[i].EnqueuedAt.Before(paused[j].EnqueuedAt)
		}
		return paused[i].QueueOrder < paused[j].QueueOrder
	})
	used := tokenUsage(records)
	for _, rec := range paused {
		weight := 0
		if rec.SlotGroup == CPUCommandTokenGroup {
			weight = slotWeight(*rec)
			if used+weight > capacity {
				continue
			}
		}
		previous := *rec
		pausedFor := now.Sub(rec.PausedAt)
		if err := signalRunTreeWithSource(*rec, syscall.SIGCONT, source); err != nil {
			return fmt.Errorf("resume process tree %s: %w", rec.Tag, err)
		}
		event := eventFor(*rec, EventResumed)
		event.DurationMS, event.PausedMS = pausedFor.Milliseconds(), rec.PausedMS+pausedFor.Milliseconds()
		event.Pressure, event.GovernorDecision = sample, "normal"
		if err := appendEvent(stateDir, event); err != nil {
			stopErr := signalRunTreeWithSource(*rec, syscall.SIGSTOP, source)
			return errors.Join(fmt.Errorf("append resume event for %s: %w", rec.Tag, err), stopErr)
		}
		rec.Status, rec.PausedAt, rec.WaitReason = StatusRunning, time.Time{}, ""
		rec.PausedMS += pausedFor.Milliseconds()
		if err := writeRecordAtomic(*rec); err != nil {
			*rec = previous
			stopErr := signalRunTreeWithSource(*rec, syscall.SIGSTOP, source)
			return errors.Join(fmt.Errorf("persist resumed state for %s: %w", rec.Tag, err), stopErr)
		}
		used += weight
	}
	return nil
}

func hostFreeDiskBytes(stateDir string, source HostResourceSource) (uint64, error) {
	if sample := source.Snapshot(); sample.FreeDiskKnown {
		return sample.FreeDiskBytes, nil
	}
	return freeDiskBytes(stateDir)
}

func signalRunTree(rec record, signal syscall.Signal) error {
	return signalRunTreeWithSource(rec, signal, osProcessSource{})
}

func signalRunTreeWithSource(rec record, signal syscall.Signal, source processSource) error {
	tree, err := processTreeWithHistorySource(source, rec.PID, rec.RunID, rec.Observed)
	if err != nil {
		return err
	}
	if len(tree) == 0 {
		return fmt.Errorf("run %s has no verified process tree to signal with %s", rec.Tag, signal)
	}
	sort.Slice(tree, func(i, j int) bool {
		if signal == syscall.SIGSTOP {
			return tree[i].PID > tree[j].PID
		}
		return tree[i].PID < tree[j].PID
	})
	var signaled []Process
	for _, process := range tree {
		if process.Unverified {
			continue
		}
		identity, live, identityErr := source.Identity(process.PID)
		if identityErr != nil {
			return errors.Join(fmt.Errorf("verify process %d before %s: %w", process.PID, signal, identityErr), resumeSignaled(source, signaled))
		}
		if !live || identity != process.Identity {
			continue
		}
		if err := source.Signal(process.PID, process.Identity, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
			return errors.Join(fmt.Errorf("signal process %d with %s: %w", process.PID, signal, err), resumeSignaled(source, signaled))
		}
		signaled = append(signaled, process)
	}
	if len(signaled) == 0 {
		return fmt.Errorf("run %s has no verified process identities to signal with %s", rec.Tag, signal)
	}
	return nil
}

func resumeSignaled(source processSource, processes []Process) error {
	var failures []error
	for _, process := range processes {
		if err := source.Signal(process.PID, process.Identity, syscall.SIGCONT); err != nil && !errors.Is(err, syscall.ESRCH) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
