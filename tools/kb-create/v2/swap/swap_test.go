package swap

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/kb-labs/clikit/diag"
	"reflect"
	"strings"
	"testing"

	"github.com/kb-labs/create/v2/contracts"
)

// fakeHost records the order of calls; resumeErrs is consumed one per Resume.
type fakeHost struct {
	running    bool
	haltErr    error
	resumeErrs []error
	calls      []string
}

func (h *fakeHost) Halt(context.Context) (bool, error) {
	h.calls = append(h.calls, "halt")
	return h.running, h.haltErr
}

func (h *fakeHost) Resume(context.Context) error {
	h.calls = append(h.calls, "resume")
	if len(h.resumeErrs) == 0 {
		return nil
	}
	err := h.resumeErrs[0]
	h.resumeErrs = h.resumeErrs[1:]
	return err
}

type steps struct {
	calls      []string
	changeErr  error
	restoreErr error
}

func (s *steps) operation(name string) Operation {
	return Operation{
		Name:            name,
		PreviousVersion: "1.0.0",
		Change: func(context.Context, bool) (string, error) {
			s.calls = append(s.calls, "change")
			return "snap-1", s.changeErr
		},
		Restore: func(_ context.Context, point string) error {
			s.calls = append(s.calls, "restore:"+point)
			return s.restoreErr
		},
	}
}

func code(t *testing.T, err error) string {
	t.Helper()
	var typed *diag.Diag
	if !errors.As(err, &typed) {
		t.Fatalf("not a launcher error: %v", err)
	}
	if typed.Hint == "" {
		t.Fatalf("diagnostic has no catalog hint: %#v", typed)
	}
	return typed.Code
}

func TestRunStopsSwapsAndRestartsARunningHost(t *testing.T) {
	host, recorded := &fakeHost{running: true}, &steps{}
	outcome, err := Run(context.Background(), host, recorded.operation("update"))
	if err != nil {
		t.Fatal(err)
	}
	if !outcome.WasRunning || outcome.RecoveryPoint != "snap-1" {
		t.Fatalf("outcome = %#v", outcome)
	}
	if want := []string{"halt", "resume"}; !reflect.DeepEqual(host.calls, want) {
		t.Fatalf("host calls = %v, want %v", host.calls, want)
	}
	if !reflect.DeepEqual(recorded.calls, []string{"change"}) {
		t.Fatalf("steps = %v", recorded.calls)
	}
}

func TestRunDoesNotStartAHostThatWasStopped(t *testing.T) {
	host, recorded := &fakeHost{}, &steps{}
	outcome, err := Run(context.Background(), host, recorded.operation("update"))
	if err != nil || outcome.WasRunning {
		t.Fatalf("outcome = %#v, err = %v", outcome, err)
	}
	if !reflect.DeepEqual(host.calls, []string{"halt"}) {
		t.Fatalf("a stopped host must stay stopped: %v", host.calls)
	}
}

func TestRunKeepsTheHostStoppedWhenAsked(t *testing.T) {
	host, recorded := &fakeHost{running: true}, &steps{}
	operation := recorded.operation("uninstall")
	operation.KeepStopped = true
	if _, err := Run(context.Background(), host, operation); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(host.calls, []string{"halt"}) {
		t.Fatalf("host calls = %v", host.calls)
	}
}

func TestRunReportsAFailedStopWithoutChangingAnything(t *testing.T) {
	stopFailure := contracts.NewDiag("KB_HOST_STOP_FAILED", "The host process 42 did not stop.", "Run \"kb-create stop\" again.", nil)
	host, recorded := &fakeHost{running: true, haltErr: stopFailure}, &steps{}
	_, err := Run(context.Background(), host, recorded.operation("update"))
	if code(t, err) != "KB_HOST_STOP_FAILED" {
		t.Fatalf("err = %v", err)
	}
	if len(recorded.calls) != 0 {
		t.Fatalf("nothing may change when the host cannot be stopped: %v", recorded.calls)
	}
}

func TestRunKeepsRestartFailureInCauseWithoutUndeclaredDetails(t *testing.T) {
	changeErr := errors.New("repair failed")
	restartErr := errors.New("required input is unavailable")
	host := &fakeHost{running: true, resumeErrs: []error{restartErr}}
	recorded := &steps{changeErr: changeErr}
	_, err := Run(context.Background(), host, recorded.operation("repair"))
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeUpdateApplyFailed {
		t.Fatalf("failure = %v", err)
	}
	failure.Meta["diagnosticPath"] = "/tmp/diagnostic.json"
	failure.Meta["logPath"] = "/tmp/operation.log"
	if _, err := json.Marshal(failure); err != nil {
		t.Fatalf("catalogued failure could not be serialized after restart failure: %v", err)
	}
	if failure.Meta["hostRestart"] != nil || !strings.Contains(failure.Cause, restartErr.Error()) {
		t.Fatalf("failure omitted the restart cause or added an undeclared detail: %#v", failure)
	}
}

func TestRunCanKeepHostStoppedWhenChangeRevealsRequiredInput(t *testing.T) {
	host := &fakeHost{running: true}
	operation := (&steps{}).operation("repair")
	operation.KeepStoppedIf = func() bool { return true }
	outcome, err := Run(context.Background(), host, operation)
	if err != nil || !outcome.WasRunning {
		t.Fatalf("repair outcome = %#v, %v", outcome, err)
	}
	if !reflect.DeepEqual(host.calls, []string{"halt"}) {
		t.Fatalf("required-input repair restarted a host that must stay stopped: %v", host.calls)
	}
}

