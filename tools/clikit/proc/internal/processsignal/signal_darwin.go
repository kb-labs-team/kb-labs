//go:build darwin

package processsignal

import (
	"errors"
	"fmt"
	"syscall"
)

func SignalPID(pid int, identity string, signal syscall.Signal, identityOf func(int) (string, bool, error)) error {
	if pid <= 0 || identity == "" {
		return fmt.Errorf("%w: process PID and start identity are required", ErrCannotSignalSafely)
	}
	current, alive, err := identityOf(pid)
	if err != nil {
		return fmt.Errorf("%w: verify process %d: %w", ErrCannotSignalSafely, pid, err)
	}
	if !alive || current != identity {
		return syscall.ESRCH
	}
	// Darwin has no pidfd; keep identity verification immediately before kill. A small PID-reuse window remains between this check and the syscall.
	return syscall.Kill(pid, signal)
}

func SignalProcessGroup(pgid int, signal syscall.Signal) error {
	if pgid <= 0 {
		return fmt.Errorf("proc: invalid process group id %d", pgid)
	}
	if err := syscall.Kill(-pgid, signal); errors.Is(err, syscall.ESRCH) {
		return nil
	} else {
		return err
	}
}
