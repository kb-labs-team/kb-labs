//go:build darwin || linux

package proc

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/kb-runner/internal/testdeadline"
)

// case: S-237.138
func TestStartupCancellationWinsWhenReadyAndCancelArePending(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan readyResult, 1)
	ready <- readyResult{record: record{StartedAt: "ready"}}
	keeperExited := make(chan struct{})
	gate := make(chan struct{})
	outcome := make(chan startupOutcome, 1)
	go func() {
		<-gate
		outcome <- selectStartupOutcome(ctx, ready, keeperExited)
	}()

	// Both outcomes are available before the startup select is allowed to run.
	cancel()
	close(gate)
	if got := <-outcome; got.kind != startupCanceled {
		t.Fatalf("startup outcome = %+v, want cancellation", got)
	}
}

// case: S-237.138
func TestResolveReadyAfterKeeperExitDoesNotWaitForRetainedWriter(t *testing.T) {
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = readReady.Close() })
	if _, err := writeReady.Write([]byte(`{"record":`)); err != nil {
		t.Fatalf("write partial handshake: %v", err)
	}
	readerDone := make(chan struct{})
	results := make(chan readyResult, 1)
	go func() {
		defer close(readerDone)
		record, readErr := decodeReady(readReady)
		results <- readyResult{record: record, err: readErr}
	}()
	type resolvedResult struct {
		ready readyResult
		err   error
	}
	resolved := make(chan resolvedResult, 1)
	go func() {
		ready, closeErr := resolveReadyAfterKeeperExit(readReady, results, readerDone)
		resolved <- resolvedResult{ready: ready, err: closeErr}
	}()
	timer := time.NewTimer(testdeadline.Budget(t))
	defer timer.Stop()
	var got resolvedResult
	select {
	case got = <-resolved:
	case <-timer.C:
		_ = writeReady.Close()
		got = <-resolved
		t.Fatalf("reader waited for retained writer instead of expiring: %v", got.err)
	}
	result, closeErr := got.ready, got.err
	if closeErr != nil {
		t.Fatalf("close readiness reader after retained-writer resolution: %v", closeErr)
	}
	if result.err == nil {
		t.Fatal("partial handshake was accepted")
	}
	if err := writeReady.Close(); err != nil {
		t.Fatalf("close deliberately retained readiness writer: %v", err)
	}
}

// case: S-237.138
func TestResolveReadyAfterKeeperExitJoinsGatedReader(t *testing.T) {
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = readReady.Close() })

	command := exec.Command("/bin/sh", "-c", `printf '%s\n' '{"record":{"started_at":"handshake-before-exit"}}' >&3`)
	command.ExtraFiles = []*os.File{writeReady}
	if err := command.Start(); err != nil {
		t.Fatalf("start handshake writer: %v", err)
	}
	if err := writeReady.Close(); err != nil {
		t.Fatalf("close parent readiness writer: %v", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("wait for handshake writer to exit: %v", err)
	}

	readerGate := make(chan struct{})
	readerDone := make(chan struct{})
	readyResults := make(chan readyResult, 1)
	go func() {
		defer close(readerDone)
		<-readerGate
		record, readErr := decodeReady(readReady)
		readyResults <- readyResult{record: record, err: readErr}
	}()

	resolved := make(chan readyResult, 1)
	go func() {
		result, _ := resolveReadyAfterKeeperExit(readReady, readyResults, readerDone)
		resolved <- result
	}()
	// The helper's Wait has completed and the complete JSON handshake is
	// buffered before the test permits the readiness reader to begin.
	close(readerGate)
	result := <-resolved
	<-readerDone
	if result.err != nil {
		t.Fatalf("resolve handshake written before process exit: %v", result.err)
	}
	if result.record.StartedAt != "handshake-before-exit" {
		t.Fatalf("resolved start identity = %q, want handshake-before-exit", result.record.StartedAt)
	}
}

// case: S-237.138
func TestKeeperExitBeforeHandshakePreservesExitStatus(t *testing.T) {
	readReady, writeReady, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = readReady.Close() })

	command := exec.Command("/bin/sh", "-c", `printf '%s' '{"record":' >&3; exit 23`)
	command.ExtraFiles = []*os.File{writeReady}
	if err := command.Start(); err != nil {
		t.Fatalf("start early-exit handshake writer: %v", err)
	}
	wait := startProcessWait(command)
	if err := writeReady.Close(); err != nil {
		t.Fatalf("close parent readiness writer: %v", err)
	}
	<-wait.done

	readerDone := make(chan struct{})
	results := make(chan readyResult, 1)
	go func() {
		defer close(readerDone)
		record, readErr := decodeReady(readReady)
		results <- readyResult{record: record, err: readErr}
	}()
	result, closeErr := resolveReadyAfterKeeperExit(readReady, results, readerDone)
	if closeErr != nil {
		t.Fatalf("close readiness reader after joined decode: %v", closeErr)
	}
	exitErr := keeperExitError(wait, result.err)
	if exitErr.Status != "exit status 23" {
		t.Fatalf("keeper exit status = %q, want exit status 23", exitErr.Status)
	}
	if !strings.Contains(exitErr.Error(), "unexpected EOF") {
		t.Fatalf("keeper exit error = %q, want partial-handshake read error", exitErr.Error())
	}
}
