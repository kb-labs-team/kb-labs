//go:build windows

package host

import (
	"github.com/kb-labs/clikit/proc/child"
	"golang.org/x/sys/windows"
)

func TerminateProcessIfIdentity(pid int, processIdentity string) bool {
	return signalWithProcessIdentity(pid, processIdentity, func() error { return child.TerminateTree(pid) })
}

func KillProcessIfIdentity(pid int, processIdentity string) bool {
	return signalWithProcessIdentity(pid, processIdentity, func() error { return child.KillTree(pid) })
}

func TerminateProcessGroupIfIdentity(pid int, processIdentity string) bool {
	return TerminateProcessIfIdentity(pid, processIdentity)
}

func KillProcessGroupIfIdentity(pid int, processIdentity string) bool {
	return KillProcessIfIdentity(pid, processIdentity)
}

func ProcessAlive(pid int) bool { return processAlive(pid) }

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}
