package engine

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

const (
	linuxMeminfoPath   = "/proc/meminfo"
	cgroupV2Dir        = "/sys/fs/cgroup"
	cgroupMemoryMax    = "memory.max"
	cgroupMemoryUsage  = "memory.current"
	darwinSysctlBinary = "sysctl"
	darwinVMStatBinary = "vm_stat"
)

// HostMemoryProbe reads the real host memory. Linux reads /proc/meminfo
// clamped by the cgroup v2 limit, macOS reads sysctl and vm_stat. Any other
// OS reports ErrMemoryProbeUnsupported (naming the OS) and runs bounded by the
// configured cap alone.
func HostMemoryProbe() (MemoryReading, error) {
	switch runtime.GOOS {
	case "linux":
		return linuxMemory(linuxMeminfoPath, cgroupV2Dir)
	case "darwin":
		return darwinMemory()
	default:
		return MemoryReading{}, fmt.Errorf("%w: %s has no admission probe", ErrMemoryProbeUnsupported, runtime.GOOS)
	}
}

func linuxMemory(meminfoPath, cgroupDir string) (MemoryReading, error) {
	f, err := os.Open(meminfoPath)
	if err != nil {
		if os.IsNotExist(err) {
			return MemoryReading{}, fmt.Errorf("%w: %s is missing", ErrMemoryProbeUnsupported, meminfoPath)
		}
		return MemoryReading{}, fmt.Errorf("read %s: %w", meminfoPath, err)
	}
	defer f.Close()
	r, err := parseMeminfo(bufio.NewScanner(f))
	if err != nil {
		return MemoryReading{}, err
	}
	return clampByCgroup(r, cgroupDir)
}

// clampByCgroup applies a cgroup v2 memory.max below the host total. "max" or
// a missing file means no cgroup limit.
func clampByCgroup(r MemoryReading, cgroupDir string) (MemoryReading, error) {
	raw, err := os.ReadFile(cgroupDir + "/" + cgroupMemoryMax)
	if err != nil {
		if os.IsNotExist(err) {
			return r, nil
		}
		return MemoryReading{}, fmt.Errorf("read cgroup %s: %w", cgroupMemoryMax, err)
	}
	text := strings.TrimSpace(string(raw))
	if text == "max" {
		return r, nil
	}
	limit, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return MemoryReading{}, fmt.Errorf("parse cgroup %s %q: %w", cgroupMemoryMax, text, err)
	}
	if limit >= r.TotalBytes {
		return r, nil
	}
	r.TotalBytes = limit
	room := limit
	if usageRaw, usageErr := os.ReadFile(cgroupDir + "/" + cgroupMemoryUsage); usageErr == nil {
		usage, parseErr := strconv.ParseUint(strings.TrimSpace(string(usageRaw)), 10, 64)
		if parseErr != nil {
			return MemoryReading{}, fmt.Errorf("parse cgroup %s: %w", cgroupMemoryUsage, parseErr)
		}
		if usage < limit {
			room = limit - usage
		} else {
			room = 0
		}
	} else if !os.IsNotExist(usageErr) {
		return MemoryReading{}, fmt.Errorf("read cgroup %s: %w", cgroupMemoryUsage, usageErr)
	}
	if r.AvailableBytes > room {
		r.AvailableBytes = room
	}
	return r, nil
}

func parseMeminfo(sc *bufio.Scanner) (MemoryReading, error) {
	var r MemoryReading
	var haveTotal, haveAvail bool
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		var dst *uint64
		switch fields[0] {
		case "MemTotal:":
			dst, haveTotal = &r.TotalBytes, true
		case "MemAvailable:":
			dst, haveAvail = &r.AvailableBytes, true
		default:
			continue
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return MemoryReading{}, fmt.Errorf("parse %s %q: %w", fields[0], fields[1], err)
		}
		*dst = kb * 1024
	}
	if err := sc.Err(); err != nil {
		return MemoryReading{}, err
	}
	if !haveTotal || !haveAvail || r.TotalBytes == 0 {
		return MemoryReading{}, errors.New("/proc/meminfo lacks MemTotal or MemAvailable")
	}
	return r, nil
}

func darwinMemory() (MemoryReading, error) {
	totalOut, err := exec.Command(darwinSysctlBinary, "-n", "hw.memsize").Output()
	if err != nil {
		return MemoryReading{}, fmt.Errorf("sysctl hw.memsize: %w", err)
	}
	total, err := strconv.ParseUint(strings.TrimSpace(string(totalOut)), 10, 64)
	if err != nil || total == 0 {
		return MemoryReading{}, fmt.Errorf("parse sysctl hw.memsize %q", strings.TrimSpace(string(totalOut)))
	}
	vmOut, err := exec.Command(darwinVMStatBinary).Output()
	if err != nil {
		return MemoryReading{}, fmt.Errorf("vm_stat: %w", err)
	}
	available, err := parseVMStat(string(vmOut))
	if err != nil {
		return MemoryReading{}, err
	}
	if available > total {
		available = total
	}
	return MemoryReading{TotalBytes: total, AvailableBytes: available}, nil
}

// parseVMStat returns the memory macOS can hand out without evicting live
// data: (free + inactive + speculative + purgeable) pages times the page size
// stated in the vm_stat header.
func parseVMStat(out string) (uint64, error) {
	var pageSize uint64
	counts := map[string]uint64{}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "Mach Virtual Memory Statistics:") {
			open := strings.Index(line, "page size of ")
			if open < 0 {
				return 0, fmt.Errorf("vm_stat header lacks a page size: %q", line)
			}
			fields := strings.Fields(line[open+len("page size of "):])
			if len(fields) == 0 {
				return 0, fmt.Errorf("vm_stat header lacks a page size: %q", line)
			}
			size, err := strconv.ParseUint(fields[0], 10, 64)
			if err != nil || size == 0 {
				return 0, fmt.Errorf("parse vm_stat page size %q", fields[0])
			}
			pageSize = size
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch name {
		case "Pages free", "Pages inactive", "Pages speculative", "Pages purgeable":
			pages, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(value), "."), 10, 64)
			if err != nil {
				return 0, fmt.Errorf("parse vm_stat %s %q: %w", name, strings.TrimSpace(value), err)
			}
			counts[name] = pages
		}
	}
	if pageSize == 0 {
		return 0, errors.New("vm_stat output lacks the page size header")
	}
	for _, name := range []string{"Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"} {
		if _, ok := counts[name]; !ok {
			return 0, fmt.Errorf("vm_stat output lacks %q", name)
		}
	}
	pages := counts["Pages free"] + counts["Pages inactive"] + counts["Pages speculative"] + counts["Pages purgeable"]
	return pages * pageSize, nil
}
