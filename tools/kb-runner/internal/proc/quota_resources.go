//go:build darwin || linux

package proc

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const pressureNormalDuration = 10 * time.Second

const pressureStateStalenessBound = 2 * time.Minute

const pressurePSIThreshold = 10.0

const lowAvailableMemoryFraction = 10

const highLoadPerLogicalCPU = 1.5

type quotaUsage struct {
	MemoryBytes uint64
	MinCPUs     int
	DiskBytes   uint64
}

type CostClass string

const (
	CostLight CostClass = "light"
	CostHeavy CostClass = "heavy"
)

type pressureLevel string

const (
	pressureNormal   pressureLevel = "normal"
	pressureWarn     pressureLevel = "warn"
	pressureCritical pressureLevel = "critical"
	pressureUnknown  pressureLevel = "unknown"
)

func ParseCostClass(value string) (CostClass, error) {
	class := CostClass(value)
	if class != CostLight && class != CostHeavy {
		return "", fmt.Errorf("cost must be light or heavy")
	}
	return class, nil
}

type hostQuota struct {
	MemoryBytes uint64
	CPUs        int
	MinFree     uint64
}

type HostResourceSnapshot struct {
	PhysicalMemory       uint64            `json:"physical_memory_bytes"`
	AvailableMemory      uint64            `json:"available_memory_bytes"`
	MemoryAvailableKnown bool              `json:"memory_available_known"`
	PressureAvailable    bool              `json:"pressure_available"`
	LoadAvailable        bool              `json:"load_available"`
	LogicalCPUs          int               `json:"logical_cpus"`
	Pressure             string            `json:"pressure"`
	Load1                float64           `json:"load_1m"`
	CPUPressure          float64           `json:"cpu_pressure_percent"`
	Swap                 string            `json:"swap,omitempty"`
	SwapUsedBytes        uint64            `json:"swap_used_bytes"`
	SwapTotalBytes       uint64            `json:"swap_total_bytes"`
	SwapOuts             uint64            `json:"swap_outs"`
	SwapOutsKnown        bool              `json:"swap_outs_known"`
	FreeDiskBytes        uint64            `json:"free_disk_bytes"`
	FreeDiskKnown        bool              `json:"free_disk_known"`
	Unavailable          map[string]string `json:"unavailable,omitempty"`
	CgroupMemory         uint64            `json:"cgroup_memory_bytes,omitempty"`
	CgroupCPUs           int               `json:"cgroup_cpus,omitempty"`
	CgroupCPUsKnown      bool              `json:"cgroup_cpus_known,omitempty"`
}

func hostResourceNotice(sample HostResourceSnapshot) string {
	keys := make([]string, 0, len(sample.Unavailable))
	for key := range sample.Unavailable {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+" unavailable: "+sample.Unavailable[key])
	}
	return strings.Join(parts, "; ")
}

// HostResourceSource supplies one host resource sample to admission. Start uses
// the current host reader; callers that coordinate several clients can inject
// the same source into every admission poll.
type HostResourceSource interface{ Snapshot() HostResourceSnapshot }

type quotaFile struct {
	MemoryBytes   *uint64 `json:"memory_bytes,omitempty"`
	MemoryPercent *int    `json:"memory_percent,omitempty"`
	CPUs          *int    `json:"cpus,omitempty"`
	MinFree       *uint64 `json:"min_free_bytes,omitempty"`
}

