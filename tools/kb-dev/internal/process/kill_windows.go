//go:build windows

package process

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows"

	"github.com/kb-labs/clikit/proc/child"
)

// killGroup terminates the process tree rooted at pid using taskkill /T /F.
// On Windows there are no process groups — pgid is ignored; pid is used instead.
func killGroup(_ int, pid int, _ time.Duration) error {
	if pid <= 0 {
		return nil
	}
	return child.KillTree(pid)
}

// killPort kills all processes in pids using taskkill.
func killPort(pids []int) {
	for _, pid := range pids {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
	}
}

// isAlive returns true if the process with the given PID is still running.
func isAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}

// groupAlive is an alias for isAlive on Windows — pgid == pid.
func groupAlive(pgid int) bool {
	return isAlive(pgid)
}

// getListenerPIDs finds PIDs listening on a TCP port using netstat.
func getListenerPIDs(port int) []int {
	// netstat -ano lists TCP connections with PIDs.
	// Format: "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234"
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return nil
	}

	target := fmt.Sprintf(":%d", port)
	pidSet := make(map[int]struct{})

	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "LISTENING") {
			continue
		}
		fields := strings.Fields(line)
		// fields: Proto LocalAddr ForeignAddr State PID
		if len(fields) < 5 {
			continue
		}
		if !strings.HasSuffix(fields[1], target) {
			continue
		}
		pid, err := strconv.Atoi(fields[4])
		if err != nil || pid <= 0 {
			continue
		}
		pidSet[pid] = struct{}{}
	}

	pids := make([]int, 0, len(pidSet))
	for pid := range pidSet {
		pids = append(pids, pid)
	}
	return pids
}

func commandLine(_ int) string { return "" }
