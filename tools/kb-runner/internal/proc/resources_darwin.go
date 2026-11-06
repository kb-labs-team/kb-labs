//go:build darwin

package proc

import (
	"encoding/binary"
	"fmt"

	"golang.org/x/sys/unix"
)

type darwinHostResourceSource struct{}

func systemHostResourceSource() HostResourceSource { return darwinHostResourceSource{} }

func (darwinHostResourceSource) Snapshot() HostResourceSnapshot {
	result := HostResourceSnapshot{Unavailable: map[string]string{}}
	read32 := func(name string) uint32 {
		value, err := unix.SysctlUint32(name)
		if err != nil {
			result.Unavailable[name] = err.Error()
		}
		return value
	}
	result.PhysicalMemory, _ = unix.SysctlUint64("hw.memsize")
	if result.PhysicalMemory == 0 {
		result.Unavailable["hw.memsize"] = "returned zero"
	}
	result.LogicalCPUs = int(read32("hw.logicalcpu"))
	if available, err := darwinAvailableMemory(uint64(read32("hw.pagesize"))); err != nil {
		result.Unavailable["host_statistics64"] = err.Error()
	} else {
		result.AvailableMemory = available
		result.MemoryAvailableKnown = true
	}
	level := read32("kern.memorystatus_vm_pressure_level")
	switch level {
	case 1:
		result.Pressure = "normal"
	case 2:
		result.Pressure = "memory warn"
	case 4:
		result.Pressure = "memory critical"
	default:
		if _, ok := result.Unavailable["kern.memorystatus_vm_pressure_level"]; !ok {
			result.Unavailable["kern.memorystatus_vm_pressure_level"] = fmt.Sprintf("unknown value %d", level)
		}
	}
	load, err := unix.SysctlRaw("vm.loadavg")
	if err != nil {
		result.Unavailable["vm.loadavg"] = fmt.Sprintf("read load average: %v", err)
	} else if len(load) < 4*4 {
		result.Unavailable["vm.loadavg"] = "malformed vm.loadavg"
	} else {
		fixed := int32(binary.NativeEndian.Uint32(load[:4]))
		scale := int32(binary.NativeEndian.Uint32(load[12:16]))
		if scale > 0 {
			result.Load1 = float64(fixed) / float64(scale)
			result.LoadAvailable = true
		}
	}
	result.PressureAvailable = result.Pressure != ""
	swap, err := unix.SysctlRaw("vm.swapusage")
	if err != nil || len(swap) < 24 {
		result.Unavailable["vm.swapusage"] = fmt.Sprintf("read swap usage: %v", err)
	} else {
		result.SwapTotalBytes = binary.NativeEndian.Uint64(swap[:8])
		result.SwapUsedBytes = binary.NativeEndian.Uint64(swap[16:24])
		result.Swap = fmt.Sprintf("used=%d total=%d", result.SwapUsedBytes, result.SwapTotalBytes)
	}
	if result.LogicalCPUs == 0 {
		result.Unavailable["hw.logicalcpu"] = "returned zero"
	}
	return result
}
