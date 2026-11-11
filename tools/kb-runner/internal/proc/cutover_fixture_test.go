//go:build darwin || linux

package proc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestWriteCutoverEventFixture lets the orchestration proof seed its temporary
// event stream through the same append owner used by real runner events.
func TestWriteCutoverEventFixture(t *testing.T) {
	stateDir := os.Getenv("X53_CUTOVER_EVENT_STATE")
	fixtureRequested := stateDir != ""
	if stateDir == "" {
		stateDir = t.TempDir()
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("create temporary event fixture state: %v", err)
	}
	now := time.Now().UTC()
	events := make([]Event, 0, 8)
	scenario := os.Getenv("X53_CUTOVER_CURSOR_SCENARIO")
	if scenario == "two-launcher-exits" {
		exitCode := 0
		events = append(events,
			Event{Schema: EventSchema, At: now, Type: EventExit, RunID: "fixture-agent-launcher", Tag: "agent:launcher:fixture-launch", ExitCode: &exitCode},
			Event{Schema: EventSchema, At: now.Add(time.Nanosecond), Type: EventExit, RunID: "fixture-resume-launcher", Tag: "resume:launcher:fixture-resume", ExitCode: &exitCode},
		)
	} else if scenario == "disk-wait" {
		events = append(events, Event{
			Schema: EventSchema, At: now, Type: EventBlocked, RunID: "fixture-disk", Tag: "setup-install:worker:disk",
			Reason: "disk budget", DiskNeedBytes: 1000, DiskFreeBytes: 500,
		})
	} else if scenario == "lag-backlog" {
		for i := 0; i < 6; i++ {
			events = append(events, Event{
				Schema: EventSchema, At: now.Add(-10*time.Second + time.Duration(i)*time.Nanosecond),
				Type: EventQueued, RunID: "fixture-lag-" + string(rune('1'+i)),
				Tag: "fixture:lag", Reason: "sustained backlog",
			})
		}
	} else if os.Getenv("X53_CUTOVER_MUTATION") == "delay-lag-translation" {
		events = append(events, Event{Schema: EventSchema, At: now, Type: EventQueued,
			RunID: "fixture-queued", Tag: "fixture:queued", Reason: "waiting"})
	}
	if scenario != "two-launcher-exits" && scenario != "disk-wait" && scenario != "lag-backlog" {
		events = append(events, Event{
			Schema: EventSchema, At: now, Type: EventStall,
			RunID: "fixture-stall", Tag: "agent:hanging:cursor-fixture", Reason: "no output",
		})
	}
	for _, event := range events {
		if err := appendEvent(stateDir, event); err != nil {
			t.Fatalf("write temporary runner event fixture: %v", err)
		}
	}
	if !fixtureRequested {
		file, err := os.Open(filepath.Join(stateDir, "events.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		count := 0
		if err := ReadEvents(file, func(event Event) error {
			count++
			if event.Type != EventStall {
				t.Errorf("default fixture event = %q, want %q", event.Type, EventStall)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("default fixture event count = %d, want one", count)
		}
	}
}
