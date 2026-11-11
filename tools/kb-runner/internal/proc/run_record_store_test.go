package proc_test

import (
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

func TestRunRecordStoreRoundTripsProductionFormat(t *testing.T) {
	state := t.TempDir()
	started := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	code := 0
	want := proc.RunInfo{
		RunID: "scheduler-run-identity", Tag: "scheduler-run-identity", PID: 4321,
		StartedAt: &started, Identity: "pid:4321:start:identity", Status: proc.StatusCompleted,
		Command: []string{"fake-reviewer", "--task", "review-1"}, ExitCode: &code,
		SlotGroup: "agent-scheduler", CostKey: "review", CostClass: proc.CostLight,
	}
	if err := proc.WriteRunRecord(state, want); err != nil {
		t.Fatalf("write production run record: %v", err)
	}
	got, err := proc.ReadRunRecord(state, want.RunID)
	if err != nil {
		t.Fatalf("read production run record: %v", err)
	}
	if got.RunID != want.RunID || got.Tag != want.Tag || got.Status != want.Status || got.Identity != want.Identity || got.ExitCode == nil || *got.ExitCode != code || len(got.Command) != len(want.Command) || got.Command[0] != want.Command[0] || got.Command[1] != want.Command[1] {
		t.Fatalf("run record = %+v, want persisted production fields from %+v", got, want)
	}
}
