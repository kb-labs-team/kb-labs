//go:build darwin || linux

package proc

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// WriteRunRecord persists a run through the same atomic registry used by Start.
// It is used by alternate supervisors that execute commands without a keeper.
func WriteRunRecord(stateDir string, info RunInfo) error {
	if info.RunID == "" || info.Tag == "" {
		return errors.New("proc: run record requires run ID and tag")
	}
	if _, err := runScratchPath(info.RunID); err != nil {
		return fmt.Errorf("proc: invalid run record ID: %w", err)
	}
	startedAt := time.Time{}
	if info.StartedAt != nil {
		startedAt = *info.StartedAt
	}
	rec := record{
		RunID: info.RunID, Tag: info.Tag, PID: int(info.PID),
		StartedAt: info.Identity, StartedAtTime: startedAt,
		Command: append([]string(nil), info.Command...), StateDir: stateDir,
		Status: info.Status, Error: info.Error, SlotGroup: info.SlotGroup,
		CostKey: info.CostKey, CostClass: info.CostClass, Priority: info.Priority,
		MemoryBytes: info.MemoryBytes, CPUsMin: info.CPUsMin, CPUsMax: info.CPUsMax,
		DiskBytes: info.DiskBytes, GrantedCPUs: info.GrantedCPUs,
		PeakRSSBytes: info.PeakRSSBytes, AverageCPU: info.AverageCPU,
		PausedMS: info.PausedMS, MeasurementPartial: info.MeasurementPartial,
		LimitsAdvisory: info.LimitsAdvisory, OverBudget: info.OverBudget,
		ResourceNotice: info.ResourceNotice, DurationMS: info.DurationMS,
		Observed: append([]Process(nil), info.Tree...), ExitCode: info.ExitCode,
		Signal: info.Signal,
	}
	return withStateLock(stateDir, func() error {
		queued, err := readRecordLocked(stateDir, rec.RunID)
		if err == nil {
			rec.SlotGroup, rec.Slots, rec.QueueOrder = queued.SlotGroup, queued.Slots, queued.QueueOrder
			rec.EnqueuedAt, rec.WaitGate, rec.HoldGate = queued.EnqueuedAt, queued.WaitGate, queued.HoldGate
			rec.CostKey, rec.CostClass, rec.MemoryBytes, rec.CPUsMin, rec.CPUsMax, rec.DiskBytes = queued.CostKey, queued.CostClass, queued.MemoryBytes, queued.CPUsMin, queued.CPUsMax, queued.DiskBytes
			rec.GrantedCPUs, rec.ResourceNotice = queued.GrantedCPUs, queued.ResourceNotice
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if rec.Status == "" {
			rec.Status = StatusStarting
		}
		return writeRecordAtomic(rec)
	})
}

// ReadRunRecord reads one live or terminal record through proc's record owner.
func ReadRunRecord(stateDir, runID string) (RunInfo, error) {
	var rec record
	err := withStateLock(stateDir, func() error {
		var err error
		rec, err = readRecordLocked(stateDir, runID)
		return err
	})
	if err != nil {
		return RunInfo{}, err
	}
	return runInfoFromRecord(&rec), nil
}

// ListRunRecords reads the durable registry without sampling the host process table.
func ListRunRecords(stateDir string) ([]RunInfo, error) {
	var records []record
	err := withStateLock(stateDir, func() error {
		var err error
		records, err = readAllRecordsLocked(stateDir)
		return err
	})
	if err != nil {
		return nil, err
	}
	infos := make([]RunInfo, len(records))
	for index := range records {
		infos[index] = runInfoFromRecord(&records[index])
	}
	return infos, nil
}
