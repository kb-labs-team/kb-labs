//go:build darwin

package proc

import "golang.org/x/sys/unix"

func testProcessStopped(pid int) (stopped, present bool, err error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return false, false, err
	}
	// XNU's SSTOP process state is 4.
	return info.Proc.P_stat == 4, info.Proc.P_stat != 5, nil
}
