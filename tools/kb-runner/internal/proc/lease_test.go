//go:build darwin || linux

package proc

import (
	"errors"
	"testing"
)

func TestCostKeyLeaseExclusiveTryIsBlockedBySharedRun(t *testing.T) {
	state := t.TempDir()
	shared, acquired, err := AcquireFileLease(CostKeyLeasePath(state, "go-test"), LeaseShared)
	if err != nil || !acquired {
		t.Fatalf("acquire shared go-test slot: acquired=%t err=%v", acquired, err)
	}
	defer func() {
		if err := shared.Close(); err != nil {
			t.Errorf("close shared go-test slot: %v", err)
		}
	}()
	leases, err := acquireConfigLeases(Config{StateDir: state, CostKey: "go-test", CostKeyLeaseMode: LeaseExclusiveTry})
	if !errors.Is(err, ErrLeaseBusy) || len(leases) != 0 {
		t.Fatalf("cache maintenance crossed shared go-test slot: leases=%v err=%v", leases, err)
	}
}
