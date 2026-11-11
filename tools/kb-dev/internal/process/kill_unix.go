//go:build !windows

package process

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/proc/child"
)

// killGroup sends SIGTERM to the entire process group identified by pgid,
// waits up to gracePeriod, then sends SIGKILL if still alive.
func killGroup(pgid int, _ int, gracePeriod time.Duration) error {
	if err := child.TerminateTree(pgid); err != nil {
		if err == syscall.ESRCH {
			return nil
		}
		return fmt.Errorf("SIGTERM to pgid %d: %w", pgid, err)
	}

	deadline := time.Now().Add(gracePeriod)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			return nil
		}
		time.Sleep(pollInterval)
	}

	if groupAlive(pgid) {
		if err := child.KillTree(pgid); err != nil {
			return fmt.Errorf("SIGKILL to pgid %d: %w", pgid, err)
		}
		time.Sleep(pollInterval)
	}

	return nil
}

// killPort kills all processes listening on port using SIGTERM then SIGKILL.
func killPort(pids []int) {
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	time.Sleep(1 * time.Second)
	for _, pid := range pids {
		if isAlive(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// isAlive returns true if the process with the given PID exists.
func isAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// groupAlive returns true if any process in the group is still running.
func groupAlive(pgid int) bool {
	return syscall.Kill(-pgid, 0) == nil
}

// getListenerPIDs finds PIDs listening on a TCP port using lsof.
func getListenerPIDs(port int) []int {
	return getListenerPIDsLsof(port)
}

func commandLine(pid int) string {
	if pid <= 0 {
		return ""
	}
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
