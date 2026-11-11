// Package child launches and reaps a command together with its owned process group.
// Descendants that leave that group with setsid or setpgid are outside this
// package's ownership contract; kb-runner's S-237 process-tree supervisor owns them.
package child

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync/atomic"
	"syscall"
	"time"
)

const pipeWaitDelay = 300 * time.Millisecond
const teardownGrace = pipeWaitDelay

// ProcessIdentity identifies a process by PID and its observed start time.
type ProcessIdentity struct {
	PID       int
	Identity  string
	StartedAt time.Time
}

// ProcessMember is a live process-table entry in an owned process group.
type ProcessMember struct {
	PID      int
	Identity string
}

// ProcessObserver delegates process-group membership to the platform process
// table package while child owns the bounded wait lifecycle.
type ProcessObserver interface {
	RootIdentity(pid int) (ProcessIdentity, error)
	LiveMembers(groupID int, root ProcessIdentity) ([]ProcessMember, error)
}

// SignalIdentity signals the process currently carrying identity through the
// observer's identity source. Linux binds the signal to a pidfd; Darwin checks
// the identity immediately before signaling because it has no pidfd.
func SignalIdentity(observer ProcessObserver, identity ProcessIdentity, signal syscall.Signal) error {
	if observer == nil {
		return errors.New("signal process identity: process observer is nil")
	}
	if identity.PID <= 0 || identity.Identity == "" {
		return errors.New("signal process identity: PID and start identity are required")
	}
	return signalIdentity(observer, identity, signal)
}

// OwnedProcessesRemainError reports live group members that survived teardown.
type OwnedProcessesRemainError struct {
	GroupID   int
	PIDs      []int
	SignalErr error
}

func (err *OwnedProcessesRemainError) Error() string {
	if err.SignalErr != nil {
		return fmt.Sprintf("owned process group %d still has live survivor PIDs %v after teardown grace; signal failed: %v", err.GroupID, err.PIDs, err.SignalErr)
	}
	return fmt.Sprintf("owned process group %d still has live survivor PIDs %v after teardown grace", err.GroupID, err.PIDs)
}

// WaitDeadlineError reports that a started command could not be reaped before
// its teardown deadline. Its reap goroutine continues waiting for the process.
type WaitDeadlineError struct {
	RootPID   int
	GroupID   int
	SignalErr error
	Cause     error
}

func (err *WaitDeadlineError) Error() string {
	return fmt.Sprintf("root process %d did not exit within teardown grace; owned process group %d; signal error: %v", err.RootPID, err.GroupID, err.SignalErr)
}

func (err *WaitDeadlineError) Unwrap() error {
	return errors.Join(err.SignalErr, err.Cause)
}

// ProcessObservationError reports a failed or blocked process identity/member observation.
type ProcessObservationError struct {
	PID         int
	Observation string
	PIDs        []int
	Cause       error
	SignalErr   error
}

func (err *ProcessObservationError) Error() string {
	message := fmt.Sprintf("process %d %s observation failed", err.PID, err.Observation)
	if err.Cause != nil {
		message += fmt.Sprintf(": %v", err.Cause)
	}
	if err.SignalErr != nil {
		message += fmt.Sprintf("; process-group signal failed: %v", err.SignalErr)
	}
	if len(err.PIDs) > 0 {
		message += fmt.Sprintf("; last observed live member PIDs %v", err.PIDs)
	}
	return message
}

func (err *ProcessObservationError) Unwrap() error {
	return errors.Join(err.Cause, err.SignalErr)
}

// ErrWaitCalled marks an attempted second call to Started.Wait.
var ErrWaitCalled = errors.New("started child wait already called")

// WaitCalledError reports that Wait was already called for the started process.
type WaitCalledError struct {
	PID int
}

func (err *WaitCalledError) Error() string {
	return fmt.Sprintf("wait already called for process %d", err.PID)
}

func (err *WaitCalledError) Unwrap() error { return ErrWaitCalled }

// Mode describes the lifetime and ownership relationship for a started child.
type Mode uint8

const (
	// ProcessGroup isolates a command so its process group can be signaled together.
	ProcessGroup Mode = iota + 1
	// Detached lets a long-lived service outlive the process that starts it.
	Detached
)

// Started owns a started child and the platform resources needed to wait for
// and terminate its process group.
type Started struct {
	waitCalled atomic.Bool
	pid        int
	wait       func(context.Context) error
}

// StartManaged starts a child with the requested ownership mode and retains
// the resources required for process-group cleanup until Wait returns.
func StartManaged(command *exec.Cmd, mode Mode, observer ProcessObserver) (*Started, error) {
	if command == nil {
		return nil, fmt.Errorf("start child: command is nil")
	}
	if observer == nil {
		return nil, fmt.Errorf("start child: process observer is nil")
	}
	return startManaged(command, mode, observer)
}

// Wait waits for the child and its owned process group, terminating the group
// when ctx is canceled. Wait is single-call, like exec.Cmd.Wait; a concurrent
// or later call returns WaitCalledError immediately and does not join the first
// caller's wait or context.
func (s *Started) Wait(ctx context.Context) error {
	if s == nil || s.wait == nil {
		return fmt.Errorf("wait child: command has not started")
	}
	if !s.waitCalled.CompareAndSwap(false, true) {
		return &WaitCalledError{PID: s.pid}
	}
	return s.wait(ctx)
}

// Start configures and starts a child using the requested process ownership mode.
// Callers own waiting and process-group termination after a successful start.
func Start(command *exec.Cmd, mode Mode) error {
	if command == nil {
		return fmt.Errorf("start child: command is nil")
	}
	if err := Configure(command, mode); err != nil {
		return err
	}
	return command.Start()
}

// Configure applies the OS process attributes for a mode without starting the
// command. This is used when a caller must add platform attributes before start.
func Configure(command *exec.Cmd, mode Mode) error {
	if command == nil {
		return fmt.Errorf("configure child: command is nil")
	}
	return configureCommand(command, mode)
}

// TerminateTree requests graceful termination of the process group rooted at pid.
func TerminateTree(pid int) error { return terminateTree(pid) }

// KillTree forcefully terminates the process group rooted at pid.
func KillTree(pid int) error { return killTree(pid) }

// Run starts a command, terminates its process group when ctx is canceled, and
// bounds waiting for inherited output pipes after the tree exits.
func Run(ctx context.Context, command *exec.Cmd, observer ProcessObserver) error {
	started, err := StartManaged(command, ProcessGroup, observer)
	if err != nil {
		return err
	}
	return started.Wait(ctx)
}
