package processsignal

import (
	"errors"
	"syscall"
	"testing"
)

type fakePIDFDSignalOps struct {
	identity string
	alive    bool
	openErr  error
	signals  []syscall.Signal
}

func (ops *fakePIDFDSignalOps) PidfdOpen(int) (int, error) { return 7, ops.openErr }
func (ops *fakePIDFDSignalOps) Identity(int) (string, bool, error) {
	return ops.identity, ops.alive, nil
}
func (ops *fakePIDFDSignalOps) PidfdSendSignal(_ int, signal syscall.Signal) error {
	ops.signals = append(ops.signals, signal)
	return nil
}
func (*fakePIDFDSignalOps) Close(int) error { return nil }

func TestSignalProcessWithPidfdRefusesChangedIdentity(t *testing.T) {
	ops := &fakePIDFDSignalOps{identity: "replacement-start", alive: true}
	err := SignalPIDWithOps(42, "expected-start", syscall.SIGKILL, ops)
	if !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("signal result = %v, want stale process identity", err)
	}
	if len(ops.signals) != 0 {
		t.Fatalf("signals delivered to reused PID = %v", ops.signals)
	}
}

func TestSignalProcessWithPidfdFailsClosedWhenUnsupported(t *testing.T) {
	ops := &fakePIDFDSignalOps{identity: "expected-start", alive: true, openErr: syscall.ENOSYS}
	err := SignalPIDWithOps(42, "expected-start", syscall.SIGTERM, ops)
	if !errors.Is(err, ErrCannotSignalSafely) {
		t.Fatalf("pidfd-unavailable result = %v, want reported cannot signal safely error", err)
	}
	if len(ops.signals) != 0 {
		t.Fatalf("fallback delivered signal after pidfd failure: %v", ops.signals)
	}
}
