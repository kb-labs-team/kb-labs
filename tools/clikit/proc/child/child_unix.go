//go:build darwin || linux

package child

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/proc/internal/processsignal"
)

func startManaged(command *exec.Cmd, mode Mode, observer ProcessObserver) (*Started, error) {
	return startManagedWithTerminator(command, mode, observer, terminateGroup)
}

func startManagedWithTerminator(command *exec.Cmd, mode Mode, observer ProcessObserver, terminate func(*exec.Cmd) error) (*Started, error) {
	if err := configureCommand(command, mode); err != nil {
		return nil, err
	}
	command.WaitDelay = pipeWaitDelay
	if err := command.Start(); err != nil {
		return nil, err
	}
	rootObservation := launchObservation(func() (ProcessIdentity, error) {
		return observer.RootIdentity(command.Process.Pid)
	})
	return &Started{pid: command.Process.Pid, wait: func(ctx context.Context) error {
		return waitCommand(ctx, command, pipeWaitDelay, observer, rootObservation, terminate)
	}}, nil
}

func configureCommand(command *exec.Cmd, mode Mode) error {
	attributes := &syscall.SysProcAttr{}
	switch mode {
	case ProcessGroup:
		attributes.Setpgid = true
	case Detached:
		attributes.Setsid = true
	default:
		return fmt.Errorf("start child: unknown mode %d", mode)
	}
	command.SysProcAttr = attributes
	return nil
}

func waitCommand(ctx context.Context, command *exec.Cmd, waitDelay time.Duration, observer ProcessObserver, rootObservation <-chan observationResult[ProcessIdentity], terminate func(*exec.Cmd) error) error {
	command.WaitDelay = waitDelay
	root, rootErr := awaitObservation(ctx, command.Process.Pid, "root identity", teardownDeadline(ctx, time.Now()), func() error {
		return terminate(command)
	}, rootObservation)
	if rootErr != nil {
		var observationErr *ProcessObservationError
		if errors.As(rootErr, &observationErr) {
			if observationErr.SignalErr == nil {
				observationErr.SignalErr = terminate(command)
			}
			startReaper(command)
			return observationErr
		}
		startReaper(command)
		return errors.Join(rootErr, terminate(command))
	}
	if root.PID != command.Process.Pid || root.Identity == "" || root.StartedAt.IsZero() {
		observationErr := &ProcessObservationError{
			PID:         command.Process.Pid,
			Observation: "root identity",
			Cause:       errors.New("observer returned an empty or mismatched process identity"),
		}
		observationErr.SignalErr = terminate(command)
		startReaper(command)
		return observationErr
	}
	waitDone := startReaper(command)
	select {
	case waitErr := <-waitDone:
		triggered := time.Now()
		members, observationErr := observeBounded(ctx, command.Process.Pid, "live members", teardownDeadline(ctx, triggered), nil, func() ([]ProcessMember, error) {
			return observer.LiveMembers(command.Process.Pid, root)
		})
		if observationErr != nil {
			var processObservationErr *ProcessObservationError
			if errors.As(observationErr, &processObservationErr) {
				processObservationErr.PIDs = memberPIDs(members)
			}
			return errors.Join(waitErr, observationErr)
		}
		if groupLeaderWasReused(command.Process.Pid, root, members) || len(members) == 0 {
			return waitErr
		}
		signalErr := terminate(command)
		return errors.Join(waitErr, signalErr, waitGroupGone(ctx, command.Process.Pid, observer, root, triggered, signalErr))
	case <-ctx.Done():
		triggered := time.Now()
		signalErr := terminate(command)
		return awaitCommand(ctx, command, observer, root, waitDone, triggered, signalErr)
	}
}

type observationResult[T any] struct {
	value T
	err   error
}

var errObserverDeadline = errors.New("observer did not return before teardown deadline")

func launchObservation[T any](observe func() (T, error)) <-chan observationResult[T] {
	result := make(chan observationResult[T], 1)
	go func() {
		value, err := observe()
		result <- observationResult[T]{value: value, err: err}
	}()
	return result
}

func startReaper(command *exec.Cmd) <-chan error {
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()
	return waitDone
}

func observeBounded[T any](ctx context.Context, pid int, name string, deadline time.Time, onContextDone func() error, observe func() (T, error)) (T, error) {
	return awaitObservation(ctx, pid, name, deadline, onContextDone, launchObservation(observe))
}

