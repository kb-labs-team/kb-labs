//go:build linux

package proc

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type linuxHostResourceSource struct{ root string }

func systemHostResourceSource() HostResourceSource { return linuxHostResourceSource{} }

func (s linuxHostResourceSource) Snapshot() HostResourceSnapshot {
	root := s.root
	if root == "" {
		root = "/"
	}
	read := func(path string) ([]byte, error) { return os.ReadFile(filepath.Join(root, path)) }
	result := HostResourceSnapshot{LogicalCPUs: runtime.NumCPU(), Unavailable: map[string]string{}}
	mem, err := read("proc/meminfo")
	if err != nil {
		result.Unavailable["memory"] = err.Error()
	} else if err := parseLinuxMemInfo(string(mem), &result); err != nil {
		result.Unavailable["memory"] = err.Error()
	}
	vmstat, vmErr := read("proc/vmstat")
	if vmErr != nil {
		result.Unavailable["swapouts"] = vmErr.Error()
	} else if err := parseLinuxVMStat(string(vmstat), &result); err != nil {
		result.Unavailable["swapouts"] = err.Error()
	}
	load, err := read("proc/loadavg")
	if err != nil {
		result.Unavailable["load"] = err.Error()
	} else if err := parseLinuxLoad(string(load), &result); err != nil {
		result.Unavailable["load"] = err.Error()
	} else {
		result.LoadAvailable = true
	}
	pressure, err := read("proc/pressure/memory")
	if err != nil {
		result.Unavailable["pressure"] = err.Error()
	} else if err := parseLinuxPressure(string(pressure), &result); err != nil {
		result.Unavailable["pressure"] = err.Error()
	} else {
		result.PressureAvailable = true
	}
	cpuPressure, err := read("proc/pressure/cpu")
	if err != nil {
		result.Unavailable["cpu pressure"] = err.Error()
	} else if value, parseErr := parseLinuxPressureValue(string(cpuPressure)); parseErr != nil {
		result.Unavailable["cpu pressure"] = parseErr.Error()
	} else {
		result.CPUPressure = value
	}
	cgroup := filepath.Join(root, "sys/fs/cgroup")
	if membership, err := read("proc/self/cgroup"); err == nil {
		for _, line := range strings.Split(string(membership), "\n") {
			if strings.HasPrefix(line, "0::") {
				rel := strings.TrimPrefix(filepath.Clean(strings.TrimPrefix(line, "0::")), string(filepath.Separator))
				cgroup = filepath.Join(cgroup, rel)
				break
			}
		}
	} else {
		result.Unavailable["cgroup membership"] = err.Error()
	}
	readCgroupLimits(cgroup, &result)
	return result
}

func parseLinuxMemInfo(data string, result *HostResourceSnapshot) error {
	hasTotal, hasAvailable := false, false
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			result.PhysicalMemory = value * 1024
			hasTotal = true
		case "MemAvailable":
			result.AvailableMemory = value * 1024
			hasAvailable = true
		case "SwapTotal":
			result.SwapTotalBytes = value * 1024
		case "SwapFree":
			result.SwapUsedBytes = value * 1024
		}
	}
	if !hasTotal || !hasAvailable {
		return fmt.Errorf("/proc/meminfo has no usable MemTotal or MemAvailable entry")
	}
	result.MemoryAvailableKnown = true
	if result.SwapTotalBytes > 0 {
		result.SwapUsedBytes = result.SwapTotalBytes - min(result.SwapTotalBytes, result.SwapUsedBytes)
	}
	return nil
}

func parseLinuxVMStat(data string, result *HostResourceSnapshot) error {
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "pswpout" {
			value, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return fmt.Errorf("parse /proc/vmstat pswpout: %w", err)
			}
			result.SwapOuts, result.SwapOutsKnown = value, true
			return nil
		}
	}
	return fmt.Errorf("/proc/vmstat has no pswpout counter")
}

func parseLinuxLoad(data string, result *HostResourceSnapshot) error {
	fields := strings.Fields(data)
	if len(fields) == 0 {
		return fmt.Errorf("/proc/loadavg is empty")
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return fmt.Errorf("parse /proc/loadavg: %w", err)
	}
	result.Load1 = value
	return nil
}

func parseLinuxPressure(data string, result *HostResourceSnapshot) error {
	value, err := parseLinuxPressureValue(data)
	if err != nil {
		return err
	}
	result.Pressure = "normal"
	if value >= pressurePSIThreshold {
		result.Pressure = "memory psi elevated"
	}
	return nil
}

func parseLinuxPressureValue(data string) (float64, error) {
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "some" {
			continue
		}
		for _, field := range fields[1:] {
			key, raw, ok := strings.Cut(field, "=")
			if !ok || key != "avg10" {
				continue
			}
			value, err := strconv.ParseFloat(raw, 64)
			if err != nil {
				return 0, fmt.Errorf("parse pressure avg10: %w", err)
			}
			return value, nil
		}
	}
	return 0, fmt.Errorf("pressure file has no some avg10")
}

func readCgroupLimits(cgroupRoot string, result *HostResourceSnapshot) {
	if data, err := os.ReadFile(filepath.Join(cgroupRoot, "memory.max")); err != nil {
		result.Unavailable["cgroup memory.max"] = err.Error()
	} else if value, parseErr := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64); parseErr == nil {
		result.CgroupMemory = value
	} else if strings.TrimSpace(string(data)) != "max" {
		result.Unavailable["cgroup memory.max"] = parseErr.Error()
	}
	if data, err := os.ReadFile(filepath.Join(cgroupRoot, "cpu.max")); err != nil {
		result.Unavailable["cgroup cpu.max"] = err.Error()
	} else {
		fields := strings.Fields(string(data))
		if len(fields) == 2 && fields[0] != "max" {
			quota, qErr := strconv.ParseUint(fields[0], 10, 64)
			period, pErr := strconv.ParseUint(fields[1], 10, 64)
			if qErr == nil && pErr == nil && period > 0 {
				result.CgroupCPUs = int(quota / period)
				result.CgroupCPUsKnown = true
			} else {
				result.Unavailable["cgroup cpu.max"] = "malformed cpu.max quota or period"
			}
		} else if len(fields) != 2 {
			result.Unavailable["cgroup cpu.max"] = "malformed cpu.max"
		}
	}
}
