//go:build darwin || linux

package proc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

const admissionPollInterval = 250 * time.Millisecond
const idleQueueThreshold = 10 * time.Minute
const slotAgingThreshold = 30 * time.Second
const CPUCommandTokenGroup = "heavy-command"

type gateRecord struct {
	Name     string `json:"name"`
	RunID    string `json:"run_id"`
	PID      int    `json:"pid"`
	Identity string `json:"identity"`
}

type GateInfo struct {
	Name     string
	Tag      string
	PID      int
	Identity string
}

type admissionDecision struct {
	Reason        string
	Status        RunStatus
	Position      int
	DiskNeedBytes uint64
	DiskFreeBytes uint64
	Pressure      HostResourceSnapshot
}

type admissionClock interface{ Now() time.Time }

type realAdmissionClock struct{}

func (realAdmissionClock) Now() time.Time { return time.Now().UTC() }

func GateStatus(stateDir, name string) (GateInfo, bool, error) {
	var info GateInfo
	var held bool
	err := withStateLock(stateDir, func() error {
		if err := pruneStateLocked(stateDir); err != nil {
			return err
		}
		gate, exists, err := readGateLocked(stateDir, name)
		if err != nil || !exists {
			return err
		}
		info = GateInfo{Name: gate.Name, PID: gate.PID, Identity: gate.Identity}
		rec, err := readRecordLocked(stateDir, gate.RunID)
		if err != nil {
			return fmt.Errorf("read gate holder run %s: %w", gate.RunID, err)
		}
		info.Tag = rec.Tag
		held = true
		return nil
	})
	return info, held, err
}

