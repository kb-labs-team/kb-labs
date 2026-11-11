//go:build darwin || linux

package proc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// case: S-237.73, S-237.3
func TestExitStatusAndPSStartedAtContract(t *testing.T) {
	zero, seven := 0, 7
	if got := exitStatus(&zero, "", ""); got != StatusCompleted {
		t.Fatalf("zero exit status = %q, want %q", got, StatusCompleted)
	}
	if got := exitStatus(&seven, "", ""); got != StatusFailed {
		t.Fatalf("nonzero exit status = %q, want %q", got, StatusFailed)
	}
	if got := exitStatus(nil, "15", ""); got != StatusDead {
		t.Fatalf("signaled exit status = %q, want %q", got, StatusDead)
	}
	started := time.Date(2026, time.October, 25, 12, 34, 56, 123456789, time.FixedZone("offset", 3*60*60))
	run := runInfoFromRecord(&record{StartedAtTime: started, StartedAt: "process-start-identity", Status: StatusCompleted})
	encoded, err := json.Marshal(run)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	var timestamp string
	if err := json.Unmarshal(decoded["started_at"], &timestamp); err != nil {
		t.Fatalf("started_at is not a JSON string: %s", encoded)
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil || !parsed.Equal(started) || !strings.HasSuffix(timestamp, "Z") {
		t.Fatalf("started_at = %q, parsed=%v err=%v; want RFC3339Nano UTC", timestamp, parsed, err)
	}
	var identity string
	if err := json.Unmarshal(decoded["identity"], &identity); err != nil || identity != "process-start-identity" {
		t.Fatalf("identity = %q, err=%v; want process identity", identity, err)
	}
}

// case: S-237.73
func TestActivityWriterTeesOutputToFileAndTerminal(t *testing.T) {
	dir := t.TempDir()
	file, err := os.Create(filepath.Join(dir, "child.out"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	terminal, err := os.Create(filepath.Join(dir, "terminal.out"))
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	var activity atomic.Int64
	writer := activityWriter{file: file, terminal: terminal, activity: &activity}
	if n, err := writer.Write([]byte("ok\n")); err != nil || n != 3 {
		t.Fatalf("tee write = %d, %v", n, err)
	}
	for _, output := range []*os.File{file, terminal} {
		if _, err := output.Seek(0, 0); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, 3)
		if n, err := output.Read(data); err != nil || n != len(data) || string(data) != "ok\n" {
			t.Fatalf("tee output = %q, %v; want both destinations to contain child output", data[:n], err)
		}
	}
}

// case: S-237.73
func TestCompletedRecordAndExitEventShareOutcomeStatus(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	code := 0
	started := time.Now().UTC()
	rec := record{RunID: "completed", StateDir: state, StartedAtTime: started, Status: StatusRunning}
	if err := writeRecordAtomic(rec); err != nil {
		t.Fatal(err)
	}
	if err := completeRecord(state, rec.RunID, &code, "", time.Millisecond, rec); err != nil {
		t.Fatal(err)
	}
	stored, err := readRecordLocked(state, rec.RunID)
	if err != nil || stored.Status != StatusCompleted {
		t.Fatalf("completed record status = %q, err=%v", stored.Status, err)
	}
	exit := eventFor(stored, EventExit)
	if exit.Status != stored.Status {
		t.Fatalf("exit event status = %q, record status = %q", exit.Status, stored.Status)
	}
}
