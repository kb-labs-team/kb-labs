//go:build linux

package proc

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// case: S-237.69
func TestInProcessKeeperRestoresCallingProcessSubreaperState(t *testing.T) {
	assertNotSubreaper(t)
	state := t.TempDir()
	runID, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	identity, alive, err := ProcessIdentity(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("inspect test process identity: alive=%t err=%v", alive, err)
	}
	cfg := keeperConfig{
		Config: Config{
			StateDir: state, Tag: "subreaper-lifecycle", Stall: time.Hour,
			StdoutPath: filepath.Join(state, "stdout.log"), StderrPath: filepath.Join(state, "stderr.log"),
			Command: []string{"/bin/true"},
		},
		RunID: runID, ParentPID: os.Getpid(), ParentIdentity: identity,
	}
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	writerErr := errors.New("injected run-record write obstruction")
	status := runKeeperWithReadyAndRecordWriter(cfg, writeReady, failingRunRecordWriter{err: writerErr})
	var ready readyMessage
	if err := json.NewDecoder(readReady).Decode(&ready); err != nil {
		t.Fatalf("read keeper readiness: %v", err)
	}
	if err := readReady.Close(); err != nil {
		t.Errorf("close readiness reader: %v", err)
	}
	if status == 0 {
		t.Fatalf("keeper status=%d, want failure at the intentional record obstruction: %+v", status, ready)
	}
	if ready.Error != writerErr.Error() {
		t.Fatalf("keeper did not stop at the typed record-writer obstruction: %+v", ready)
	}
	assertNotSubreaper(t)
}

type failingRunRecordWriter struct{ err error }

func (writer failingRunRecordWriter) Write(record) error { return writer.err }

func assertNotSubreaper(t *testing.T) {
	t.Helper()
	var enabled int32
	if err := unix.Prctl(unix.PR_GET_CHILD_SUBREAPER, uintptr(unsafe.Pointer(&enabled)), 0, 0, 0); err != nil {
		t.Fatalf("inspect process child-subreaper state: %v", err)
	}
	if enabled != 0 {
		t.Fatal("keeper lifecycle left its caller as a child subreaper")
	}
}