func reserveAdmission(ctx context.Context, cfg Config, runID string, parentPID int, parentIdentity string, source HostResourceSource) error {
	if cfg.Slots < 0 || (cfg.SlotGroup == "") != (cfg.Slots == 0) || cfg.SlotWeight < 0 || (cfg.SlotGroup == "" && cfg.SlotWeight != 0) {
		return errors.New("proc: --slot-group and positive --slots must be supplied together")
	}
	if cfg.SlotGroup != "" && cfg.SlotWeight == 0 {
		cfg.SlotWeight = 1
	}
	if cfg.SlotGroup != "" && cfg.SlotWeight > cfg.Slots {
		return errors.New("proc: --slot-weight cannot exceed --slots")
	}
	if cfg.HoldGate != "" && cfg.WaitGate == cfg.HoldGate {
		return errors.New("proc: a run cannot wait on the gate it holds")
	}
	if err := os.MkdirAll(liveRecordsDir(cfg.StateDir), 0o700); err != nil {
		return fmt.Errorf("proc: create run registry: %w", err)
	}
	var firstDecisionSample HostResourceSnapshot
	if err := withStateLock(cfg.StateDir, func() error {
		if err := pruneStateLocked(cfg.StateDir); err != nil {
			return err
		}
		location := recordLocation(cfg.StateDir, runID)
		for _, status := range []RunStatus{StatusQueued, StatusCompleted} {
			path := location.path(status)
			if _, err := os.Lstat(path); err == nil {
				return fmt.Errorf("proc: run ID %s already has a durable record", runID)
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("proc: inspect run ID %s record: %w", runID, err)
			}
		}
		order, err := nextQueueOrderLocked(cfg.StateDir)
		if err != nil {
			return err
		}
		known, err := readAllRecordsLocked(cfg.StateDir)
		if err != nil {
			return err
		}
		learned := learnedUsage(known, cfg.CostKey)
		cost := effectiveQuotaUsage(quotaUsage{MemoryBytes: cfg.MemoryBytes, MinCPUs: cfg.CPUsMin, DiskBytes: cfg.DiskBytes}, learned)
		rec := record{
			RunID: runID, Tag: cfg.Tag, LatestTag: cfg.LatestTag, PID: parentPID, StartedAt: parentIdentity,
			Command: cfg.Command, StateDir: cfg.StateDir, Status: StatusQueued,
			SlotGroup: cfg.SlotGroup, Slots: cfg.Slots, SlotWeight: cfg.SlotWeight, QueueOrder: order,
			EnqueuedAt: time.Now().UTC(), WaitGate: cfg.WaitGate, HoldGate: cfg.HoldGate, MinFree: cfg.MinFree,
			CostKey: cfg.CostKey, CostClass: cfg.CostClass, Priority: cfg.Priority, MemoryBytes: cost.MemoryBytes, CPUsMin: cost.MinCPUs, CPUsMax: cfg.CPUsMax, DiskBytes: cost.DiskBytes,
		}
		if err := writeRecordAtomic(rec); err != nil {
			return fmt.Errorf("proc: record queued run: %w", err)
		}
		firstDecisionSample = source.Snapshot()
		event := eventFor(rec, EventQueued)
		event.Pressure = firstDecisionSample
		return appendEvent(cfg.StateDir, event)
	}); err != nil {
		return err
	}

	ticker := time.NewTicker(admissionPollInterval)
	defer ticker.Stop()
	useFirstDecisionSample := true
	var waitReason string
	for {
		if err := ctx.Err(); err != nil {
			cleanupAdmission(cfg.StateDir, runID, "cancelled before start")
			return &AdmissionCanceledError{WaitReason: waitReason, Cause: err}
		}
		admitted := false
		err := withStateLock(cfg.StateDir, func() error {
			if err := pruneStateLocked(cfg.StateDir); err != nil {
				return err
			}
			rec, err := readRecordLocked(cfg.StateDir, runID)
			if err != nil {
				return err
			}
			var decision admissionDecision
			if useFirstDecisionSample {
				decision, err = admissionStateLockedWithSample(cfg.StateDir, rec, source, firstDecisionSample)
			} else {
				decision, err = admissionStateLocked(cfg.StateDir, rec, source)
			}
			if err != nil {
				return err
			}
			useFirstDecisionSample = false
			waitReason = decision.Reason
			notice := hostResourceNotice(decision.Pressure)
			if decision.Reason == "" {
				quota, err := effectiveQuota(cfg.StateDir, source)
				if err != nil {
					return err
				}
				others, err := readLiveRecordsLocked(cfg.StateDir)
				if err != nil {
					return err
				}
				usedCPUs := 0
				for _, other := range others {
					if other.RunID != rec.RunID && (other.Status == StatusStarting || other.Status == StatusRunning || other.Status == StatusStalled || other.Status == StatusPaused) {
						usedCPUs += max(other.CPUsMin, other.GrantedCPUs)
					}
				}
				if rec.CPUsMax > 0 {
					rec.GrantedCPUs = min(rec.CPUsMax, max(rec.CPUsMin, quota.CPUs-usedCPUs))
				}
				rec.ResourceNotice = notice
				rec.Status = StatusStarting
				rec.WaitReason = ""
				if err := writeRecordAtomic(rec); err != nil {
					return err
				}
				if rec.HoldGate != "" {
					if err := writeGateLocked(cfg.StateDir, gateRecord{Name: rec.HoldGate, RunID: runID, PID: parentPID, Identity: parentIdentity}); err != nil {
						return err
					}
				}
				admitted = true
				return nil
			}
			if rec.Status != decision.Status || rec.WaitReason != decision.Reason {
				statusChanged := rec.Status != decision.Status
				rec.Status = decision.Status
				rec.WaitReason = decision.Reason
				rec.ResourceNotice = notice
				if err := writeRecordAtomic(rec); err != nil {
					return err
				}
				if !statusChanged && decision.Status == StatusBlocked {
					return reportIdleQueueLocked(cfg.StateDir, time.Now().UTC())
				}
				if err := appendAdmissionWaitEvents(cfg.StateDir, rec, decision); err != nil {
					return err
				}
				return reportIdleQueueLocked(cfg.StateDir, time.Now().UTC())
			}
			if rec.ResourceNotice != notice {
				rec.ResourceNotice = notice
				if err := writeRecordAtomic(rec); err != nil {
					return err
				}
			}
			return reportIdleQueueLocked(cfg.StateDir, time.Now().UTC())
		})
		if err != nil {
			cleanupAdmission(cfg.StateDir, runID, err.Error())
			return fmt.Errorf("proc: admit run: %w", err)
		}
		if admitted {
			return nil
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func reportIdleQueueLocked(stateDir string, now time.Time) error {
	records, err := readLiveRecordsLocked(stateDir)
	if err != nil {
		return err
	}
	active := false
	for _, rec := range records {
		if rec.Status == StatusStarting || rec.Status == StatusRunning || rec.Status == StatusStalled || rec.Status == StatusPaused {
			active = true
			break
		}
	}
	if active {
		return nil
	}
	waiting := make([]string, 0, len(records))
	eligible := make(map[string]bool)
	for _, rec := range records {
		if (rec.Status == StatusQueued || rec.Status == StatusBlocked) && !rec.IdleReported &&
			!rec.EnqueuedAt.IsZero() && now.Sub(rec.EnqueuedAt) >= idleQueueThreshold {
			waiting = append(waiting, rec.Tag)
			eligible[rec.RunID] = true
		}
	}
	if len(waiting) == 0 {
		return nil
	}
	sort.Strings(waiting)
	event := Event{Schema: EventSchema, At: now, Type: EventIdle, Tag: "queue", Reason: "no active runs while work remains queued", WaitingItems: waiting}
	if err := appendEvent(stateDir, event); err != nil {
		return err
	}
	for index := range records {
		if eligible[records[index].RunID] {
			records[index].IdleReported = true
			if err := writeRecordAtomic(records[index]); err != nil {
				return fmt.Errorf("mark idle queue event for %s: %w", records[index].Tag, err)
			}
		}
	}
	return nil
}

func admissionStateLocked(stateDir string, candidate record, source HostResourceSource) (admissionDecision, error) {
	return admissionStateLockedWithSample(stateDir, candidate, source, source.Snapshot())
}

func admissionStateLockedWithSample(stateDir string, candidate record, source HostResourceSource, sample HostResourceSnapshot) (decision admissionDecision, resultErr error) {
	return admissionStateLockedWithSampleAndClock(stateDir, candidate, source, sample, realAdmissionClock{})
}

func admissionStateLockedWithSampleAndClock(stateDir string, candidate record, source HostResourceSource, sample HostResourceSnapshot, clock admissionClock) (decision admissionDecision, resultErr error) {
	defer func() { decision.Pressure = sample }()
	records, err := readLiveRecordsLocked(stateDir)
	if err != nil {
		return admissionDecision{}, err
	}
	position := 1
	if candidate.WaitGate != "" {
		if _, exists, err := readGateLocked(stateDir, candidate.WaitGate); err != nil {
			return admissionDecision{}, err
		} else if exists {
			return admissionDecision{Reason: "gate: " + candidate.WaitGate, Status: StatusBlocked, Position: position}, nil
		}
	}
	if candidate.HoldGate != "" {
		if _, exists, err := readGateLocked(stateDir, candidate.HoldGate); err != nil {
			return admissionDecision{}, err
		} else if exists {
			return admissionDecision{Reason: "gate: " + candidate.HoldGate, Status: StatusBlocked, Position: position}, nil
		}
		for _, rec := range records {
			if rec.RunID != candidate.RunID && rec.HoldGate == candidate.HoldGate &&
				(rec.Status == StatusQueued || rec.Status == StatusBlocked) && rec.QueueOrder < candidate.QueueOrder {
				return admissionDecision{Reason: "waiting for gate holder " + candidate.HoldGate, Status: StatusBlocked, Position: position}, nil
			}
		}
	}
	if candidate.SlotGroup != "" {
		activeWeight := 0
		queuedBefore := 0
		var agedWaiter *record
		for index := range records {
			rec := &records[index]
			if rec.RunID == candidate.RunID || rec.SlotGroup != candidate.SlotGroup {
				continue
			}
			if cpuTokenStatusActive(rec.Status) {
				activeWeight += slotWeight(*rec)
			}
			if (rec.Status == StatusQueued || rec.Status == StatusBlocked || rec.Status == StatusPaused) && rec.QueueOrder < candidate.QueueOrder {
				if rec.Status != StatusPaused {
					queuedBefore++
				}
				blocked, err := slotWaiterBlockedByGate(stateDir, records, *rec)
				if err != nil {
					return admissionDecision{}, err
				}
				if !blocked && !rec.EnqueuedAt.Add(slotAgingThreshold).After(clock.Now()) && slotWeight(*rec) <= rec.Slots &&
					(agedWaiter == nil || rec.EnqueuedAt.Before(agedWaiter.EnqueuedAt)) {
					agedWaiter = rec
				}
			}
		}
		position += queuedBefore
		weight := slotWeight(candidate)
		if agedWaiter != nil {
			return admissionDecision{Reason: fmt.Sprintf("waiting for aged slot request %s in group %s", agedWaiter.Tag, candidate.SlotGroup), Status: StatusQueued, Position: position}, nil
		}
		quota, err := effectiveQuota(stateDir, source)
		if err != nil {
			return admissionDecision{}, err
		}
		capacity := min(candidate.Slots, quota.CPUs)
		governor, err := readGovernorState(stateDir)
		if err != nil {
			return admissionDecision{}, err
		}
		for _, rec := range records {
			if rec.RunID == candidate.RunID || rec.SlotGroup != candidate.SlotGroup || rec.QueueOrder >= candidate.QueueOrder ||
				!(rec.Status == StatusQueued || rec.Status == StatusBlocked) {
				continue
			}
			blocked, err := slotWaiterBlockedByGate(stateDir, records, rec)
			if err != nil {
				return admissionDecision{}, err
			}
			if blocked || slotWeight(rec) > rec.Slots || activeWeight+governor.UngatedCPUTokens+slotWeight(rec) > capacity {
				continue
			}
			return admissionDecision{Reason: fmt.Sprintf("waiting behind earlier fitting slot request %s in group %s", rec.Tag, candidate.SlotGroup), Status: StatusQueued, Position: position}, nil
		}
		if activeWeight+governor.UngatedCPUTokens+weight > capacity {
			return admissionDecision{Reason: fmt.Sprintf("slot group %s has %d granted and %d measured ungated CPU tokens of %d in use; request needs %d", candidate.SlotGroup, activeWeight, governor.UngatedCPUTokens, capacity, weight), Status: StatusQueued, Position: position}, nil
		}
	}
	quota, err := effectiveQuota(stateDir, source)
	if err != nil {
		return admissionDecision{}, err
	}
	activeUsage := quotaUsage{}
	queuedBefore := 0
	for _, rec := range records {
		if rec.RunID == candidate.RunID {
			continue
		}
		if (rec.Status == StatusQueued || rec.Status == StatusBlocked) && rec.QueueOrder < candidate.QueueOrder && admissionResourcesOverlap(candidate, rec, quota.MinFree) {
			queuedBefore++
		}
		if rec.Status == StatusStarting || rec.Status == StatusRunning || rec.Status == StatusStalled || rec.Status == StatusPaused {
			activeUsage.MemoryBytes += rec.MemoryBytes
			activeUsage.MinCPUs += max(rec.CPUsMin, rec.GrantedCPUs)
			activeUsage.DiskBytes += rec.DiskBytes
		}
	}
	if queuedBefore > 0 {
		return admissionDecision{Reason: fmt.Sprintf("waiting behind %d earlier run(s)", queuedBefore), Status: StatusQueued, Position: position + queuedBefore}, nil
	}
	if reason, err := admissionPressureLockedAt(stateDir, candidate, sample, clock.Now()); err != nil {
		return admissionDecision{}, err
	} else if reason != "" {
		return admissionDecision{Reason: reason, Status: StatusBlocked, Position: position}, nil
	}
	minFree := max(candidate.MinFree, quota.MinFree)
	if candidate.CostClass == CostHeavy && minFree > 0 {
		freeForGovernor, err := hostFreeDiskBytes(stateDir, source)
		if err != nil {
			return admissionDecision{}, err
		}
		if reason := governorAdmissionReason(candidate.CostClass, sample, freeForGovernor, minFree); reason != "" {
			return admissionDecision{Reason: reason, Status: StatusBlocked, Position: position}, nil
		}
	}
	if candidate.DiskBytes > 0 || minFree > 0 {
		free, err := hostFreeDiskBytes(stateDir, source)
		if err != nil {
			return admissionDecision{}, err
		}
		if !diskFits(free, activeUsage.DiskBytes, candidate.DiskBytes, minFree) {
			need := candidate.DiskBytes + minFree
			reason := fmt.Sprintf("disk budget: need %s plus min-free %s, have %s with %s reserved", FormatResourceBytes(candidate.DiskBytes), FormatResourceBytes(minFree), FormatResourceBytes(free), FormatResourceBytes(activeUsage.DiskBytes))
			return admissionDecision{Reason: reason, Status: StatusBlocked, Position: position, DiskNeedBytes: need, DiskFreeBytes: free}, nil
		}
	}
	activeCostedRun := activeUsage.MemoryBytes > 0 || activeUsage.MinCPUs > 0 || activeUsage.DiskBytes > 0
	candidateCostedRun := candidate.MemoryBytes > 0 || candidate.CPUsMin > 0 || candidate.DiskBytes > 0
	if activeCostedRun && candidateCostedRun {
		if !quotaFits(activeUsage, quotaUsage{MemoryBytes: candidate.MemoryBytes, MinCPUs: candidate.CPUsMin}, quota) {
			reason := fmt.Sprintf("memory budget (reserved %s of %s, needs %s)", FormatResourceBytes(activeUsage.MemoryBytes), FormatResourceBytes(quota.MemoryBytes), FormatResourceBytes(candidate.MemoryBytes))
			if activeUsage.MemoryBytes+candidate.MemoryBytes <= quota.MemoryBytes {
				reason = fmt.Sprintf("cpu budget (reserved %d of %d, needs %d)", activeUsage.MinCPUs, quota.CPUs, candidate.CPUsMin)
			}
			return admissionDecision{Reason: reason, Status: StatusBlocked, Position: position}, nil
		}
		if sample.MemoryAvailableKnown && memoryUnavailable(candidate.MemoryBytes, sample.AvailableMemory) {
			reason := fmt.Sprintf("available memory budget (have %s, needs %s)", FormatResourceBytes(sample.AvailableMemory), FormatResourceBytes(candidate.MemoryBytes))
			return admissionDecision{Reason: reason, Status: StatusBlocked, Position: position}, nil
		}
	}
	return admissionDecision{Status: StatusStarting, Position: position}, nil
}

func admissionResourcesOverlap(candidate, earlier record, globalMinFree uint64) bool {
	for _, gate := range []string{candidate.WaitGate, candidate.HoldGate} {
		if gate != "" && (gate == earlier.WaitGate || gate == earlier.HoldGate) {
			return true
		}
	}
	candidateDisk := candidate.DiskBytes > 0 || candidate.MinFree > 0 || globalMinFree > 0
	earlierDisk := earlier.DiskBytes > 0 || earlier.MinFree > 0 || globalMinFree > 0
	if candidateDisk && earlierDisk {
		return true
	}
	return candidate.MemoryBytes > 0 && earlier.MemoryBytes > 0 || candidate.CPUsMin > 0 && earlier.CPUsMin > 0
}

func slotWeight(rec record) int {
	if rec.SlotWeight <= 0 {
		return 1
	}
	return rec.SlotWeight
}

func runStatusActive(status RunStatus) bool {
	return status == StatusStarting || status == StatusRunning || status == StatusStalled || status == StatusPaused
}

func cpuTokenStatusActive(status RunStatus) bool {
	return status == StatusStarting || status == StatusRunning || status == StatusStalled
}

func slotWaiterBlockedByGate(stateDir string, records []record, waiter record) (bool, error) {
	for _, name := range []string{waiter.WaitGate, waiter.HoldGate} {
		if name == "" {
			continue
		}
		if _, exists, err := readGateLocked(stateDir, name); err != nil || exists {
			return exists, err
		}
		if waiter.WaitGate == name {
			for _, holder := range records {
				if holder.RunID != waiter.RunID && holder.HoldGate == name &&
					(holder.Status == StatusQueued || holder.Status == StatusBlocked || runStatusActive(holder.Status)) {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

func appendAdmissionWaitEvents(stateDir string, rec record, decision admissionDecision) error {
	eventType := EventQueued
	if decision.Status == StatusBlocked {
		eventType = EventBlocked
	}
	event := eventFor(rec, eventType)
	event.Reason = decision.Reason
	event.Position = decision.Position
	event.DiskNeedBytes = decision.DiskNeedBytes
	event.DiskFreeBytes = decision.DiskFreeBytes
	event.Pressure = decision.Pressure
	if err := appendEvent(stateDir, event); err != nil {
		return err
	}
	return nil
}

func admissionPressureLockedAt(stateDir string, candidate record, sample HostResourceSnapshot, now time.Time) (string, error) {
	var hold pressureState
	pressurePath := filepath.Join(stateDir, "pressure-state.json")
	if data, readErr := os.ReadFile(pressurePath); readErr == nil {
		if err := json.Unmarshal(data, &hold); err != nil {
			return "", fmt.Errorf("decode pressure state: %w", err)
		}
	} else if !os.IsNotExist(readErr) {
		return "", readErr
	}
	hadPressureState := !hold.LastKnownAt.IsZero() || !hold.UnknownSince.IsZero() || hold.Level != "" || hold.LevelClass != ""
	pressureKnown := pressureSignalsAvailable(sample)
	previousLevel := hold.Level
	if !pressureKnown {
		if !hold.LastKnownAt.IsZero() && now.Sub(hold.LastKnownAt) < pressureStateStalenessBound {
			if pressureLevelBlocks(hold.LevelClass, candidate.CostClass) {
				age := now.Sub(hold.LastKnownAt).Round(time.Second)
				if age < 0 {
					age = 0
				}
				reason := pressureAdmissionWait(hold.LevelClass, hold.LevelSince, false, hold.Level)
				return fmt.Sprintf("%s; last known %s sample %s ago", reason, hold.LevelClass, age), nil
			}
			return "", nil
		}
		if hold.UnknownSince.IsZero() {
			unknownSince := now
			if !hold.LastKnownAt.IsZero() {
				unknownSince = hold.LastKnownAt.Add(pressureStateStalenessBound)
			}
			hold.UnknownSince = unknownSince
			data, err := json.Marshal(hold)
			if err != nil {
				return "", err
			}
			if err := os.WriteFile(pressurePath, data, 0o600); err != nil {
				return "", err
			}
			if hadPressureState {
				event := eventFor(candidate, EventPressure)
				event.Reason = fmt.Sprintf("pressure unknown since %s", hold.UnknownSince.UTC().Format(time.RFC3339))
				event.Pressure = sample
				if err := appendEvent(stateDir, event); err != nil {
					return "", err
				}
			}
		}
		if pressureLevelBlocks(pressureUnknown, candidate.CostClass) {
			return pressureAdmissionWait(pressureUnknown, hold.UnknownSince, false, ""), nil
		}
		return "", nil
	}
	elevated := isElevatedPressure(sample)
	swapGrowing := sample.SwapOutsKnown && hold.SwapOutsKnown && sample.SwapOuts > hold.SwapOuts
	swapUsedGrowing := sample.SwapUsedBytes > hold.SwapUsedBytes && hold.SwapUsedBytes > 0
	pressureRising := elevated || swapGrowing || swapUsedGrowing
	blocked := hold.blocks(pressureRising, now)
	level := classifyPressure(sample)
	if pressureRising && !elevated {
		level = pressureCritical
	}
	if elevated {
		hold.Level = pressureWaitReason(sample)
	} else if swapGrowing {
		hold.Level = fmt.Sprintf("host pressure (swapouts increased from %d to %d)", hold.SwapOuts, sample.SwapOuts)
	} else if swapUsedGrowing {
		hold.Level = fmt.Sprintf("host pressure (swap used increased from %s to %s)", FormatResourceBytes(hold.SwapUsedBytes), FormatResourceBytes(sample.SwapUsedBytes))
	}
	if pressureRising && (hold.LevelClass != level || hold.LevelSince.IsZero()) {
		hold.LevelSince = now
	}
	if pressureRising {
		hold.LevelClass = level
	} else if !blocked {
		if hold.LevelClass != pressureNormal || hold.LevelSince.IsZero() {
			hold.LevelSince = now
		}
		hold.Level, hold.LevelClass = string(pressureNormal), pressureNormal
	}
	hold.UnknownSince = time.Time{}
	hold.SwapOuts, hold.SwapOutsKnown = sample.SwapOuts, sample.SwapOutsKnown
	hold.SwapUsedBytes = sample.SwapUsedBytes
	hold.LastKnownAt = now
	data, err := json.Marshal(hold)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(pressurePath, data, 0o600); err != nil {
		return "", err
	}
	if hadPressureState && previousLevel != hold.Level {
		event := eventFor(candidate, EventPressure)
		event.Reason = hold.Level
		event.Pressure = sample
		if err := appendEvent(stateDir, event); err != nil {
			return "", err
		}
	}
	if blocked && pressureLevelBlocks(hold.LevelClass, candidate.CostClass) {
		if swapGrowing && !elevated {
			return fmt.Sprintf("waiting for host pressure to return to normal; current: critical since %s (swapouts increased to %d)", hold.LevelSince.UTC().Format(time.RFC3339), sample.SwapOuts), nil
		}
		if swapUsedGrowing && !elevated {
			return fmt.Sprintf("waiting for host pressure to return to normal; current: critical since %s (swap used increased to %s)", hold.LevelSince.UTC().Format(time.RFC3339), FormatResourceBytes(sample.SwapUsedBytes)), nil
		}
		return pressureAdmissionWait(hold.LevelClass, hold.LevelSince, !elevated, hold.Level), nil
	}
	return "", nil
}

func learnedUsage(records []record, key string) quotaUsage {
	if key == "" {
		return quotaUsage{}
	}
	var history []record
	for _, rec := range records {
		if rec.CostKey == key && rec.Status == StatusCompleted && !rec.MeasurementPartial && rec.PeakRSSBytes > 0 {
			history = append(history, rec)
		}
	}
	if len(history) > 5 {
		history = history[len(history)-5:]
	}
	var peak record
	for _, rec := range history {
		if rec.PeakRSSBytes > peak.PeakRSSBytes {
			peak = rec
		}
	}
	return quotaUsage{MemoryBytes: peak.PeakRSSBytes, MinCPUs: int(peak.AverageCPU + 0.999)}
}

func withStateLock(stateDir string, action func() error) (err error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(stateDir, "state.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open state lock: %w", err)
	}
	unlock, err := lockFile(file)
	if err != nil {
		return errors.Join(fmt.Errorf("lock run state: %w", err), file.Close())
	}
	defer func() { err = errors.Join(err, unlock(), file.Close()) }()
	return action()
}

// readQueueSequenceLocked returns the current enqueue watermark without
// consuming it. Every run bumps the sequence exactly once at enqueue, under
// the state lock, so waiters use it as an O(1) change signal for "a run was
// enqueued after my last registry consult".
func readQueueSequenceLocked(stateDir string) (uint64, error) {
	data, err := os.ReadFile(filepath.Join(stateDir, "queue-sequence"))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if len(data) == 0 {
		return 0, nil
	}
	order, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("decode queue sequence: %w", err)
	}
	return order, nil
}

func nextQueueOrderLocked(stateDir string) (uint64, error) {
	order, err := readQueueSequenceLocked(stateDir)
	if err != nil {
		return 0, err
	}
	if order == ^uint64(0) {
		return 0, errors.New("queue sequence exhausted")
	}
	order++
	if err := os.WriteFile(filepath.Join(stateDir, "queue-sequence"), []byte(strconv.FormatUint(order, 10)+"\n"), 0o600); err != nil {
		return 0, fmt.Errorf("write queue sequence: %w", err)
	}
	return order, nil
}

// readLiveRecordsLocked returns the records of runs that have not reached a
// terminal status. The live set is the admission working set: every per-tick
// admission path reads exactly this set, so its cost never grows with
// finished history.
func readLiveRecordsLocked(stateDir string) ([]record, error) {
	paths, err := filepath.Glob(filepath.Join(liveRecordsDir(stateDir), "*.json"))
	if err != nil {
		return nil, err
	}
	return readRecordFiles(paths)
}

// readAllRecordsLocked returns live records plus finished history. Finished
// records win over a same-ID live file, which only coexists with them inside
// the retirement window between writeRecordAtomic's write and removal.
func readAllRecordsLocked(stateDir string) ([]record, error) {
	paths, err := filepath.Glob(filepath.Join(liveRecordsDir(stateDir), "*.json"))
	if err != nil {
		return nil, err
	}
	finishedPaths, err := filepath.Glob(filepath.Join(finishedRecordsDir(stateDir), "*.json"))
	if err != nil {
		return nil, err
	}
	records, err := readRecordFiles(paths)
	if err != nil {
		return nil, err
	}
	finished, err := readRecordFiles(finishedPaths)
	if err != nil {
		return nil, err
	}
	byRunID := make(map[string]record, len(records)+len(finished))
	for _, rec := range records {
		byRunID[rec.RunID] = rec
	}
	for _, rec := range finished {
		byRunID[rec.RunID] = rec
	}
	all := make([]record, 0, len(byRunID))
	for _, rec := range byRunID {
		all = append(all, rec)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].QueueOrder < all[j].QueueOrder })
	return all, nil
}

func readRecordFiles(paths []string) ([]record, error) {
	records := make([]record, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read run record %s: %w", path, err)
		}
		var rec record
		if err := json.Unmarshal(data, &rec); err != nil {
			return nil, fmt.Errorf("decode run record %s: %w", path, err)
		}
		records = append(records, rec)
	}
	return records, nil
}

// runRecordLocation owns paths and lookup for a run ID while its record moves
// from the live registry to finished history. Finished is authoritative during
// the atomic transition where both files can briefly exist.
type runRecordLocation struct {
	stateDir string
	runID    string
}

func recordLocation(stateDir, runID string) runRecordLocation {
	return runRecordLocation{stateDir: stateDir, runID: runID}
}

func (location runRecordLocation) path(status RunStatus) string {
	if status.Terminal() {
		return filepath.Join(location.stateDir, "runs", "finished", location.runID+".json")
	}
	return filepath.Join(location.stateDir, "runs", location.runID+".json")
}

func (location runRecordLocation) temporaryPath(status RunStatus) string {
	return location.path(status) + ".tmp"
}

func (location runRecordLocation) liveDirectory() string {
	return filepath.Dir(location.path(StatusRunning))
}

func (location runRecordLocation) finishedDirectory() string {
	return filepath.Dir(location.path(StatusCompleted))
}

func (location runRecordLocation) currentPath() (string, error) {
	finished := location.path(StatusCompleted)
	if _, err := os.Stat(finished); err == nil {
		return finished, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect finished run record %s: %w", location.runID, err)
	}
	live := location.path(StatusRunning)
	if _, err := os.Stat(live); err == nil {
		return live, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect live run record %s: %w", location.runID, err)
	}
	return "", fmt.Errorf("run record %s: %w", location.runID, os.ErrNotExist)
}

func liveRecordsDir(stateDir string) string {
	return recordLocation(stateDir, "").liveDirectory()
}

func finishedRecordsDir(stateDir string) string {
	return recordLocation(stateDir, "").finishedDirectory()
}

func readRecordLocked(stateDir, runID string) (record, error) {
	path, err := recordLocation(stateDir, runID).currentPath()
	if err != nil {
		return record{}, fmt.Errorf("read queued run %s: %w", runID, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return record{}, fmt.Errorf("read queued run %s from %s: %w", runID, path, err)
	}
	var rec record
	if err := json.Unmarshal(data, &rec); err != nil {
		return record{}, fmt.Errorf("decode queued run %s: %w", runID, err)
	}
	return rec, nil
}

func writeRecordAtomic(rec record) error {
	location := recordLocation(rec.StateDir, rec.RunID)
	terminal := rec.Status.Terminal()
	path := location.path(rec.Status)
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := location.temporaryPath(rec.Status)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return errors.Join(err, os.Remove(tmp))
	}
	if terminal {
		if err := os.Remove(location.path(StatusRunning)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func gatePath(stateDir, name string) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(name))
	return filepath.Join(stateDir, "gates", encoded+".json")
}

func writeGateLocked(stateDir string, gate gateRecord) error {
	if err := os.MkdirAll(filepath.Dir(gatePath(stateDir, gate.Name)), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(gate)
	if err != nil {
		return err
	}
	path := gatePath(stateDir, gate.Name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return errors.Join(err, os.Remove(tmp))
	}
	return nil
}

func readGateLocked(stateDir, name string) (gateRecord, bool, error) {
	path := gatePath(stateDir, name)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return gateRecord{}, false, nil
	}
	if err != nil {
		return gateRecord{}, false, err
	}
	var gate gateRecord
	if err := json.Unmarshal(data, &gate); err != nil {
		return gateRecord{}, false, fmt.Errorf("decode gate %q: %w", name, err)
	}
	identity, alive, identityErr := inspectIdentity(gate.PID)
	if identityErr != nil {
		return gateRecord{}, false, fmt.Errorf("inspect gate holder %d: %w", gate.PID, identityErr)
	}
	if !alive || identity != gate.Identity {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return gateRecord{}, false, err
		}
		return gateRecord{}, false, nil
	}
	return gate, true, nil
}

func pruneStateLocked(stateDir string) error {
	paths, err := filepath.Glob(filepath.Join(liveRecordsDir(stateDir), "*.json"))
	if err != nil {
		return err
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read run record %s: %w", path, err)
		}
		var rec record
		if err := json.Unmarshal(data, &rec); err != nil {
			return fmt.Errorf("decode run record %s: %w", path, err)
		}
		if _, err := os.Stat(recordLocation(stateDir, rec.RunID).path(StatusCompleted)); err == nil {
			// The finished record is the registry's truth. This live file is a
			// leftover from a crash between writeRecordAtomic's finished write
			// and its live removal; removing it — never routing it through a
			// status transition — keeps the recorded exit intact.
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		} else if !os.IsNotExist(err) {
			return err
		}
		if rec.Status.Terminal() {
			// The live set holds no terminal record: retire this one into the
			// finished set so per-tick admission and wait paths never rescan
			// it. Older state directories and interrupted transitions are the
			// inputs that violate the invariant; renaming preserves the bytes.
			if err := os.MkdirAll(finishedRecordsDir(stateDir), 0o700); err != nil {
				return err
			}
			if err := os.Rename(path, recordLocation(stateDir, rec.RunID).path(StatusCompleted)); err != nil {
				return fmt.Errorf("retire finished record %s: %w", rec.RunID, err)
			}
			continue
		}
		switch rec.Status {
		case StatusRunning, StatusStalled, StatusStarting, StatusPaused:
			if err := markLostLocked(stateDir, rec); err != nil {
				return fmt.Errorf("prune run %s: %w", rec.RunID, err)
			}
		case StatusQueued, StatusBlocked:
			identity, alive, identityErr := inspectIdentity(rec.PID)
			if identityErr != nil {
				return fmt.Errorf("inspect keeper %d for run %s: %w", rec.PID, rec.RunID, identityErr)
			}
			if alive && identity == rec.StartedAt {
				continue
			}
			if err := os.Remove(recordLocation(stateDir, rec.RunID).path(StatusRunning)); err != nil && !os.IsNotExist(err) {
				return err
			}
		default:
			// No writer produces a record without a known status, so a live
			// file with one is a corrupt registry, not history.
			return fmt.Errorf("decode run record %s: unknown run status %q", path, rec.Status)
		}
	}
	paths, err = filepath.Glob(filepath.Join(stateDir, "gates", "*.json"))
	if err != nil {
		return err
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var gate gateRecord
		if err := json.Unmarshal(data, &gate); err != nil {
			return fmt.Errorf("decode gate record %s: %w", path, err)
		}
		identity, alive, identityErr := inspectIdentity(gate.PID)
		if identityErr != nil {
			return fmt.Errorf("inspect gate holder %d: %w", gate.PID, identityErr)
		}
		if !alive || identity != gate.Identity {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

// recordObservedKeeperLoss finalizes a keeper that this run's own Wait observed
// exit. Registry readers use the same locked transition when they discover a
// stale identity first.
func recordObservedKeeperLoss(stateDir, runID string, fallback record) error {
	return withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) || fallback.RunID != runID {
				return err
			}
			rec = fallback
			rec.StateDir = stateDir
			if err := writeRecordAtomic(rec); err != nil {
				return fmt.Errorf("restore ready run record %s before loss cleanup: %w", runID, err)
			}
		}
		if rec.Status.Terminal() {
			return nil
		}
		return markLostLocked(stateDir, rec)
	})
}

func markLostLocked(stateDir string, rec record) error {
	if rec.Status != StatusStarting && rec.Status != StatusRunning && rec.Status != StatusStalled && rec.Status != StatusPaused {
		return nil
	}
	identity, alive, err := inspectIdentity(rec.PID)
	if err != nil {
		return fmt.Errorf("inspect keeper %d for run %s: %w", rec.PID, rec.RunID, err)
	}
	if alive && identity == rec.StartedAt {
		return nil
	}
	cleanup := cleanupLostRun(rec, osProcessSource{})
	resources, resourceErr := cleanupResourcesLocked(stateDir, rec.RunID)
	resourceErr = errors.Join(resourceErr, resourceOutcomesError(resources))
	scratch := rec.Scratch
	var scratchErr error
	if scratch != "" {
		scratchOutcome, err := cleanupScratchOutcome(stateDir, scratch, fileIdentity{Device: rec.ScratchDevice, Inode: rec.ScratchInode}, rec.Keep)
		scratchErr = err
		if persistErr := appendResourceOutcomeLocked(stateDir, rec.RunID, scratchOutcome); persistErr != nil {
			scratchErr = errors.Join(scratchErr, fmt.Errorf("persist scratch cleanup outcome: %w", persistErr))
		}
		if scratchErr != nil {
			resourceErr = errors.Join(resourceErr, fmt.Errorf("remove run scratch: %w", scratchErr))
		}
	}
	storedResources, err := readRunResources(stateDir, rec.RunID)
	if err != nil {
		return fmt.Errorf("read persisted cleanup outcomes for lost run %s: %w", rec.RunID, err)
	}
	rec.Resources = storedResources
	rec.Status = StatusLost
	rec.Error = fmt.Sprintf("keeper PID %d identity %s is no longer live", rec.PID, rec.StartedAt)
	if cleanup.err != nil {
		rec.Error += "; " + cleanup.err.Error()
	}
	if resourceErr != nil {
		rec.Status = StatusDirty
		rec.Error += "; resource or scratch cleanup failed: " + resourceErr.Error()
		if scratchErr != nil {
			rec.Error += fmt.Sprintf("; scratch path %q cleanup failed: %v", scratch, scratchErr)
		}
	}
	if err := writeRecordAtomic(rec); err != nil {
		return fmt.Errorf("record lost run %s: %w", rec.RunID, err)
	}
	lost := eventFor(rec, EventLost)
	lost.Error = rec.Error
	if err := appendEvent(stateDir, lost); err != nil {
		return fmt.Errorf("record lost event for run %s: %w", rec.RunID, err)
	}
	teardown := eventFor(rec, EventTeardown)
	teardown.Reaped = cleanup.Reaped
	teardown.Unverified = cleanup.Unverified
	teardown.Remaining = cleanup.Remaining
	if cleanup.err != nil {
		teardown.Error = cleanup.err.Error()
	}
	if err := appendEvent(stateDir, teardown); err != nil {
		return fmt.Errorf("record lost teardown for run %s: %w", rec.RunID, err)
	}
	if rec.HoldGate != "" {
		gate, exists, err := readGateLocked(stateDir, rec.HoldGate)
		if err != nil {
			return err
		}
		if exists && gate.RunID == rec.RunID {
			if err := os.Remove(gatePath(stateDir, rec.HoldGate)); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func cleanupAdmission(stateDir, runID, reason string) {
	if err := withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if rec.Status.Terminal() {
			return nil
		}
		if rec.HoldGate != "" {
			gate, exists, err := readGateLocked(stateDir, rec.HoldGate)
			if err != nil {
				return err
			}
			if exists && gate.RunID == runID {
				if err := os.Remove(gatePath(stateDir, rec.HoldGate)); err != nil && !os.IsNotExist(err) {
					return err
				}
			}
		}
		scratch := rec.Scratch
		if scratch == "" {
			var pathErr error
			scratch, pathErr = runScratchPath(runID)
			if pathErr != nil {
				event := eventFor(rec, EventTeardown)
				event.Reason = reason
				event.Error = pathErr.Error()
				rec.Status, rec.Error = StatusFailed, pathErr.Error()
				event.Status = rec.Status
				if err := writeRecordAtomic(rec); err != nil {
					return errors.Join(pathErr, err)
				}
				return appendEvent(stateDir, event)
			}
		}
		event := eventFor(rec, EventTeardown)
		event.Reason = reason
		var scratchErr error
		if scratch != "" {
			scratchOutcome, err := cleanupScratchOutcome(stateDir, scratch, fileIdentity{Device: rec.ScratchDevice, Inode: rec.ScratchInode}, rec.Keep)
			scratchErr = err
			if persistErr := appendResourceOutcomeLocked(stateDir, runID, scratchOutcome); persistErr != nil {
				scratchErr = errors.Join(scratchErr, fmt.Errorf("persist scratch cleanup outcome: %w", persistErr))
			}
			rec.Resources, err = readRunResources(stateDir, runID)
			if err != nil {
				return err
			}
			if scratchErr != nil {
				event.Error = scratchErr.Error()
				rec.Status, rec.Error = StatusDirty, scratchErr.Error()
			} else {
				rec.Status, rec.Error = StatusFailed, reason
			}
		} else {
			rec.Status, rec.Error = StatusFailed, reason
		}
		event.Status = rec.Status
		if err := writeRecordAtomic(rec); err != nil {
			return errors.Join(scratchErr, err)
		}
		if err := appendEvent(stateDir, event); err != nil {
			return err
		}
		return nil
	}); err != nil {
		fmt.Fprintf(os.Stderr, "proc: remove incomplete admission %s: %v\n", runID, err)
	}
}

func updateRecord(stateDir, runID string, update func(*record) error) error {
	return withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			return err
		}
		original := rec
		original.Command = append([]string(nil), rec.Command...)
		original.Observed = append([]Process(nil), rec.Observed...)
		original.Keep = append([]string(nil), rec.Keep...)
		if rec.ExitCode != nil {
			code := *rec.ExitCode
			original.ExitCode = &code
		}
		if err := update(&rec); err != nil {
			return err
		}
		if reflect.DeepEqual(rec, original) {
			return nil
		}
		return writeRecordAtomic(rec)
	})
}

