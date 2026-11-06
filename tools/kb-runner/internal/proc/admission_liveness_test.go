//go:build darwin || linux

package proc_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/kb-labs/kb-runner/internal/testdeadline"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/proc"
)

// case: S-237.55
func TestIdleQueueEventComesFromProductionAdmissionPath(t *testing.T) {
	state := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_, err := proc.StartWithHostResourceSource(ctx, proc.Config{StateDir: state, Tag: "agent:queued-idle", Stall: time.Hour,
			StdoutPath: filepath.Join(state, "out"), StderrPath: filepath.Join(state, "err"),
			MinFree: math.MaxUint64, Command: []string{"/bin/sleep", "30"},
		}, stableHostResourceSource{})
		done <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(testdeadline.Budget(t)):
			t.Errorf("production admission did not return after cancellation")
		}
	})

	var recordPath string
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		paths, err := filepath.Glob(filepath.Join(state, "runs", "*.json"))
		if err != nil {
			t.Fatal(err)
		}
		if len(paths) == 1 {
			recordPath = paths[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if recordPath == "" {
		t.Fatal("production admission did not persist its queued run record")
	}

	var queued map[string]json.RawMessage
	blockedDeadline := time.NewTimer(5 * time.Second)
	blockedPoll := time.NewTicker(10 * time.Millisecond)
	defer blockedDeadline.Stop()
	defer blockedPoll.Stop()
	for {
		data, err := os.ReadFile(recordPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &queued); err != nil {
			t.Fatal(err)
		}
		var status string
		if err := json.Unmarshal(queued["status"], &status); err != nil {
			t.Fatal(err)
		}
		if status == string(proc.StatusBlocked) {
			break
		}
		select {
		case startErr := <-done:
			t.Fatalf("production admission returned before blocked state: %v", startErr)
		case <-blockedDeadline.C:
			t.Fatalf("production admission did not transition from queued to blocked; last status=%q", status)
		case <-blockedPoll.C:
		}
	}

	// The real admission path creates this record; advancing its persisted enqueue
	// time models the ten-minute clock boundary without a test hook in production.
	enqueuedAt, err := json.Marshal(time.Now().UTC().Add(-11 * time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	queued["enqueued_at"] = enqueuedAt
	updated, err := json.Marshal(queued)
	if err != nil {
		t.Fatal(err)
	}
	temporary := recordPath + ".fixture"
	if err := os.WriteFile(temporary, updated, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, recordPath); err != nil {
		t.Fatal(err)
	}

	events := readAdmissionEvents(t, state)
	var idle *proc.Event
	deadline = time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		for index := range events {
			if events[index].Type == proc.EventIdle {
				idle = &events[index]
				break
			}
		}
		if idle != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
		events = readAdmissionEvents(t, state)
	}
	if idle == nil || idle.Reason != "no active runs while work remains queued" || len(idle.WaitingItems) != 1 || idle.WaitingItems[0] != "agent:queued-idle" {
		t.Fatalf("production idle event = %#v; events=%#v", idle, events)
	}
	cancel()
	if err := <-done; err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled production admission error = %v, want context cancellation", err)
	}
}

// case: S-237.56
func TestCancellingProductionQueuedAdmissionWritesTerminalTeardown(t *testing.T) {
	state := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_, err := proc.StartWithHostResourceSource(ctx, proc.Config{StateDir: state, Tag: "agent:queued-cancel", Stall: time.Hour,
			StdoutPath: filepath.Join(state, "out"), StderrPath: filepath.Join(state, "err"),
			MinFree: math.MaxUint64, Command: []string{"/bin/sleep", "30"},
		}, stableHostResourceSource{})
		done <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(testdeadline.Budget(t)):
			t.Errorf("production admission did not return after cancellation")
		}
	})

	var queued bool
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		for _, event := range readAdmissionEvents(t, state) {
			if event.Type == proc.EventBlocked && event.Tag == "agent:queued-cancel" {
				queued = true
			}
		}
		if queued {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !queued {
		cancel()
		<-done
		t.Fatal("production admission did not emit blocked event before cancellation")
	}
	cancel()
	err := <-done
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled production admission error = %v, want context cancellation", err)
	}
	events := readAdmissionEvents(t, state)
	var blocked, teardown, started bool
	for _, event := range events {
		if event.Tag != "agent:queued-cancel" {
			continue
		}
		blocked = blocked || event.Type == proc.EventBlocked
		started = started || event.Type == proc.EventStart
		teardown = teardown || (event.Type == proc.EventTeardown && event.Reason == "cancelled before start")
	}
	if !blocked || !teardown || started {
		t.Fatalf("queued cancellation events: blocked=%v teardown=%v started=%v; events=%#v", blocked, teardown, started, events)
	}
}

// case: S-237.144
func TestCancelledQueuedAdmissionReturnsTypedWaitReason(t *testing.T) {
	state := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	finished := make(chan struct{})
	const tag = "agent:typed-admission-cancel"
	go func() {
		defer close(finished)
		_, err := proc.StartWithHostResourceSource(ctx, proc.Config{StateDir: state, Tag: tag, Stall: time.Hour,
			StdoutPath: filepath.Join(state, "out"), StderrPath: filepath.Join(state, "err"),
			MinFree: math.MaxUint64, Command: []string{"/bin/sleep", "30"},
		}, stableHostResourceSource{})
		done <- err
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(testdeadline.Budget(t)):
			t.Errorf("queued admission did not return after cancellation")
		}
	})

	var eventReason string
	deadline := time.Now().Add(testdeadline.Budget(t))
	for time.Now().Before(deadline) {
		for _, event := range readAdmissionEvents(t, state) {
			if event.Tag == tag && event.Reason != "" && (event.Type == proc.EventQueued || event.Type == proc.EventBlocked) {
				eventReason = event.Reason
			}
		}
		if eventReason != "" {
			break
		}
		select {
		case startErr := <-done:
			t.Fatalf("admission returned before a queued reason was recorded: %v", startErr)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if eventReason == "" {
		t.Fatal("production admission did not record a queued decision reason")
	}
	cancel()
	err := <-done
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled admission error = %v, want context cancellation", err)
	}
	var admissionErr *proc.AdmissionCanceledError
	if !errors.As(err, &admissionErr) {
		t.Fatalf("cancelled admission error type = %T, want *proc.AdmissionCanceledError", err)
	}
	if admissionErr.WaitReason != eventReason {
		t.Fatalf("typed wait reason = %q, queued event reason = %q", admissionErr.WaitReason, eventReason)
	}
}

func readAdmissionEvents(t *testing.T, state string) []proc.Event {
	t.Helper()
	var output bytes.Buffer
	if err := proc.Events(context.Background(), state, false, nil, 0, &output); err != nil {
		t.Fatal(err)
	}
	var events []proc.Event
	if err := proc.ReadEvents(bytes.NewReader(output.Bytes()), func(event proc.Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}
