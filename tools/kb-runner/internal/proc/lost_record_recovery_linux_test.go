//go:build linux

package proc

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// case: S-237.69
func TestLostKeeperRecoveryUsesStartRecordWhenRunFileWasRemoved(t *testing.T) {
	state := t.TempDir()
	rec := record{
		RunID: "lost-record-fallback", Tag: "lost-record-fallback", StateDir: state,
		PID: 2147483647, StartedAt: "gone", StartedAtTime: time.Now().UTC(), Status: StatusRunning,
	}
	if err := recordObservedKeeperLoss(state, rec.RunID, rec); err != nil {
		t.Fatalf("recover lost run from Start record after run-file removal: %v", err)
	}
	data, err := os.ReadFile(recordLocation(state, rec.RunID).path(StatusLost))
	if err != nil {
		t.Fatalf("read recovered lost run record: %v", err)
	}
	var recovered record
	if err := json.Unmarshal(data, &recovered); err != nil {
		t.Fatalf("decode recovered run record: %v", err)
	}
	if recovered.Status != StatusLost {
		t.Fatalf("recovered status=%q, want %q", recovered.Status, StatusLost)
	}
}