func completeRecord(stateDir, runID string, code *int, signal string, duration time.Duration, final record) error {
	return updateRecord(stateDir, runID, func(rec *record) error {
		if rec.Status != StatusDirty && rec.Status != StatusLost {
			if final.Status.Terminal() {
				rec.Status = final.Status
			} else {
				rec.Status = exitStatus(code, signal, final.Error)
			}
		}
		rec.ExitCode = code
		rec.Signal = signal
		rec.DurationMS = duration.Milliseconds()
		rec.Observed = final.Observed
		rec.PeakRSSBytes, rec.AverageCPU, rec.MeasurementPartial = final.PeakRSSBytes, final.AverageCPU, final.MeasurementPartial
		rec.OverBudget, rec.LimitsAdvisory, rec.GrantedCPUs = final.OverBudget, final.LimitsAdvisory, final.GrantedCPUs
		rec.WaitReason = ""
		return nil
	})
}

func WaitTag(ctx context.Context, stateDir, tag string) (RunInfo, error) {
	return waitRun(ctx, stateDir, tag, waitByTag, 0)
}

func WaitLatestTag(ctx context.Context, stateDir, tag string) (RunInfo, error) {
	return WaitLatestTagWithin(ctx, stateDir, tag, 2*time.Minute)
}

// WaitLatestTagWithin limits only the time allowed for a matching record to appear.
func WaitLatestTagWithin(ctx context.Context, stateDir, tag string, appearWithin time.Duration) (RunInfo, error) {
	if appearWithin < 0 {
		return RunInfo{}, errors.New("proc: appearance window must not be negative")
	}
	return waitRun(ctx, stateDir, tag, waitByLatestTag, appearWithin)
}

