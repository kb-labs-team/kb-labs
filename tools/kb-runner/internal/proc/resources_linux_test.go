//go:build linux

package proc

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// case: S-237.35
func TestLinuxResourceReaderParsesProcAndCgroupV2(t *testing.T) {
	root := t.TempDir()
	write := func(name, value string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/meminfo", "MemTotal: 1000000 kB\nMemAvailable: 200000 kB\nSwapTotal: 400000 kB\nSwapFree: 300000 kB\n")
	write("proc/vmstat", "pswpin 10\npswpout 25\n")
	write("proc/loadavg", "2.50 1.20 0.80 1/100 42\n")
	write("proc/pressure/memory", "some avg10=11.00 avg60=1.00 avg300=0.00 total=10\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")
	write("proc/pressure/cpu", "some avg10=4.25 avg60=1.00 avg300=0.00 total=10\n")
	write("proc/self/cgroup", "0::/fixture\n")
	write("sys/fs/cgroup/fixture/memory.max", "524288000\n")
	write("sys/fs/cgroup/fixture/cpu.max", "200000 100000\n")
	got := (linuxHostResourceSource{root: root}).Snapshot()
	if got.PhysicalMemory != 1_024_000_000 || got.AvailableMemory != 204_800_000 || !got.MemoryAvailableKnown {
		t.Fatalf("memory sample = %+v", got)
	}
	if got.Pressure != "memory psi elevated" || got.Load1 != 2.5 || got.CPUPressure != 4.25 {
		t.Fatalf("pressure/load = %+v", got)
	}
	if got.CgroupMemory != 524288000 || got.CgroupCPUs != 2 {
		t.Fatalf("cgroup limits = %+v", got)
	}
	if got.SwapTotalBytes != 409_600_000 || got.SwapUsedBytes != 102_400_000 || got.SwapOuts != 25 || !got.SwapOutsKnown {
		t.Fatalf("swap sample = %+v", got)
	}
}

func TestLinuxResourceReaderRoundsFractionalCPUQuotaDown(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"proc/meminfo":                     "MemTotal: 1000000 kB\nMemAvailable: 200000 kB\n",
		"proc/loadavg":                     "1.00 1.00 1.00 1/100 42\n",
		"proc/self/cgroup":                 "0::/fixture\n",
		"sys/fs/cgroup/fixture/memory.max": "524288000\n",
		"sys/fs/cgroup/fixture/cpu.max":    "50000 100000\n",
	} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got := (linuxHostResourceSource{root: root}).Snapshot()
	if !pressureSignalsAvailable(got) {
		t.Fatalf("meminfo/load fallback did not provide pressure signals: %+v", got)
	}
	if !got.CgroupCPUsKnown || got.CgroupCPUs != 0 {
		t.Fatalf("fractional cgroup CPU default = %+v, want 0 whole cores and known limit", got)
	}
}

func TestLinuxResourceReaderReportsUnreadableCgroupDefaults(t *testing.T) {
	root := t.TempDir()
	write := func(name, value string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/meminfo", "MemTotal: 1000000 kB\nMemAvailable: 200000 kB\n")
	write("proc/loadavg", "1.00 1.00 1.00 1/100 42\n")
	write("proc/pressure/memory", "some avg10=1.00 avg60=1.00 avg300=1.00 total=10\n")
	write("proc/self/cgroup", "0::/fixture\n")
	got := (linuxHostResourceSource{root: root}).Snapshot()
	if got.Unavailable["cgroup memory.max"] == "" || got.Unavailable["cgroup cpu.max"] == "" {
		t.Fatalf("unreadable cgroup defaults were hidden: %+v", got.Unavailable)
	}
}

// case: S-237.39
func TestCgroupSetupFailureIsReportedAsAdvisory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "kb-runner-fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("/bin/true")
	advisory, cleanup, err := startWithCgroupLimits(root, Config{MemoryBytes: 100}, "fixture", command)
	defer cleanup()
	if err != nil {
		t.Fatal(err)
	}
	if advisory == "" || !strings.Contains(advisory, "limits advisory") {
		t.Fatalf("advisory = %q", advisory)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
}
