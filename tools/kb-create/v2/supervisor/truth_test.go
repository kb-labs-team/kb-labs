package supervisor

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/host"
)

func TestRestartBudgetAllowsThreeRestartsPerWindowAndSlides(t *testing.T) {
	start := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	var restarts []time.Time
	for death := 0; death < MaxRestarts; death++ {
		var exhausted bool
		restarts, exhausted = spendRestart(restarts, start.Add(time.Duration(death)*time.Minute))
		if exhausted {
			t.Fatalf("death %d exhausted the budget", death+1)
		}
	}
	// The fourth death inside the window exhausts it and spends nothing more.
	kept, exhausted := spendRestart(restarts, start.Add(5*time.Minute))
	if !exhausted || len(kept) != MaxRestarts {
		t.Fatalf("fourth death inside the window: exhausted=%v kept=%d", exhausted, len(kept))
	}
	// Once the window slides past the oldest restart, a death is restarted again.
	kept, exhausted = spendRestart(restarts, start.Add(RestartWindow+30*time.Second))
	if exhausted || len(kept) != MaxRestarts {
		t.Fatalf("death after the window slid: exhausted=%v kept=%d", exhausted, len(kept))
	}
}

func TestExitRecordWriteFailureIsReportedAndDoesNotStopTheSupervisor(t *testing.T) {
	dir := t.TempDir()
	// The state "directory" is a file, so the record cannot be written.
	blocker := filepath.Join(dir, "state")
	if err := writeFile(blocker); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	s := &Supervisor{State: host.State{Dir: blocker}, Log: &log}
	s.writeExit()
	if !strings.Contains(log.String(), s.State.HostExit()) || !strings.Contains(log.String(), "cannot write host exit record") {
		t.Fatalf("write failure not reported with the path: %q", log.String())
	}
}

func writeFile(path string) error { return os.WriteFile(path, []byte("x"), 0o600) }