func effectiveQuota(stateDir string, source HostResourceSource) (hostQuota, error) {
	sample := source.Snapshot()
	quota := hostQuota{MemoryBytes: sample.PhysicalMemory * 70 / 100, CPUs: max(1, sample.LogicalCPUs-2)}
	data, err := os.ReadFile(filepath.Join(stateDir, "quota.json"))
	if os.IsNotExist(err) {
		if sample.CgroupMemory > 0 && sample.CgroupMemory < quota.MemoryBytes {
			quota.MemoryBytes = sample.CgroupMemory
		}
		if sample.CgroupCPUsKnown && sample.CgroupCPUs < quota.CPUs {
			quota.CPUs = sample.CgroupCPUs
		}
		return quota, nil
	}
	if err != nil {
		return hostQuota{}, err
	}
	var stored quotaFile
	if err := json.Unmarshal(data, &stored); err != nil {
		return hostQuota{}, fmt.Errorf("decode quota.json: %w", err)
	}
	if stored.MemoryBytes != nil {
		quota.MemoryBytes = *stored.MemoryBytes
	}
	if stored.MemoryPercent != nil {
		quota.MemoryBytes = sample.PhysicalMemory * uint64(*stored.MemoryPercent) / 100
	}
	if stored.CPUs != nil {
		quota.CPUs = *stored.CPUs
	}
	if stored.MinFree != nil {
		quota.MinFree = *stored.MinFree
	}
	if sample.CgroupMemory > 0 && sample.CgroupMemory < quota.MemoryBytes {
		quota.MemoryBytes = sample.CgroupMemory
	}
	if sample.CgroupCPUsKnown && sample.CgroupCPUs < quota.CPUs {
		quota.CPUs = sample.CgroupCPUs
	}
	return quota, nil
}

func writeQuota(stateDir string, quota quotaFile) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(quota)
	if err != nil {
		return err
	}
	tmp := filepath.Join(stateDir, "quota.json.tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(stateDir, "quota.json")); err != nil {
		return fmt.Errorf("write quota.json: %w", err)
	}
	return nil
}

type QuotaStatus struct {
	MemoryBytes uint64
	CPUs        int
	MinFree     uint64
	MemorySet   bool
	CPUsSet     bool
	MinFreeSet  bool
	Resources   HostResourceSnapshot
}

func ShowQuota(stateDir string) (QuotaStatus, error) {
	var status QuotaStatus
	err := withStateLock(stateDir, func() error {
		source := systemHostResourceSource()
		sample := source.Snapshot()
		quota, err := effectiveQuota(stateDir, source)
		if err != nil {
			return err
		}
		status = QuotaStatus{MemoryBytes: quota.MemoryBytes, CPUs: quota.CPUs, MinFree: quota.MinFree, Resources: sample}
		data, readErr := os.ReadFile(filepath.Join(stateDir, "quota.json"))
		if readErr == nil {
			var stored quotaFile
			if err := json.Unmarshal(data, &stored); err != nil {
				return err
			}
			status.MemorySet = stored.MemoryBytes != nil || stored.MemoryPercent != nil
			status.CPUsSet, status.MinFreeSet = stored.CPUs != nil, stored.MinFree != nil
		} else if !os.IsNotExist(readErr) {
			return readErr
		}
		return nil
	})
	return status, err
}

// CPUCommandTokenCapacity returns the configured host token count used by
// heavy command admission. The effective quota remains the single owner of
// host defaults, cgroup limits, and the optional quota.json override.
func CPUCommandTokenCapacity(stateDir string) (int, error) {
	quota, err := effectiveQuota(stateDir, systemHostResourceSource())
	if err != nil {
		return 0, fmt.Errorf("read CPU command token capacity: %w", err)
	}
	return quota.CPUs, nil
}

