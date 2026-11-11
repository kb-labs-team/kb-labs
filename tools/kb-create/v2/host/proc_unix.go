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

// ProcessAlive reports whether pid exists (EPERM still means it exists).
func ProcessAlive(pid int) bool { return processAlive(pid) }

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
