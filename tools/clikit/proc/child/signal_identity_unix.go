//go:build darwin || linux

package child

import (
	"fmt"
	"os"
	"syscall"

	"github.com/kb-labs/clikit/proc/internal/processsignal"
)

func signalIdentity(observer ProcessObserver, expected ProcessIdentity, signal syscall.Signal) error {
	return processsignal.SignalPID(expected.PID, expected.Identity, signal, func(pid int) (string, bool, error) {
		observed, err := observer.RootIdentity(pid)
		if err != nil {
			return "", false, err
		}
		if observed.PID != pid || (!expected.StartedAt.IsZero() && !observed.StartedAt.Equal(expected.StartedAt)) {
			return "", false, fmt.Errorf("process %d identity observation changed while signaling", pid)
		}
		return observed.Identity, true, nil
	})
}

// KillStartedProcess terminates a direct child through its unreaped process handle.
// The handle prevents PID reuse until the caller reaps the process.
func KillStartedProcess(process *os.Process) error {
	return processsignal.SignalStartedChild(process)
}
