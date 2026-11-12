//go:build !windows

package host

import (
	"errors"
	"syscall"

	"github.com/kb-labs/clikit/proc/child"
)

func TerminateProcessIfIdentity(pid int, processIdentity string) bool {
	return signalWithProcessIdentity(pid, processIdentity, func() error { return syscall.Kill(pid, syscall.SIGTERM) })
}

func KillProcessIfIdentity(pid int, processIdentity string) bool {
	return signalWithProcessIdentity(pid, processIdentity, func() error { return syscall.Kill(pid, syscall.SIGKILL) })
}

func TerminateProcessGroupIfIdentity(pid int, processIdentity string) bool {
	return signalWithProcessIdentity(pid, processIdentity, func() error { return child.TerminateTree(pid) })
}

func KillProcessGroupIfIdentity(pid int, processIdentity string) bool {
	return signalWithProcessIdentity(pid, processIdentity, func() error { return child.KillTree(pid) })
}

// ProcessAlive reports whether pid is a running process (EPERM still means it exists; an unreaped zombie does not count).
func ProcessAlive(pid int) bool { return processAlive(pid) }

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err != nil && !errors.Is(err, syscall.EPERM) {
		return false
	}
	// A dead child that nobody has reaped yet still answers signal 0, but it
	// is gone: its environment is unreadable and it can never serve again.
	return !processZombie(pid)
}
