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
	pids := make([]int, 0, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		pids = append(pids, pid)
	}
	return childProcessGroupMembersFromPIDs(pids, groupID, rootStartedAt, readChildProcStat)
}

func childProcessGroupMembersFromPIDs(pids []int, groupID int, rootStartedAt time.Time, readStat func(int) (childProcStat, error)) ([]child.ProcessMember, error) {
	processes := make([]childProcessObservation, 0, len(pids))
	for _, pid := range pids {
		stat, skip, err := observeChildProcStat(pid, readStat)
		if err != nil {
			return nil, fmt.Errorf("inspect Linux process %d for group membership: %w", pid, err)
		}
		if skip {
			continue
		}
		processes = append(processes, childProcessObservation{PID: pid, GroupID: stat.processGroupID, Identity: strconv.FormatInt(stat.startTicks, 10), StartedAt: time.Unix(0, stat.startTicks), State: stat.state})
	}
	return liveOwnedGroupMembers(processes, groupID, rootStartedAt), nil
}

const maxUnavailableGroupReads = 3
const unavailableGroupRetryDelay = time.Millisecond

func observeChildProcStat(pid int, readStat func(int) (childProcStat, error)) (childProcStat, bool, error) {
	// procfs can sample a live state before it fails to lock sighand and leaves
	// pgid at its -1 sentinel. Re-read only that sentinel; unknown identities
	// remain an error unless the task exits or disappears during observation.
	for attempt := 0; attempt < maxUnavailableGroupReads; attempt++ {
		stat, err := readStat(pid)
		if err != nil {
			if childProcessVanished(err) {
				return childProcStat{}, true, nil
			}
			return childProcStat{}, false, err
		}
		if stat.processGroupID != -1 {
			return stat, false, nil
		}
		if stat.state == 'Z' || stat.state == 'X' {
			return childProcStat{}, true, nil
		}
		if attempt+1 == maxUnavailableGroupReads {
			return childProcStat{}, false, fmt.Errorf("/proc/%d/stat process group remained unavailable after %d observations", pid, maxUnavailableGroupReads)
		}
		time.Sleep(unavailableGroupRetryDelay)
	}
	return childProcStat{}, false, fmt.Errorf("/proc/%d/stat process group observation exhausted", pid)
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
	return parseChildProcStat(pid, data)
}

func parseChildProcStat(pid int, data []byte) (childProcStat, error) {
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
	state := fields[0][0]
	processGroupID, err := strconv.Atoi(fields[2])
	if err != nil {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat has invalid process group (group unparseable)", pid)
	}
	if processGroupID < -1 {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat has invalid process group (group out of range)", pid)
	}
	startTicks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil || startTicks < 0 {
		return childProcStat{}, fmt.Errorf("/proc/%d/stat has invalid start time", pid)
	}
	return childProcStat{state: state, processGroupID: processGroupID, startTicks: startTicks}, nil
}
