//go:build darwin

package proc

import (
	"strings"
	"testing"
)

// case: S-237.53
func TestDarwinMemoryStatisticsParserUsesRecordedHostValues(t *testing.T) {
	got, err := parseDarwinAvailableMemory(10, 20, 30, 40, 4096)
	if err != nil || got != 409600 {
		t.Fatalf("available memory = %d, %v; want 409600 bytes", got, err)
	}
	if _, err := parseDarwinAvailableMemory(0, 0, 0, 0, 0); err == nil {
		t.Fatal("zero page size was accepted")
	}
	if _, err := parseDarwinAvailableMemory(^uint64(0), 1, 0, 0, 4096); err == nil {
		t.Fatal("overflowing page count was accepted")
	}
}

// case: S-237.53
func TestUnavailableMemorySignalIsVisibleForQuotaFallback(t *testing.T) {
	sample := HostResourceSnapshot{Unavailable: map[string]string{"host_statistics64": "permission denied"}}
	if sample.MemoryAvailableKnown {
		t.Fatal("unavailable memory signal was treated as known")
	}
	if got := hostResourceNotice(sample); !strings.Contains(got, "host_statistics64 unavailable: permission denied") {
		t.Fatalf("resource notice = %q, want the host memory failure reason", got)
	}
}

func TestDarwinResourceReaderUsesHostSysctls(t *testing.T) {
	sample := (darwinHostResourceSource{}).Snapshot()
	if sample.PhysicalMemory == 0 || sample.LogicalCPUs < 1 {
		t.Fatalf("host sysctl sample lacks physical memory or CPU count: %+v", sample)
	}
	if sample.Pressure == "" && sample.Unavailable["kern.memorystatus_vm_pressure_level"] == "" {
		t.Fatalf("pressure is neither available nor explained: %+v", sample)
	}
	if !sample.MemoryAvailableKnown && sample.Unavailable["host_statistics64"] == "" {
		t.Fatalf("available memory is unknown without a reason: %+v", sample)
	}
}