func SetQuota(stateDir, memory, cpus, minFree string) error {
	if stateDir == "" {
		return fmt.Errorf("state directory is required")
	}
	return withStateLock(stateDir, func() error {
		var stored quotaFile
		data, err := os.ReadFile(filepath.Join(stateDir, "quota.json"))
		if err == nil {
			if err := json.Unmarshal(data, &stored); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if memory != "" {
			if strings.HasSuffix(memory, "%") {
				n, err := strconv.Atoi(strings.TrimSuffix(memory, "%"))
				if err != nil || n < 1 || n > 100 {
					return fmt.Errorf("memory percent must be 1..100")
				}
				stored.MemoryPercent, stored.MemoryBytes = &n, nil
			} else {
				value, err := ParseResourceSize(memory)
				if err != nil {
					return err
				}
				if value == 0 {
					return fmt.Errorf("memory quota must be positive")
				}
				stored.MemoryBytes, stored.MemoryPercent = &value, nil
			}
		}
		if cpus != "" {
			value, err := strconv.Atoi(cpus)
			if err != nil || value < 1 {
				return fmt.Errorf("CPU quota must be positive")
			}
			stored.CPUs = &value
		}
		if minFree != "" {
			value, err := ParseResourceSize(minFree)
			if err != nil {
				return err
			}
			stored.MinFree = &value
		}
		return writeQuota(stateDir, stored)
	})
}

type pressureState struct {
	ElevatedAt    time.Time     `json:"elevated_at,omitempty"`
	NormalAt      time.Time     `json:"normal_at,omitempty"`
	Level         string        `json:"level,omitempty"`
	LevelClass    pressureLevel `json:"level_class,omitempty"`
	LevelSince    time.Time     `json:"level_since,omitempty"`
	LastKnownAt   time.Time     `json:"last_known_at,omitempty"`
	UnknownSince  time.Time     `json:"unknown_since,omitempty"`
	SwapOuts      uint64        `json:"swap_outs,omitempty"`
	SwapOutsKnown bool          `json:"swap_outs_known,omitempty"`
	SwapUsedBytes uint64        `json:"swap_used_bytes,omitempty"`
}

func classifyPressure(sample HostResourceSnapshot) pressureLevel {
	if sample.Pressure == "memory warn" {
		return pressureWarn
	}
	if isElevatedPressure(sample) {
		return pressureCritical
	}
	return pressureNormal
}

func pressureLevelBlocks(level pressureLevel, class CostClass) bool {
	switch level {
	case pressureWarn:
		return class == CostHeavy
	case pressureCritical:
		return true
	case pressureUnknown:
		return class == CostHeavy
	default:
		return false
	}
}

func pressureAdmissionWait(level pressureLevel, levelSince time.Time, hysteresis bool, signalReason string) string {
	since := levelSince.UTC().Format(time.RFC3339)
	if level == pressureUnknown {
		return fmt.Sprintf("waiting for pressure sample; current: pressure unknown since %s", since)
	}
	if hysteresis {
		if level == pressureWarn {
			return fmt.Sprintf("waiting for memory pressure to drop below warn; hysteresis current: warn since %s", since)
		}
		return fmt.Sprintf("waiting for host pressure to return to normal; hysteresis current: %s since %s", signalReason, since)
	}
	if level == pressureWarn {
		return fmt.Sprintf("waiting for memory pressure to drop below warn; current: warn since %s", since)
	}
	return fmt.Sprintf("waiting for host pressure to return to normal; current: %s since %s", signalReason, since)
}

func isElevatedPressure(sample HostResourceSnapshot) bool {
	if sample.Pressure == "memory warn" || sample.Pressure == "memory critical" || sample.Pressure == "memory psi elevated" {
		return true
	}
	if sample.PhysicalMemory > 0 && sample.MemoryAvailableKnown && sample.AvailableMemory < sample.PhysicalMemory*lowAvailableMemoryFraction/100 {
		return true
	}
	return sample.LogicalCPUs > 0 && sample.LoadAvailable && sample.Load1 > highLoadPerLogicalCPU*float64(sample.LogicalCPUs) || sample.CPUPressure >= pressurePSIThreshold
}

func pressureWaitReason(sample HostResourceSnapshot) string {
	switch {
	case sample.Pressure == "memory warn" || sample.Pressure == "memory critical" || sample.Pressure == "memory psi elevated":
		return "host pressure (" + sample.Pressure + ")"
	case sample.PhysicalMemory > 0 && sample.MemoryAvailableKnown && sample.AvailableMemory < sample.PhysicalMemory*lowAvailableMemoryFraction/100:
		return "host pressure (available memory below 10% of physical)"
	case sample.CPUPressure >= pressurePSIThreshold:
		return fmt.Sprintf("host pressure (CPU PSI %.2f%% above %.2f%%)", sample.CPUPressure, pressurePSIThreshold)
	case sample.LogicalCPUs > 0 && sample.Load1 > highLoadPerLogicalCPU*float64(sample.LogicalCPUs):
		return fmt.Sprintf("host pressure (load %.2f above %.1f per logical CPU)", sample.Load1, highLoadPerLogicalCPU)
	default:
		return "host pressure"
	}
}

func pressureSignalsAvailable(sample HostResourceSnapshot) bool {
	return sample.PressureAvailable || sample.LoadAvailable || sample.SwapOutsKnown
}

func (s *pressureState) blocks(elevated bool, now time.Time) bool {
	if elevated {
		s.ElevatedAt = now
		s.NormalAt = time.Time{}
		return true
	}
	if s.ElevatedAt.IsZero() {
		return false
	}
	if s.NormalAt.IsZero() {
		s.NormalAt = now
	}
	if now.Sub(s.NormalAt) < pressureNormalDuration {
		return true
	}
	s.ElevatedAt = time.Time{}
	s.NormalAt = time.Time{}
	return false
}

func quotaFits(active, candidate quotaUsage, quota hostQuota) bool {
	if active.MemoryBytes == 0 && active.MinCPUs == 0 && active.DiskBytes == 0 {
		return true
	}
	if active.MemoryBytes > quota.MemoryBytes || active.MinCPUs > quota.CPUs {
		return candidate.MemoryBytes == 0 && candidate.MinCPUs == 0 && candidate.DiskBytes == 0
	}
	if candidate.MemoryBytes > quota.MemoryBytes-active.MemoryBytes {
		return false
	}
	return candidate.MinCPUs <= quota.CPUs-active.MinCPUs
}

func diskFits(free, reserved, need, minFree uint64) bool {
	return reserved <= free && need <= free-reserved && minFree <= free-reserved-need
}

func effectiveQuotaUsage(declared, learned quotaUsage) quotaUsage {
	return quotaUsage{
		MemoryBytes: max(declared.MemoryBytes, learned.MemoryBytes),
		MinCPUs:     max(declared.MinCPUs, learned.MinCPUs),
		DiskBytes:   declared.DiskBytes,
	}
}

func memoryUnavailable(need, available uint64) bool { return need > available }

func FormatResourceBytes(value uint64) string {
	const gib = uint64(1024 * 1024 * 1024)
	const mib = uint64(1024 * 1024)
	if value >= gib {
		return fmt.Sprintf("%.1fG", float64(value)/float64(gib))
	}
	if value >= mib {
		return fmt.Sprintf("%.1fM", float64(value)/float64(mib))
	}
	return fmt.Sprintf("%dB", value)
}

type overBudgetState struct{ emitted bool }

func (s *overBudgetState) observe(rss, reserved uint64) bool {
	if !s.emitted && reserved > 0 && rss > reserved+reserved/4 {
		s.emitted = true
		return true
	}
	return false
}

func recordResourceObservation(stateDir, runID string, rss uint64, averageCPU float64, partial bool) (bool, error) {
	emitted := false
	err := withStateLock(stateDir, func() error {
		rec, err := readRecordLocked(stateDir, runID)
		if err != nil {
			return err
		}
		rec.PeakRSSBytes = max(rec.PeakRSSBytes, rss)
		rec.AverageCPU = averageCPU
		rec.MeasurementPartial = rec.MeasurementPartial || partial
		state := overBudgetState{emitted: rec.OverBudget}
		emitted = state.observe(rss, rec.MemoryBytes)
		if emitted {
			rec.OverBudget = true
			if err := appendEvent(stateDir, eventFor(rec, EventOverBudget)); err != nil {
				return err
			}
		}
		return writeRecordAtomic(rec)
	})
	return emitted, err
}

func ParseResourceSize(value string) (uint64, error) {
	value = strings.TrimSpace(strings.ToUpper(value))
	if value == "" {
		return 0, fmt.Errorf("size is empty")
	}
	multiplier := uint64(1)
	last := value[len(value)-1]
	switch last {
	case 'K', 'M', 'G', 'T':
		value = value[:len(value)-1]
		multiplier = 1
		for range strings.IndexByte("KMGT", last) + 1 {
			multiplier *= 1024
		}
		if strings.HasSuffix(value, "I") {
			value = strings.TrimSuffix(value, "I")
		}
		if strings.HasSuffix(value, "B") {
			value = strings.TrimSuffix(value, "B")
		}
	case 'B':
		value = value[:len(value)-1]
	}
	amount, err := strconv.ParseUint(value, 10, 64)
	if err != nil || amount > ^uint64(0)/multiplier {
		return 0, fmt.Errorf("invalid or overflowing size")
	}
	return amount * multiplier, nil
}
