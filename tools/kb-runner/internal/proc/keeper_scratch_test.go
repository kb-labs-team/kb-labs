//go:build darwin || linux

package proc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestKeeperScratchIsRemovedWhenInitialRecordWriteFails(t *testing.T) {
	state := t.TempDir()
	runID, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	queued := record{RunID: runID, Tag: "record-failure", StateDir: state, Status: StatusQueued}
	if err := writeRecordAtomic(queued); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(state, "runs", runID+".json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	scratch, err := runScratchPath(runID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(scratch); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(scratch); err != nil {
			t.Errorf("remove test scratch %s: %v", scratch, err)
		}
	})

	identity, ok, identityErr := ProcessIdentity(os.Getpid())
	if identityErr != nil {
		t.Fatal(identityErr)
	}
	if !ok {
		t.Fatal("cannot determine test process identity")
	}
	cfg := keeperConfig{
		Config: Config{
			StateDir:   state,
			Tag:        "record-failure",
			Stall:      time.Hour,
			StdoutPath: filepath.Join(state, "stdout.log"),
			StderrPath: filepath.Join(state, "stderr.log"),
			Command:    []string{"/bin/true"},
		},
		RunID:          runID,
		ParentPID:      os.Getpid(),
		ParentIdentity: identity,
	}
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	status := runKeeperWithReady(cfg, writeReady)
	var ready readyMessage
	decodeErr := json.NewDecoder(readReady).Decode(&ready)
	closeErr := readReady.Close()
	if decodeErr != nil {
		t.Fatalf("read keeper startup result: %v", decodeErr)
	}
	if ready.Error == "" {
		t.Fatal("keeper unexpectedly accepted obstructed initial record path")
	}
	if !strings.Contains(ready.Error, filepath.Join(state, "runs", runID+".json.tmp")) {
		t.Fatalf("keeper failed before the obstructed initial record write: %s", ready.Error)
	}
	if status == 0 {
		t.Fatalf("keeper returned success after record failure: %s", ready.Error)
	}
	if closeErr != nil {
		t.Errorf("close keeper readiness reader: %v", closeErr)
	}
	if _, err := os.Lstat(scratch); !os.IsNotExist(err) {
		t.Fatalf("scratch remains without a durable run record at %s: %v", scratch, err)
	}
}
