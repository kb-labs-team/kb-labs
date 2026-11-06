//go:build darwin || linux

package proc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveProgressDoesNotRewriteUnchangedRecord(t *testing.T) {
	state := t.TempDir()
	rec := record{
		RunID: "idle-progress", Tag: "idle-progress", PID: os.Getpid(),
		StartedAt: "test", StateDir: state, Status: StatusRunning,
		StallMS:  time.Hour.Milliseconds(),
		Observed: []Process{{PID: os.Getpid(), Identity: "test"}},
	}
	lastOutput := time.Now().Add(-time.Second).UTC()
	rec.LastOutputAt = lastOutput
	if err := writeRecordAtomic(rec); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(state, "runs", rec.RunID+".json")
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveProgress(rec, lastOutput.UnixNano()); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("unchanged progress record was rewritten: before=%s after=%s", before.ModTime(), after.ModTime())
	}
}

// case: S-237.70
func TestStallClockAdvancesAcrossGovernorPause(t *testing.T) {
	lastOutput := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	pausedAt := lastOutput.Add(2 * time.Second)
	resumedAt := pausedAt.Add(30 * time.Second)
	got := time.Unix(0, outputTimeAfterPause(lastOutput.UnixNano(), pausedAt, resumedAt))
	if want := lastOutput.Add(30 * time.Second); !got.Equal(want) {
		t.Fatalf("stall clock after pause = %s, want %s", got, want)
	}
}
