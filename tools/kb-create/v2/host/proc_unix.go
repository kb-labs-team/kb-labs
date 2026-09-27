//go:build !windows

package host

import (
	"errors"
	"os/exec"
	"syscall"
)

// configureHostProcess puts the host in its own process group so a signal to
// the group reaches every child it spawned.
func configureHostProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// ConfigureDetached starts cmd in a new session so it outlives the caller's
// terminal (used to spawn the supervise process).
func ConfigureDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func terminateProcessGroup(pid int) { _ = syscall.Kill(-pid, syscall.SIGTERM) }
func killProcessGroup(pid int)      { _ = syscall.Kill(-pid, syscall.SIGKILL) }

// TerminateProcess asks a single process (the supervisor) to shut down.
func TerminateProcess(pid int) { _ = syscall.Kill(pid, syscall.SIGTERM) }

// KillProcess force-kills a single process.
func KillProcess(pid int) { _ = syscall.Kill(pid, syscall.SIGKILL) }

// ProcessAlive reports whether pid exists (EPERM still means it exists).
func ProcessAlive(pid int) bool { return processAlive(pid) }

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
