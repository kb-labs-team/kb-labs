package processsignal

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

var ErrCannotSignalSafely = errors.New("proc: cannot signal safely")

// SignalStartedChild uses the process handle for a child that has not yet
// been waited, so its PID cannot be reused while startup cleanup owns it.
func SignalStartedChild(process *os.Process) error {
	if process == nil {
		return errors.New("proc: cannot signal safely: missing started child process")
	}
	return process.Kill()
}

type PIDFDOps interface {
	PidfdOpen(pid int) (int, error)
	Identity(pid int) (string, bool, error)
	PidfdSendSignal(fd int, signal syscall.Signal) error
	Close(fd int) error
}

// SignalPIDWithOps opens a pidfd before rechecking identity, so the identity
// check is followed by a signal to the process pinned by that descriptor.
func SignalPIDWithOps(pid int, identity string, signal syscall.Signal, ops PIDFDOps) (returnErr error) {
	if pid <= 0 || identity == "" {
		return fmt.Errorf("%w: process PID and start identity are required", ErrCannotSignalSafely)
	}
	fd, err := ops.PidfdOpen(pid)
	if err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return syscall.ESRCH
		}
		return fmt.Errorf("%w: process %d: open pidfd: %w", ErrCannotSignalSafely, pid, err)
	}
	defer func() {
		if err := ops.Close(fd); err != nil {
			closeErr := fmt.Errorf("%w: close pidfd for process %d: %w", ErrCannotSignalSafely, pid, err)
			if errors.Is(returnErr, syscall.ESRCH) {
				returnErr = closeErr
			} else {
				returnErr = errors.Join(returnErr, closeErr)
			}
		}
	}()
	current, alive, err := ops.Identity(pid)
	if err != nil {
		return fmt.Errorf("%w: verify process %d after opening pidfd: %w", ErrCannotSignalSafely, pid, err)
	}
	if !alive || current != identity {
		return syscall.ESRCH
	}
	if err := ops.PidfdSendSignal(fd, signal); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return syscall.ESRCH
		}
		return fmt.Errorf("%w: send %s to process %d through pidfd: %w", ErrCannotSignalSafely, signal, pid, err)
	}
	return nil
}