// WaitRunID waits for one known run identity, independently of tag reuse.
func WaitRunID(ctx context.Context, stateDir, runID string) (RunInfo, error) {
	if runID == "" {
		return RunInfo{}, errors.New("proc: run ID is required")
	}
	return waitRun(ctx, stateDir, runID, waitByRunID, 0)
}

type waitMode uint8

const (
	waitByTag waitMode = iota
	waitByLatestTag
	waitByRunID
)

// selectWaitMatch applies the selected tag or run identity to one record set.
func selectWaitMatch(records []record, key string, mode waitMode) (*record, error) {
	var match *record
	for i := range records {
		matches := records[i].Tag == key
		switch mode {
		case waitByLatestTag:
			matches = records[i].LatestTag == key
		case waitByRunID:
			matches = records[i].RunID == key
		}
		if !matches {
			continue
		}
		if mode == waitByTag && match != nil {
			return nil, fmt.Errorf("tag %q identifies more than one run", key)
		}
		if match == nil || records[i].EnqueuedAt.After(match.EnqueuedAt) ||
			(mode == waitByLatestTag && records[i].EnqueuedAt.Equal(match.EnqueuedAt) && records[i].RunID > match.RunID) {
			copy := records[i]
			match = &copy
		}
	}
	return match, nil
}

