package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/kb-labs/create/v2/host"
)

// HostKind is the one answer to "is the host running": the combination of the
// supervisor process, the host child and the child's health.
type HostKind string

const (
	// KindStopped: no supervisor and no host child.
	KindStopped HostKind = "stopped"
	// KindRunning: a host child answers its health check.
	KindRunning HostKind = "running"
	// KindUnhealthy: a host child is alive but does not answer.
	KindUnhealthy HostKind = "unhealthy"
	// KindHostExited: the supervisor is alive and its host child is dead.
	KindHostExited HostKind = "host-exited"
)

// ExitRecord is what the supervisor knows about the death of its host child.
// The supervisor is its only writer; every command reads it through Observe.
//
// The supervisor rewrites it on every host start (Died=false, ChildPID=the new
// child) and on every death (Died=true), so the file always describes the
// latest child. Observe attaches it only when it records that child's death.
type ExitRecord struct {
	ChildPID     int         `json:"childPid"`
	Died         bool        `json:"died"`
	At           time.Time   `json:"at"`
	Cause        string      `json:"cause"`
	Restarts     []time.Time `json:"restarts,omitempty"`
	RestartsUsed int         `json:"restartsUsed"`
	Exhausted    bool        `json:"exhausted"`
}

// Truth is the typed host state. start, status, doctor and stop read it
// instead of combining the host pid file and the supervisor record themselves.
type Truth struct {
	Kind       HostKind
	Status     host.Status
	Supervisor *Record
	// Exit is set only for KindHostExited, and is nil until the supervisor has
	// recorded the death of the current host child.
	Exit *ExitRecord
}

// Observe computes the host state for one installation.
func Observe(ctx context.Context, runner *host.ProcessRunner, state host.State) (Truth, error) {
	status, err := runner.Status(ctx)
	if err != nil {
		return Truth{}, err
	}
	truth := Truth{Status: status}
	if pid, alive := LivePID(state, runner.InstallRoot); alive {
		if record, ok := ReadRecord(state); ok && record.PID == pid {
			truth.Supervisor = &record
		}
	}
	switch status.State {
	case host.StateRunning:
		truth.Kind = KindRunning
	case host.StateUnhealthy:
		truth.Kind = KindUnhealthy
	default:
		truth.Kind = KindStopped
		if truth.Supervisor != nil {
			truth.Kind = KindHostExited
			if exit, ok := ReadExit(state); ok && exit.Died {
				truth.Exit = &exit
			}
		}
	}
	return truth, nil
}

// ReadExit reads the supervisor's host-exit record.
func ReadExit(state host.State) (ExitRecord, bool) {
	data, err := os.ReadFile(state.HostExit())
	if err != nil {
		return ExitRecord{}, false
	}
	var record ExitRecord
	if json.Unmarshal(data, &record) != nil {
		return ExitRecord{}, false
	}
	return record, true
}

func writeExit(state host.State, record ExitRecord) error {
	record.RestartsUsed = len(record.Restarts)
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return host.WriteRecordFile(state.HostExit(), append(data, '\n'))
}

// spendRestart applies the restart budget: restarts older than RestartWindow
// no longer count; the budget is exhausted when MaxRestarts remain in the window.
func spendRestart(previous []time.Time, now time.Time) (kept []time.Time, exhausted bool) {
	for _, at := range previous {
		if now.Sub(at) < RestartWindow {
			kept = append(kept, at)
		}
	}
	if len(kept) >= MaxRestarts {
		return kept, true
	}
	return append(kept, now), false
}
