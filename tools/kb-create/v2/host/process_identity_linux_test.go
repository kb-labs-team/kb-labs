//go:build linux

package host

import (
	"errors"
	"testing"
)

func TestLinuxEnvironmentWithoutLaunchTokenIsNotVerified(t *testing.T) {
	identity, err := processIdentityFromLinuxEnvironment([]byte("PATH=/bin\x00"))
	if identity != "" {
		t.Fatalf("identity = %q, want no verified identity", identity)
	}
	if !errors.Is(err, errProcessEnvironmentNotReady) {
		t.Fatalf("error = %v, want %v", err, errProcessEnvironmentNotReady)
	}
	if status := processIdentityStatusWithReader(42, "launch-token", func(int) (string, error) {
		return processIdentityFromLinuxEnvironment([]byte("PATH=/bin\x00"))
	}, func(int) bool { return true }); status != ProcessIdentityUndetermined {
		t.Fatalf("status = %v, want undetermined until the launch token is observable", status)
	}
	signals := 0
	if signalWithIdentityReader(42, "launch-token", func(int) (string, error) {
		return processIdentityFromLinuxEnvironment([]byte("PATH=/bin\x00"))
	}, func(int) bool { return true }, func() error {
		signals++
		return nil
	}) {
		t.Fatal("process with unverified identity was signalled")
	}
	if signals != 0 {
		t.Fatalf("signals sent = %d, want 0", signals)
	}
}