// terminalWaitInfo renders a terminal match for the waiter, or reports that
// the wait continues.
func terminalWaitInfo(match *record) (RunInfo, bool) {
	if match == nil || !match.Status.Terminal() {
		return RunInfo{}, false
	}
	switch match.Status {
	case StatusCompleted, StatusFailed, StatusDead:
		if match.ExitCode != nil || match.Signal != "" {
			return runInfoFromRecord(match), true
		}
	case StatusLost, StatusDirty:
		return runInfoFromRecord(match), true
	}
	return RunInfo{}, false
}

func runInfoFromRecord(rec *record) RunInfo {
	return RunInfo{RunID: rec.RunID, Tag: rec.Tag, PID: RecordedKeeperPID(rec.PID), StartedAt: runStartedAt(*rec), Identity: rec.StartedAt, Status: rec.Status, Command: rec.Command, SlotGroup: rec.SlotGroup, ExitCode: rec.ExitCode, Signal: rec.Signal, DurationMS: rec.DurationMS, Error: rec.Error, ResourceOutcomes: rec.Resources}
}

// waitRun polls the selected tag or run identity until it reaches a terminal state. The full
// registry is consulted once at the start; every tick afterwards reads only
// the live set, the matched run's record by ID, and the O(1) enqueue
// watermark, so the wait never rescans finished history per tick. A watermark
// change means a run was enqueued after the last consult — it may already
// have finished and retired between two polls, so that tick resolves the full
// registry once.
type WaitNotFoundError struct {
	LatestTag string
}

