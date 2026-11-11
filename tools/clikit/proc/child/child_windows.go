//go:build windows

package child

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func configureCommand(command *exec.Cmd, mode Mode) error {
	flags := uint32(windows.CREATE_NEW_PROCESS_GROUP)
	switch mode {
	case ProcessGroup:
	case Detached:
		flags |= windows.DETACHED_PROCESS
	default:
		return errors.New("start child: unknown mode " + strconv.Itoa(int(mode)))
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags}
	return nil
}

// Windows uses the retained Job Object as the process-tree completion owner;
// the observer is used only by Unix process-table confirmation.
func startManaged(command *exec.Cmd, mode Mode, _ ProcessObserver) (*Started, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, errors.Join(err, windows.CloseHandle(job))
	}
	if err := configureCommand(command, mode); err != nil {
		return nil, errors.Join(err, windows.CloseHandle(job))
	}
	command.WaitDelay = pipeWaitDelay
	if err := command.Start(); err != nil {
		return nil, errors.Join(err, windows.CloseHandle(job))
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(command.Process.Pid))
	if err != nil {
		return nil, errors.Join(err, command.Process.Kill(), command.Wait(), windows.CloseHandle(job))
	}
	assignErr := windows.AssignProcessToJobObject(job, process)
	closeProcessErr := windows.CloseHandle(process)
	if assignErr != nil {
		return nil, errors.Join(assignErr, closeProcessErr, command.Process.Kill(), command.Wait(), windows.CloseHandle(job))
	}
	return &Started{pid: command.Process.Pid, wait: func(ctx context.Context) error {
		return waitCommand(ctx, command, job, pipeWaitDelay)
	}}, nil
}

func waitCommand(ctx context.Context, command *exec.Cmd, job windows.Handle, waitDelay time.Duration) error {
	command.WaitDelay = waitDelay
	finished := make(chan struct{})
	watcherDone := make(chan struct{})
	var cancelErr error
	go func() {
		defer close(watcherDone)
		select {
		case <-ctx.Done():
			cancelErr = windows.TerminateJobObject(job, 1)
		case <-finished:
		}
	}()
	waitErr := command.Wait()
	close(finished)
	<-watcherDone
	return errors.Join(waitErr, cancelErr, windows.CloseHandle(job))
}

func terminateTree(pid int) error {
	return taskkillTree(pid, false)
}

func killTree(pid int) error {
	return taskkillTree(pid, true)
}

func taskkillTree(pid int, force bool) error {
	if pid <= 0 {
		return fmt.Errorf("terminate child tree: invalid pid %d", pid)
	}
	args := []string{"/T"}
	if force {
		args = append(args, "/F")
	}
	args = append(args, "/PID", strconv.Itoa(pid))
	output, err := exec.Command("taskkill", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("taskkill pid %d: %w (%s)", pid, err, string(output))
	}
	return nil
}
