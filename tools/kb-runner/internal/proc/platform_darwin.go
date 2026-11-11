//go:build darwin

package proc

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	clikitproc "github.com/kb-labs/clikit/proc"
	"github.com/kb-labs/clikit/proc/child"
	"golang.org/x/sys/unix"
)

const ancestrySampleInterval = 100 * time.Millisecond

func configureKeeper(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func processStartTimeBound() (time.Time, error) { return time.Now().UTC(), nil }

func readProcessCWD(pid int) (string, error) {
	output, err := exec.Command("lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("lsof cwd for process %d: %w: %s", pid, err, output)
	}
	for _, record := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(record, "n") {
			return strings.TrimPrefix(record, "n"), nil
		}
	}
	return "", fmt.Errorf("lsof returned no cwd for process %d", pid)
}

func prepareKeeperPlatform() error { return nil }

func finishKeeperPlatform() error { return nil }

func monitorLauncher(parentPID int, parentIdentity string, lifetime *os.File) (<-chan error, error) {
	if lifetime == nil {
		return nil, errors.New("launcher lifetime pipe is required")
	}
	if err := lifetime.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		return nil, fmt.Errorf("close unused launcher lifetime pipe: %w", err)
	}
	return monitorParent(parentPID, parentIdentity)
}

// Darwin keeps ancestry and recorded-identity recovery: process environments may be hidden for platform binaries, so the Linux run-marker scan is not an authoritative source here.
func lostRunRecoverySource(_ record, source processSource) (processSource, bool, error) {
	return source, false, nil
}

func monitorParent(parentPID int, parentIdentity string) (<-chan error, error) {
	dead := make(chan error, 1)
	current, ok, identityErr := ProcessIdentity(parentPID)
	if identityErr != nil {
		return nil, fmt.Errorf("inspect supervisor process %d: %w", parentPID, identityErr)
	}
	if !ok || current != parentIdentity {
		return nil, fmt.Errorf("supervisor PID %d is no longer the process that started the keeper", parentPID)
	}
	kqueue, err := unix.Kqueue()
	if err != nil {
		return nil, fmt.Errorf("create parent-exit kqueue: %w", err)
	}
	change := unix.Kevent_t{Ident: uint64(parentPID), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ENABLE, Fflags: unix.NOTE_EXIT}
	if _, err := unix.Kevent(kqueue, []unix.Kevent_t{change}, nil, nil); err != nil {
		return nil, errors.Join(fmt.Errorf("watch supervisor exit: %w", err), unix.Close(kqueue))
	}
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
		defer signal.Stop(signals)
		kqueueDone := make(chan error, 1)
		go func() {
			events := make([]unix.Kevent_t, 1)
			_, eventErr := unix.Kevent(kqueue, nil, events, nil)
			kqueueDone <- eventErr
		}()
		var monitorErr error
		select {
		case err := <-kqueueDone:
			if err != nil {
				monitorErr = fmt.Errorf("wait for supervisor exit: %w", err)
			}
		case <-signals:
		}
		if err := unix.Close(kqueue); err != nil {
			monitorErr = errors.Join(monitorErr, fmt.Errorf("close parent-exit kqueue: %w", err))
		}
		dead <- monitorErr
	}()
	return dead, nil
}

func lockFile(file *os.File) (func() error, error) {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX); err != nil {
		return nil, err
	}
	return func() error { return unix.Flock(int(file.Fd()), unix.LOCK_UN) }, nil
}

func freeDiskBytes(path string) (uint64, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, fmt.Errorf("inspect free space on %s: %w", path, err)
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}

type osProcessSource struct{}

func (osProcessSource) Snapshot(runID string) ([]Process, error) { return allProcesses(runID) }
func (osProcessSource) Identity(pid int) (string, bool, error)   { return readProcessIdentity(pid) }
func (osProcessSource) ParentPID(pid int) (int, error) {
	info, alive, err := readProcessInfo(pid)
	if err != nil {
		return 0, err
	}
	if !alive || info == nil {
		return 0, fmt.Errorf("process %d exited while reading its parent", pid)
	}
	return int(info.Eproc.Ppid), nil
}
func (osProcessSource) Signal(pid int, identity string, signal syscall.Signal) error {
	return child.SignalIdentity(clikitproc.ChildProcessObserver(), child.ProcessIdentity{PID: pid, Identity: identity}, signal)
}
func (osProcessSource) SignalDirectChild(process *os.Process, identity string, signal syscall.Signal) error {
	if process == nil || process.Pid <= 0 || identity == "" {
		return errors.New("cannot signal direct child safely: process handle and start identity are required")
	}
	if err := process.Signal(signal); errors.Is(err, os.ErrProcessDone) {
		return syscall.ESRCH
	} else {
		return err
	}
}

func readProcessIdentity(pid int) (string, bool, error) {
	info, alive, err := readProcessInfo(pid)
	if err != nil || !alive {
		return "", alive, err
	}
	return formatStart(info), true, nil
}

func readProcessStartIdentity(pid int) (time.Time, string, bool, error) {
	info, alive, err := readProcessInfo(pid)
	if err != nil || info == nil {
		return time.Time{}, "", alive, err
	}
	started := time.Unix(info.Proc.P_starttime.Sec, int64(info.Proc.P_starttime.Usec)*1000)
	return started, formatStart(info), alive, nil
}

func readProcessInfo(pid int) (*unix.KinfoProc, bool, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		if processGone(err) {
			return nil, false, nil
		}
		probeErr := syscall.Kill(pid, 0)
		if errors.Is(probeErr, syscall.ESRCH) {
			return nil, false, nil
		}
		if probeErr != nil {
			return nil, false, errors.Join(fmt.Errorf("query kern.proc.pid for %d: %w", pid, err), fmt.Errorf("verify PID existence: %w", probeErr))
		}
		return nil, false, fmt.Errorf("query kern.proc.pid for %d: %w", pid, err)
	}
	if int(info.Proc.P_pid) != pid {
		return nil, false, nil
	}
	return info, info.Proc.P_stat != 5, nil
}

func readProcessArguments(pid int) ([]string, error) {
	data, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		if processGone(err) {
			return nil, err
		}
		return nil, fmt.Errorf("query kern.procargs2 for PID %d: %w", pid, err)
	}
	argv, err := procargs2Arguments(data)
	if err != nil {
		return nil, fmt.Errorf("parse kern.procargs2 for PID %d: %w", pid, err)
	}
	return argv, nil
}

func allProcesses(runID string) ([]Process, error) {
	return darwinProcessSnapshot(runID)
}

func reapAdopted() error { return nil }

func formatStart(info *unix.KinfoProc) string {
	return strconv.FormatInt(info.Proc.P_starttime.Sec, 10) + ":" + strconv.FormatInt(int64(info.Proc.P_starttime.Usec), 10)
}

func platformExit(err error) (*int, string, string) {
	if err == nil {
		code := 0
		return &code, "", ""
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return nil, strconv.Itoa(int(status.Signal())), ""
		}
		code := exitErr.ExitCode()
		return &code, "", ""
	}
	return nil, "", err.Error()
}

func signalNumber(signal string) int { n, _ := strconv.Atoi(signal); return n }
