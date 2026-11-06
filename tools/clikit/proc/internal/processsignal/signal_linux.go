//go:build linux

package processsignal

import (
	"errors"
	"fmt"
	"syscall"

	"golang.org/x/sys/unix"
)

type linuxOps struct {
	identity func(int) (string, bool, error)
}

func (ops linuxOps) PidfdOpen(pid int) (int, error)         { return unix.PidfdOpen(pid, 0) }
func (ops linuxOps) Identity(pid int) (string, bool, error) { return ops.identity(pid) }
func (linuxOps) PidfdSendSignal(fd int, signal syscall.Signal) error {
	return unix.PidfdSendSignal(fd, unix.Signal(signal), nil, 0)
}
func (linuxOps) Close(fd int) error { return unix.Close(fd) }

func SignalPID(pid int, identity string, signal syscall.Signal, identityOf func(int) (string, bool, error)) error {
	return SignalPIDWithOps(pid, identity, signal, linuxOps{identity: identityOf})
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