func awaitObservation[T any](ctx context.Context, pid int, name string, deadline time.Time, onContextDone func() error, result <-chan observationResult[T]) (T, error) {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	ctxDone := ctx.Done()
	var signalErr error
	for {
		select {
		case observed := <-result:
			if !time.Now().Before(deadline) {
				return *new(T), &ProcessObservationError{PID: pid, Observation: name, Cause: errObserverDeadline, SignalErr: signalErr}
			}
			if observed.err != nil {
				return observed.value, &ProcessObservationError{PID: pid, Observation: name, Cause: observed.err, SignalErr: signalErr}
			}
			return observed.value, nil
		case <-ctxDone:
			ctxDone = nil
			if onContextDone != nil {
				signalErr = onContextDone()
			}
			deadline = earlier(deadline, time.Now().Add(teardownGrace))
			resetTimer(timer, deadline)
		case <-timer.C:
			return *new(T), &ProcessObservationError{PID: pid, Observation: name, Cause: errObserverDeadline, SignalErr: signalErr}
		}
	}
}

func awaitCommand(ctx context.Context, command *exec.Cmd, observer ProcessObserver, root ProcessIdentity, waitDone <-chan error, triggered time.Time, signalErr error) error {
	deadline := teardownDeadline(ctx, triggered)
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	ctxDone := ctx.Done()
	for {
		select {
		case waitErr := <-waitDone:
			if !time.Now().Before(deadline) {
				return &WaitDeadlineError{RootPID: command.Process.Pid, GroupID: command.Process.Pid, SignalErr: signalErr, Cause: context.Cause(ctx)}
			}
			return errors.Join(context.Cause(ctx), waitErr, signalErr, waitGroupGone(ctx, command.Process.Pid, observer, root, triggered, signalErr))
		case <-ctxDone:
			ctxDone = nil
			deadline = earlier(deadline, time.Now().Add(teardownGrace))
			resetTimer(timer, deadline)
		case <-timer.C:
			return &WaitDeadlineError{RootPID: command.Process.Pid, GroupID: command.Process.Pid, SignalErr: signalErr, Cause: context.Cause(ctx)}
		}
	}
}

func waitGroupGone(ctx context.Context, pid int, observer ProcessObserver, root ProcessIdentity, triggered time.Time, signalErr error) error {
	deadline := teardownDeadline(ctx, triggered)
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	settle := time.NewTicker(10 * time.Millisecond)
	defer settle.Stop()
	ctxDone := ctx.Done()
	var members []ProcessMember
	for {
		var observationErr error
		members, observationErr = observeBounded(ctx, pid, "live members", deadline, nil, func() ([]ProcessMember, error) {
			return observer.LiveMembers(pid, root)
		})
		if observationErr != nil {
			var processObservationErr *ProcessObservationError
			if errors.As(observationErr, &processObservationErr) {
				processObservationErr.PIDs = memberPIDs(members)
				processObservationErr.SignalErr = signalErr
				return processObservationErr
			}
			return observationErr
		}
		if groupLeaderWasReused(pid, root, members) || len(members) == 0 {
			return nil
		}
		if !time.Now().Before(deadline) {
			return ownedProcessesRemain(pid, members, signalErr)
		}
		select {
		case <-timer.C:
			return ownedProcessesRemain(pid, members, signalErr)
		case <-ctxDone:
			ctxDone = nil
			deadline = earlier(deadline, time.Now().Add(teardownGrace))
			resetTimer(timer, deadline)
		case <-settle.C:
		}
	}
}

func groupLeaderWasReused(groupID int, root ProcessIdentity, members []ProcessMember) bool {
	for _, member := range members {
		if member.PID == groupID && member.Identity != root.Identity {
			return true
		}
	}
	return false
}

func memberPIDs(members []ProcessMember) []int {
	pids := make([]int, len(members))
	for index, member := range members {
		pids[index] = member.PID
	}
	return pids
}

func teardownDeadline(ctx context.Context, triggered time.Time) time.Time {
	deadline := triggered.Add(teardownGrace)
	if contextDeadline, ok := ctx.Deadline(); ok {
		deadline = earlier(deadline, contextDeadline.Add(teardownGrace))
	}
	if ctx.Err() != nil {
		deadline = earlier(deadline, time.Now().Add(teardownGrace))
	}
	return deadline
}

func earlier(first, second time.Time) time.Time {
	if second.Before(first) {
		return second
	}
	return first
}

func resetTimer(timer *time.Timer, deadline time.Time) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(time.Until(deadline))
}

func ownedProcessesRemain(groupID int, members []ProcessMember, signalErr error) error {
	pids := make([]int, len(members))
	for i, member := range members {
		pids[i] = member.PID
	}
	return &OwnedProcessesRemainError{GroupID: groupID, PIDs: pids, SignalErr: signalErr}
}

func terminateTree(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("terminate child tree: invalid pid %d", pid)
	}
	return processsignal.SignalProcessGroup(pid, syscall.SIGTERM)
}

func killTree(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("kill child tree: invalid pid %d", pid)
	}
	return processsignal.SignalProcessGroup(pid, syscall.SIGKILL)
}

func terminateGroup(command *exec.Cmd) error {
	if command.Process == nil {
		return os.ErrProcessDone
	}
	return killTree(command.Process.Pid)
}