func TestRunRestartsThePreviousHostWhenTheChangeFails(t *testing.T) {
	host, recorded := &fakeHost{running: true}, &steps{changeErr: errors.New("registry unavailable")}
	outcome, err := Run(context.Background(), host, recorded.operation("update"))
	if code(t, err) != contracts.CodeUpdateApplyFailed {
		t.Fatalf("err = %v", err)
	}
	var typed *diag.Diag
	errors.As(err, &typed)
	if !strings.Contains(typed.Message, "previous version 1.0.0 was restored") || typed.Unwrap() == nil {
		t.Fatalf("message/cause = %q / %q", typed.Message, typed.Reason)
	}
	if outcome.RecoveryPoint != "snap-1" {
		t.Fatalf("outcome = %#v", outcome)
	}
	if want := []string{"halt", "resume"}; !reflect.DeepEqual(host.calls, want) {
		t.Fatalf("the previous host must be brought back: %v", host.calls)
	}
	if !reflect.DeepEqual(recorded.calls, []string{"change"}) {
		t.Fatalf("Change restores itself; Run must not restore again: %v", recorded.calls)
	}
}

func TestRunRollsBackWhenTheNewHostDoesNotStart(t *testing.T) {
	host := &fakeHost{running: true, resumeErrs: []error{errors.New("port 4000 in use")}}
	recorded := &steps{}
	_, err := Run(context.Background(), host, recorded.operation("update"))
	if code(t, err) != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("err = %v", err)
	}
	if want := []string{"halt", "resume", "resume"}; !reflect.DeepEqual(host.calls, want) {
		t.Fatalf("host calls = %v, want %v", host.calls, want)
	}
	if want := []string{"change", "restore:snap-1"}; !reflect.DeepEqual(recorded.calls, want) {
		t.Fatalf("steps = %v, want %v", recorded.calls, want)
	}
	var typed *diag.Diag
	errors.As(err, &typed)
	if !strings.Contains(typed.Message, "previous version 1.0.0 was restored") || typed.Unwrap() == nil || typed.Meta["snapshot"] != "snap-1" {
		t.Fatalf("error = %#v", typed)
	}
}

func TestRunReportsRollbackFailureWhenTheRestoreFails(t *testing.T) {
	host := &fakeHost{running: true, resumeErrs: []error{errors.New("crash on boot")}}
	recorded := &steps{restoreErr: errors.New("pnpm failed")}
	_, err := Run(context.Background(), host, recorded.operation("update"))
	if code(t, err) != contracts.CodeRollbackFailed {
		t.Fatalf("err = %v", err)
	}
	var typed *diag.Diag
	errors.As(err, &typed)
	if typed.Meta["snapshot"] != "snap-1" || typed.Unwrap() == nil {
		t.Fatalf("error = %#v", typed)
	}
}

func TestRunReportsRollbackFailureWhenThePreviousVersionDoesNotStartEither(t *testing.T) {
	host := &fakeHost{running: true, resumeErrs: []error{errors.New("new fails"), errors.New("old fails")}}
	_, err := Run(context.Background(), host, (&steps{}).operation("update"))
	if code(t, err) != contracts.CodeRollbackFailed {
		t.Fatalf("err = %v", err)
	}
}

func TestChangeLearnsWhetherTheHostWasRunning(t *testing.T) {
	for _, running := range []bool{true, false} {
		var seen *bool
		operation := (&steps{}).operation("update")
		operation.Change = func(_ context.Context, wasRunning bool) (string, error) {
			seen = &wasRunning
			return "snap", nil
		}
		if _, err := Run(context.Background(), &fakeHost{running: running}, operation); err != nil {
			t.Fatal(err)
		}
		if seen == nil || *seen != running {
			t.Fatalf("Change saw %v, host running = %v", seen, running)
		}
	}
}

// An interrupt that ends the operation must not stop the undo: the restore and
// the restart of the previous version run on a context that is not cancelled.
func TestRecoveryIsNotCancelledByTheInterruptThatStoppedTheOperation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	host := &fakeHost{running: true, resumeErrs: []error{errors.New("interrupted while starting")}}
	var restoreCtxErr, resumeCtxErr error
	operation := (&steps{}).operation("update")
	operation.Restore = func(restoreCtx context.Context, _ string) error {
		restoreCtxErr = restoreCtx.Err()
		return nil
	}
	guarded := &contextHost{fakeHost: host, onResume: func(resumeCtx context.Context) { resumeCtxErr = resumeCtx.Err() }, cancelOnFirst: cancel}
	if _, err := Run(ctx, guarded, operation); code(t, err) != contracts.CodeUpdateHostNotHealthy {
		t.Fatalf("err = %v", err)
	}
	if restoreCtxErr != nil || resumeCtxErr != nil {
		t.Fatalf("recovery ran on a cancelled context: restore %v, resume %v", restoreCtxErr, resumeCtxErr)
	}
}

// contextHost cancels the operation's context during the first Resume, as an
// interrupt would, and reports the context each later Resume received.
type contextHost struct {
	*fakeHost
	onResume      func(context.Context)
	cancelOnFirst context.CancelFunc
	resumes       int
}

func (h *contextHost) Resume(ctx context.Context) error {
	h.resumes++
	if h.resumes == 1 {
		h.cancelOnFirst()
	} else {
		h.onResume(ctx)
	}
	return h.fakeHost.Resume(ctx)
}
