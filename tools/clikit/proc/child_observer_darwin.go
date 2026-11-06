//go:build darwin

package proc

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/kb-labs/clikit/proc/child"
	"golang.org/x/sys/unix"
)

func childProcessIdentity(pid int) (child.ProcessIdentity, error) {
	info, err := childDarwinProcess(pid)
	if err != nil {
		return child.ProcessIdentity{}, err
	}
	startedAt := time.Unix(info.Proc.P_starttime.Sec, int64(info.Proc.P_starttime.Usec)*1000)
	return child.ProcessIdentity{PID: pid, Identity: childDarwinStartIdentity(info), StartedAt: startedAt}, nil
}

func childProcessGroupMembers(groupID int, rootStartedAt time.Time) ([]child.ProcessMember, error) {
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, fmt.Errorf("enumerate Darwin process table: %w", err)
	}
	observations := make([]childProcessObservation, 0)
	for index := range processes {
		process := &processes[index]
		startedAt := time.Unix(process.Proc.P_starttime.Sec, int64(process.Proc.P_starttime.Usec)*1000)
		observations = append(observations, childProcessObservation{PID: int(process.Proc.P_pid), GroupID: int(process.Eproc.Pgid), Identity: childDarwinStartIdentity(process), StartedAt: startedAt, State: byte(process.Proc.P_stat)})
	}
	return liveOwnedGroupMembers(observations, groupID, rootStartedAt), nil
}

func childDarwinProcess(pid int) (*unix.KinfoProc, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("invalid Darwin process ID %d", pid)
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		if errors.Is(err, unix.ESRCH) || errors.Is(err, unix.ENOENT) {
			return nil, fmt.Errorf("process %d is gone: %w", pid, err)
		}
		return nil, fmt.Errorf("query kern.proc.pid for %d: %w", pid, err)
	}
	if int(info.Proc.P_pid) != pid {
		return nil, fmt.Errorf("kern.proc.pid returned identity for another PID than %d", pid)
	}
	return info, nil
}

func childDarwinStartIdentity(info *unix.KinfoProc) string {
	return strconv.FormatInt(info.Proc.P_starttime.Sec, 10) + ":" + strconv.FormatInt(int64(info.Proc.P_starttime.Usec), 10)
}
