//go:build windows

package child

import (
	"errors"
	"syscall"
)

func signalIdentity(ProcessObserver, ProcessIdentity, syscall.Signal) error {
	return errors.New("signal process identity: unsupported operating system")
}
