//go:build darwin || linux

package child

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"testing"
	"time"
)

type fixedGroupObserver struct {
	root    ProcessIdentity
	members []ProcessMember
	err     error
}

func (observer fixedGroupObserver) RootIdentity(pid int) (ProcessIdentity, error) {
	root := observer.root
	root.PID = pid
	if root.Identity == "" {
		root.Identity = fmt.Sprintf("test-root-%d", pid)
	}
	return root, nil
}

func (observer fixedGroupObserver) LiveMembers(int, ProcessIdentity) ([]ProcessMember, error) {
	return observer.members, observer.err
}

type failedRootObserver struct{ err error }

func (observer failedRootObserver) RootIdentity(int) (ProcessIdentity, error) {
	return ProcessIdentity{}, observer.err
}

func (observer failedRootObserver) LiveMembers(int, ProcessIdentity) ([]ProcessMember, error) {
	return nil, observer.err
}

type trackedRootFailureObserver struct {
	rootCalls    int
	memberCalls  int
	memberResult []ProcessMember
}

func (observer *trackedRootFailureObserver) RootIdentity(pid int) (ProcessIdentity, error) {
	observer.rootCalls++
	return ProcessIdentity{PID: pid}, nil
}

func (observer *trackedRootFailureObserver) LiveMembers(int, ProcessIdentity) ([]ProcessMember, error) {
	observer.memberCalls++
	return observer.memberResult, nil
}

type scriptedObserver struct {
	rootIdentity string
	startedAt    time.Time
	mu           sync.Mutex
	calls        int
	snapshots    [][]ProcessMember
	rootBlock    <-chan struct{}
	memberBlock  <-chan struct{}
}

func (observer *scriptedObserver) RootIdentity(pid int) (ProcessIdentity, error) {
	if observer.rootBlock != nil {
		<-observer.rootBlock
	}
	return ProcessIdentity{PID: pid, Identity: observer.rootIdentity, StartedAt: observer.startedAt}, nil
}

func (observer *scriptedObserver) LiveMembers(groupID int, root ProcessIdentity) ([]ProcessMember, error) {
	if observer.memberBlock != nil {
		<-observer.memberBlock
	}
	observer.mu.Lock()
	defer observer.mu.Unlock()
	index := observer.calls
	observer.calls++
	if index >= len(observer.snapshots) {
		return nil, nil
	}
	members := append([]ProcessMember(nil), observer.snapshots[index]...)
	for index := range members {
		if members[index].PID == 0 {
			members[index].PID = groupID
		}
	}
	return members, nil
}

func (observer *scriptedObserver) callCount() int {
	observer.mu.Lock()
	defer observer.mu.Unlock()
	return observer.calls
}

type groupTerminator func(*exec.Cmd) error