func (err *WaitNotFoundError) Error() string {
	return fmt.Sprintf("not-found: no run record appeared for latest tag %q", err.LatestTag)
}

func waitRun(ctx context.Context, stateDir, key string, mode waitMode, appearWithin time.Duration) (RunInfo, error) {
	if ctx == nil {
		return RunInfo{}, errors.New("proc: wait context is required")
	}
	var match *record
	var consultSeq uint64
	err := withStateLock(stateDir, func() error {
		if err := pruneStateLocked(stateDir); err != nil {
			return err
		}
		records, err := readAllRecordsLocked(stateDir)
		if err != nil {
			return err
		}
		match, err = selectWaitMatch(records, key, mode)
		if err != nil {
			return err
		}
		consultSeq, err = readQueueSequenceLocked(stateDir)
		return err
	})
	if err != nil {
		return RunInfo{}, err
	}
	if info, done := terminalWaitInfo(match); done {
		return info, nil
	}
	lastMatchedRunID := ""
	if match != nil {
		lastMatchedRunID = match.RunID
	}
	appearanceDeadline := time.Time{}
	if mode == waitByLatestTag && lastMatchedRunID == "" {
		appearanceDeadline = time.Now().Add(appearWithin)
	}
	ticker := time.NewTicker(admissionPollInterval)
	defer ticker.Stop()
	for {
		if !appearanceDeadline.IsZero() && !time.Now().Before(appearanceDeadline) && lastMatchedRunID == "" && match == nil {
			return RunInfo{}, &WaitNotFoundError{LatestTag: key}
		}
		err := withStateLock(stateDir, func() error {
			if err := pruneStateLocked(stateDir); err != nil {
				return err
			}
			seq, err := readQueueSequenceLocked(stateDir)
			if err != nil {
				return err
			}
			if seq != consultSeq {
				consultSeq = seq
				records, err := readAllRecordsLocked(stateDir)
				if err != nil {
					return err
				}
				match, err = selectWaitMatch(records, key, mode)
				return err
			}
			live, err := readLiveRecordsLocked(stateDir)
			if err != nil {
				return err
			}
			match, err = selectWaitMatch(live, key, mode)
			if err != nil {
				return err
			}
			if match == nil && lastMatchedRunID != "" {
				rec, err := readRecordLocked(stateDir, lastMatchedRunID)
				if err != nil && !os.IsNotExist(err) {
					return err
				}
				if err == nil {
					match = &rec
				}
			}
			return nil
		})
		if err != nil {
			return RunInfo{}, err
		}
		if match != nil && lastMatchedRunID == "" {
			lastMatchedRunID = match.RunID
		}
		if match != nil {
			lastMatchedRunID = match.RunID
		}
		if info, done := terminalWaitInfo(match); done {
			return info, nil
		}
		select {
		case <-ctx.Done():
			return RunInfo{}, fmt.Errorf("wait for run %q: %w", key, ctx.Err())
		case <-ticker.C:
		}
	}
}

func claimGate(stateDir, runID, name string, pid int, identity string) error {
	if name == "" {
		return nil
	}
	return withStateLock(stateDir, func() error {
		gate, exists, err := readGateLocked(stateDir, name)
		if err != nil {
			return err
		}
		if !exists || gate.RunID != runID {
			return fmt.Errorf("gate %q reservation was lost before keeper startup", name)
		}
		gate.PID, gate.Identity = pid, identity
		return writeGateLocked(stateDir, gate)
	})
}

func releaseGate(stateDir, runID, name string) error {
	if name == "" {
		return nil
	}
	return withStateLock(stateDir, func() error {
		gate, exists, err := readGateLocked(stateDir, name)
		if err != nil || !exists || gate.RunID != runID {
			return err
		}
		if err := os.Remove(gatePath(stateDir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	})
}
