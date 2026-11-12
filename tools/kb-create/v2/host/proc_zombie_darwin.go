//go:build darwin

package host

import "golang.org/x/sys/unix"

// szomb is p_stat of a process that is dead and not yet reaped (sys/proc.h).
const szomb = 5

// processZombie reports whether pid is dead and only waiting for its parent
// to reap it.
func processZombie(pid int) bool {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	return err == nil && info.Proc.P_stat == szomb
}