// case: S-261.6
func TestWaitReturnsTypedErrorWithKnownMembersWhenObservationFails(t *testing.T) {
	observer := fixedGroupObserver{
		root:    ProcessIdentity{PID: 4244, StartedAt: time.Now()},
		members: []ProcessMember{{PID: 4245, Identity: "4245:survivor"}},
		err:     errors.New("process table unavailable"),
	}
	command := exec.Command("sh", "-c", "exit 0")
	started, err := StartManaged(command, ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	err = waitStartedBounded(t, started, context.Background())
	var confirmationErr *ProcessObservationError
	if !errors.As(err, &confirmationErr) {
		t.Fatalf("wait error = %v, want ProcessObservationError", err)
	}
	if confirmationErr.PID != command.Process.Pid || confirmationErr.Observation != "live members" || len(confirmationErr.PIDs) != 1 || confirmationErr.PIDs[0] != 4245 || confirmationErr.Cause == nil {
		t.Fatalf("confirmation error = %+v, want PID, observation, known survivor PID, and observation error", confirmationErr)
	}
}

// case: S-261.6
func TestRootIdentityFailureMakesNoMembershipClaim(t *testing.T) {
	observer := &trackedRootFailureObserver{memberResult: []ProcessMember{{PID: 4248, Identity: "unbound"}}}
	started, err := StartManaged(exec.Command("sh", "-c", "exit 0"), ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	err = waitStartedBounded(t, started, context.Background())
	var observationErr *ProcessObservationError
	if !errors.As(err, &observationErr) || observationErr.Observation != "root identity" {
		t.Fatalf("wait error = %v, want root identity ProcessObservationError", err)
	}
	var survivors *OwnedProcessesRemainError
	if errors.As(err, &survivors) {
		t.Fatalf("root identity failure became an unbound survivor claim: %+v", survivors)
	}
	if observer.memberCalls != 0 {
		t.Fatalf("LiveMembers calls = %d, want no membership claim after root identity failure", observer.memberCalls)
	}
}

// case: S-261.6
func TestReusedGroupLeaderIsGone(t *testing.T) {
	observer := &scriptedObserver{
		rootIdentity: "root:started",
		startedAt:    time.Now(),
		snapshots:    [][]ProcessMember{{{Identity: "reused:leader"}}},
	}
	started, err := StartManaged(exec.Command("sh", "-c", "exit 0"), ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	if err := waitStartedBounded(t, started, context.Background()); err != nil {
		t.Fatalf("wait after process-group leader identity changed: %v", err)
	}
	if calls := observer.callCount(); calls != 1 {
		t.Fatalf("LiveMembers calls = %d, want one reused-leader snapshot", calls)
	}
}

// case: S-261.6
func TestEmptyGroupSnapshotLatchesGone(t *testing.T) {
	observer := &scriptedObserver{
		rootIdentity: "root:started",
		startedAt:    time.Now(),
		snapshots: [][]ProcessMember{
			{},
			{{PID: 4250, Identity: "later:member"}},
		},
	}
	started, err := StartManaged(exec.Command("sh", "-c", "exit 0"), ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	if err := waitStartedBounded(t, started, context.Background()); err != nil {
		t.Fatalf("wait after empty group snapshot: %v", err)
	}
	if calls := observer.callCount(); calls != 1 {
		t.Fatalf("LiveMembers calls = %d, want no re-observation after the empty snapshot", calls)
	}
}

// case: S-261.6
func TestWaitReturnsBoundedTypedErrorForLiveSurvivor(t *testing.T) {
	observer := fixedGroupObserver{
		root:    ProcessIdentity{PID: 4241, StartedAt: time.Now()},
		members: []ProcessMember{{PID: 4242, Identity: "4242:survivor"}},
	}
	command := exec.Command("sh", "-c", "exit 0")
	started, err := StartManaged(command, ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	begin := time.Now()
	err = waitStartedBounded(t, started, context.Background())
	elapsed := time.Since(begin)
	var survivors *OwnedProcessesRemainError
	if !errors.As(err, &survivors) {
		t.Fatalf("wait error = %v, want OwnedProcessesRemainError", err)
	}
	if survivors.GroupID != command.Process.Pid || len(survivors.PIDs) != 1 || survivors.PIDs[0] != 4242 {
		t.Fatalf("survivor error = %+v, want group %d and PID 4242", survivors, command.Process.Pid)
	}
	if elapsed > 600*time.Millisecond {
		t.Fatalf("wait took %s, exceeds the teardown bound", elapsed)
	}
}

// case: S-261.6
func TestWaitAcceptsGroupWithoutLiveMembers(t *testing.T) {
	observer := fixedGroupObserver{
		root: ProcessIdentity{PID: 4243, StartedAt: time.Now()},
	}
	started, err := StartManaged(exec.Command("sh", "-c", "exit 0"), ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	if err := waitStartedBounded(t, started, context.Background()); err != nil {
		t.Fatalf("wait with no live owned members: %v", err)
	}
}

// case: S-261.6
func TestWaitBoundsCancellationWhenGroupSignalFails(t *testing.T) {
	command := exec.Command("sh", "-c", "exec sleep 30")
	started, err := startManagedWithTerminator(command, ProcessGroup, fixedGroupObserver{
		root:    ProcessIdentity{PID: 4246, StartedAt: time.Now()},
		members: []ProcessMember{{PID: 4247, Identity: "4247:survivor"}},
	}, groupTerminator(func(*exec.Cmd) error { return syscall.EPERM }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- started.Wait(ctx) }()
	startedAt := time.Now()
	cancel()

	select {
	case err := <-done:
		if elapsed := time.Since(startedAt); elapsed > 600*time.Millisecond {
			t.Fatalf("Wait took %s after cancellation, exceeds teardown bound", elapsed)
		}
		var waitErr *WaitDeadlineError
		if !errors.As(err, &waitErr) {
			t.Fatalf("Wait error = %v, want WaitDeadlineError", err)
		}
		if waitErr.RootPID != command.Process.Pid || waitErr.GroupID != command.Process.Pid || !errors.Is(waitErr.SignalErr, syscall.EPERM) {
			t.Fatalf("WaitDeadlineError = %+v, want root PID %d and EPERM", waitErr, command.Process.Pid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Wait exceeded caller cancellation plus teardown grace")
	}
}

// case: S-261.6
func TestStartedWaitRejectsSecondConcurrentCallImmediately(t *testing.T) {
	command := exec.Command("sh", "-c", "exec sleep 30")
	started, err := StartManaged(command, ProcessGroup, fixedGroupObserver{
		root: ProcessIdentity{PID: 4249, StartedAt: time.Now()},
	})
	if err != nil {
		t.Fatal(err)
	}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	secondDone := make(chan error, 1)
	firstEntered := make(chan struct{})
	originalWait := started.wait
	started.wait = func(ctx context.Context) error {
		close(firstEntered)
		return originalWait(ctx)
	}
	go func() { firstDone <- started.Wait(firstCtx) }()
	t.Cleanup(func() {
		cancelFirst()
		select {
		case <-firstDone:
		case <-time.After(2 * time.Second):
			t.Errorf("first Wait did not return after cancellation")
			if command.Process != nil {
				_ = command.Process.Kill()
			}
		}
	})
	select {
	case <-firstEntered:
	case <-time.After(time.Second):
		t.Fatal("first Wait did not enter the lifecycle wait")
	}

	secondCtx, cancelSecond := context.WithCancel(context.Background())
	cancelSecond()
	go func() { secondDone <- started.Wait(secondCtx) }()
	select {
	case err := <-secondDone:
		var calledErr *WaitCalledError
		if !errors.As(err, &calledErr) {
			t.Fatalf("second Wait error = %v, want WaitCalledError", err)
		}
		if calledErr.PID != command.Process.Pid || !errors.Is(err, ErrWaitCalled) {
			t.Fatalf("second Wait error = %+v, want process PID %d and ErrWaitCalled", calledErr, command.Process.Pid)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("second Wait blocked on the first caller's context")
	}
}

// case: S-261.6
func TestWaitBoundsRootObservationFailureWhenGroupSignalFails(t *testing.T) {
	observationErr := fmt.Errorf("process table unavailable")
	command := exec.Command("sh", "-c", "exec sleep 30")
	started, err := startManagedWithTerminator(command, ProcessGroup, failedRootObserver{err: observationErr}, groupTerminator(func(*exec.Cmd) error { return syscall.EPERM }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	})

	startedAt := time.Now()
	select {
	case err := <-waitInBackground(started, context.Background()):
		if elapsed := time.Since(startedAt); elapsed > 600*time.Millisecond {
			t.Fatalf("Wait took %s after root identity failure, exceeds teardown bound", elapsed)
		}
		var waitErr *ProcessObservationError
		if !errors.As(err, &waitErr) {
			t.Fatalf("Wait error = %v, want ProcessObservationError", err)
		}
		if waitErr.PID != command.Process.Pid || waitErr.Observation != "root identity" || !errors.Is(waitErr.SignalErr, syscall.EPERM) || !errors.Is(err, observationErr) {
			t.Fatalf("ProcessObservationError = %+v, want root PID %d, EPERM, and observation error", waitErr, command.Process.Pid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Wait exceeded root observation failure plus teardown grace")
	}
}

// case: S-261.6
func TestBlockedRootIdentityReturnsBoundedObservationError(t *testing.T) {
	blocked := make(chan struct{})
	observer := &scriptedObserver{rootBlock: blocked}
	command := exec.Command("sh", "-c", "exec sleep 30")
	startedResult := make(chan struct {
		started *Started
		err     error
	}, 1)
	go func() {
		started, err := StartManaged(command, ProcessGroup, observer)
		startedResult <- struct {
			started *Started
			err     error
		}{started: started, err: err}
	}()
	t.Cleanup(func() { close(blocked) })
	var started *Started
	select {
	case result := <-startedResult:
		if result.err != nil {
			t.Fatal(result.err)
		}
		started = result.started
	case <-time.After(time.Second):
		t.Fatal("StartManaged blocked on RootIdentity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	begin := time.Now()
	var err error
	errCh := waitInBackground(started, ctx)
	select {
	case err = <-errCh:
	case <-time.After(2 * time.Second):
		t.Fatal("Wait blocked with a stuck RootIdentity observer")
	}
	if elapsed := time.Since(begin); elapsed > 600*time.Millisecond {
		t.Fatalf("Wait took %s with blocked RootIdentity, exceeds context plus teardown grace", elapsed)
	}
	var observationErr *ProcessObservationError
	if !errors.As(err, &observationErr) || observationErr.PID != command.Process.Pid || observationErr.Observation != "root identity" {
		t.Fatalf("Wait error = %v, want bounded root identity observation error for PID %d", err, command.Process.Pid)
	}
}

// case: S-261.6
func TestBlockedLiveMembersReturnsBoundedObservationError(t *testing.T) {
	blocked := make(chan struct{})
	observer := &scriptedObserver{rootIdentity: "root:started", startedAt: time.Now(), memberBlock: blocked}
	command := exec.Command("sh", "-c", "exit 0")
	started, err := StartManaged(command, ProcessGroup, observer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { close(blocked) })
	begin := time.Now()
	errCh := waitInBackground(started, context.Background())
	select {
	case err = <-errCh:
	case <-time.After(2 * time.Second):
		t.Fatal("Wait blocked with a stuck LiveMembers observer")
	}
	if elapsed := time.Since(begin); elapsed > 600*time.Millisecond {
		t.Fatalf("Wait took %s with blocked LiveMembers, exceeds teardown grace", elapsed)
	}
	var observationErr *ProcessObservationError
	if !errors.As(err, &observationErr) || observationErr.PID != command.Process.Pid || observationErr.Observation != "live members" {
		t.Fatalf("Wait error = %v, want bounded live-members observation error for PGID %d", err, command.Process.Pid)
	}
}

func waitInBackground(started *Started, ctx context.Context) <-chan error {
	done := make(chan error, 1)
	go func() { done <- started.Wait(ctx) }()
	return done
}

func waitStartedBounded(t *testing.T, started *Started, ctx context.Context) error {
	t.Helper()
	select {
	case err := <-waitInBackground(started, ctx):
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("Started.Wait exceeded the test bound")
		return nil
	}
}
