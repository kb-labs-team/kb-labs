//go:build windows

package host

import (
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
)

const detachedProcess = 0x00000008

// configureHostProcess gives the host its own process group so console
// control events sent to the launcher do not reach it.
func configureHostProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// ConfigureDetached starts cmd without a console so it outlives the caller.
func ConfigureDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | detachedProcess}
}

// Windows has no SIGTERM. taskkill without /F asks windowed processes to
// close; console hosts typically ignore it and are ended by the forced pass
// after the grace period. /T includes the whole process tree.
func terminateProcessGroup(pid int) {
	_ = exec.Command("taskkill", "/T", "/PID", strconv.Itoa(pid)).Run()
}
func killProcessGroup(pid int) {
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
}

func TerminateProcess(pid int) { terminateProcessGroup(pid) }
func KillProcess(pid int)      { killProcessGroup(pid) }

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
