//go:build linux

package proc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/proc/child"
)

func childProcessIdentity(pid int) (child.ProcessIdentity, error) {
	stat, err := readChildProcStat(pid)
	if err != nil {
		return child.ProcessIdentity{}, err
	}
	return child.ProcessIdentity{PID: pid, Identity: strconv.FormatInt(stat.startTicks, 10), StartedAt: time.Unix(0, stat.startTicks)}, nil
}

func childProcessGroupMembers(groupID int, rootStartedAt time.Time) ([]child.ProcessMember, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, fmt.Errorf("enumerate Linux process table: %w", err)
	}
	processes := make([]childProcessObservation, 0)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := readChildProcStat(pid)
		if err != nil {
			if childProcessVanished(err) {
				continue
			}
			return nil, fmt.Errorf("inspect Linux process %d for group membership: %w", pid, err)
		}
		processes = append(processes, childProcessObservation{PID: pid, GroupID: stat.processGroupID, Identity: strconv.FormatInt(stat.startTicks, 10), StartedAt: time.Unix(0, stat.startTicks), State: stat.state})
	}
	return liveOwnedGroupMembers(processes, groupID, rootStartedAt), nil
}

// childProcessVanished reports whether reading /proc/<pid>/stat failed because the process
// exited between enumeration and the read: open fails with ENOENT, while a read after the
// process is reaped fails with ESRCH.
func childProcessVanished(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH)
}

type childProcStat struct {
	state          byte
	processGroupID int
	startTicks     int64
}

func readChildProcStat(pid int) (childProcStat, error) {
	if pid <= 0 {
		return childProcStat{}, fmt.Errorf("invalid Linux process ID %d", pid)
	}
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return childProcStat{}, err
	}
	open := strings.IndexByte(string(data), '(')
	close := strings.LastIndexByte(string(data), ')')
	if open < 1 || close <= open || close+2 >= len(data) {
		return childProcStat{}, fmt.Errorf("malformed /proc/%d/stat command field", pid)
	}
	actualPID, err := strconv.Atoi(strings.TrimSpace(string(data[:open])))
	if err != nil || actualPID != pid {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat PID identity mismatch", pid)
	}
	fields := strings.Fields(string(data[close+1:]))
	if len(fields) <= 19 || len(fields[0]) != 1 {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat omits required process identity fields", pid)
	}
	processGroupID, err := strconv.Atoi(fields[2])
	if err != nil || processGroupID < 0 {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat has invalid process group", pid)
	}
	startTicks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil || startTicks < 0 {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat has invalid start time", pid)
	}
	return childProcStat{state: fields[0][0], processGroupID: processGroupID, startTicks: startTicks}, nil
}
