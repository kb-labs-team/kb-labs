//go:build linux

package identity_start

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
)

const helperEnv = "KB_PROCESS_IDENTITY_START_HELPER"

// TestPostStartIdentityRegression checks identity immediately after Start and
// exercises the bounded retry without waiting for child output or readiness.
// case: PC-002.1
func TestPostStartIdentityRegression(t *testing.T) {
	if os.Getenv(helperEnv) == "child" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	} else if os.Getenv(helperEnv) == "exit" {
		return
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	const starts = 2000
	testStarted := time.Now()
	failures := make([]int, 0, 8)
	failureCount := 0
	for index := 0; index < starts; index++ {
		identity, err := host.NewProcessIdentityToken()
		if err != nil {
			t.Fatal(err)
		}
		command := exec.Command(executable, "-test.run=^TestPostStartIdentityRegression$")
		command.Env = host.ProcessEnvironmentWithIdentity(append(os.Environ(), helperEnv+"=child"), identity)
		command.Stdout, command.Stderr = io.Discard, io.Discard
		if _, err := command.StdinPipe(); err != nil {
			t.Fatal(err)
		}
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		exited := make(chan struct{})
		waitErr := make(chan error, 1)
		go func() {
			waitErr <- command.Wait()
			close(exited)
		}()
		identityStatus := host.WaitForProcessIdentityWithReader(command.Process.Pid, identity, exited, time.Now().Add(time.Second), nil)
		if (index+1)%100 == 0 {
			t.Logf("progress child_index=%d children=%d/%d elapsed=%s last_identity_status=%d", index, index+1, starts, time.Since(testStarted).Round(time.Millisecond), identityStatus)
		}
		if err := command.Process.Kill(); err != nil {
			t.Fatalf("kill child %d after identity observation: %v", index, err)
		}
		if err := <-waitErr; err != nil {
			var exitError *exec.ExitError
			if !errors.As(err, &exitError) || exitError.ProcessState == nil || exitError.ProcessState.ExitCode() != -1 {
				t.Fatalf("child %d reap after termination: %v", index, err)
			}
		}
		if identityStatus != host.ProcessIdentityMatch && len(failures) < cap(failures) {
			failures = append(failures, index)
		}
		if identityStatus != host.ProcessIdentityMatch {
			failureCount++
		}
	}
	if failureCount != 0 {
		t.Fatalf("immediate post-Start process identity failed %d/%d times; sample child indexes: %v", failureCount, starts, failures)
	}
	t.Logf("post-Start process identity became verifiable for %d/%d children", starts, starts)
}

// case: PC-002.1
func TestExitedProcessIdentityIsUndetermined(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := host.NewProcessIdentityToken()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestPostStartIdentityRegression$")
	command.Env = host.ProcessEnvironmentWithIdentity(append(os.Environ(), helperEnv+"=exit"), identity)
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Run(); err != nil {
		t.Fatalf("exited child: %v", err)
	}
	if got := host.ProcessIdentityOf(command.Process.Pid, identity); got != host.ProcessIdentityUndetermined {
		t.Fatalf("exited process identity status = %v, want undetermined", got)
	}
}

// TestExecChainIdentityChecks exercises the installed launch shape: a shebang
// script enters an interpreter, then performs several exec transitions before
// the final process waits on stdin. The first observation uses the old
// immediate check; the second uses the bounded startup check.
// case: PC-002.1
func TestExecChainIdentityChecks(t *testing.T) {
	directory := t.TempDir()
	const transitions = 12
	scripts := make([]string, transitions)
	for index := range scripts {
		scripts[index] = filepath.Join(directory, fmt.Sprintf("kb-host-%02d", index))
	}
	for index, script := range scripts {
		next := "/bin/cat >/dev/null"
		if index+1 < len(scripts) {
			next = "/bin/sh " + shellQuote(scripts[index+1])
		}
		if err := os.WriteFile(script, []byte("#!/bin/sh\nexec "+next+"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	startupSpec, err := host.NewSpec(directory, contracts.HostSpec{
		Command:   scripts[0],
		HealthURL: "http://127.0.0.1:1/health",
	})
	if err != nil {
		t.Fatalf("construct default host startup budget: %v", err)
	}
	const starts = 1000
	oldUndetermined, oldMismatches, boundedFailures := 0, 0, 0
	boundedMismatches, boundedUndetermined := 0, 0
	for index := range starts {
		identity, err := host.NewProcessIdentityToken()
		if err != nil {
			t.Fatal(err)
		}
		process := exec.Command(scripts[0])
		process.Env = host.ProcessEnvironmentWithIdentity(os.Environ(), identity)
		process.Stdout, process.Stderr = io.Discard, io.Discard
		stdin, err := process.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := process.Start(); err != nil {
			t.Fatalf("start chain %d: %v", index, err)
		}
		exited := make(chan struct{})
		waitErr := make(chan error, 1)
		go func() {
			waitErr <- process.Wait()
			close(exited)
		}()
		switch got := host.ProcessIdentityOf(process.Process.Pid, identity); got {
		case host.ProcessIdentityUndetermined:
			oldUndetermined++
			if !host.ProcessAlive(process.Process.Pid) {
				t.Fatalf("chain %d was not alive after the immediate identity check returned undetermined", index)
			}
		case host.ProcessIdentityMismatch:
			oldMismatches++
		}
		got := host.WaitForProcessIdentityWithReader(process.Process.Pid, identity, exited, time.Now().Add(startupSpec.ReadyTimeout), nil)
		if got == host.ProcessIdentityMismatch {
			boundedMismatches++
		} else if got == host.ProcessIdentityUndetermined {
			boundedUndetermined++
		}
		if got != host.ProcessIdentityMatch {
			boundedFailures++
		}
		_ = stdin.Close()
		if err := <-waitErr; err != nil {
			t.Fatalf("exec chain %d exit: %v", index, err)
		}
	}
	t.Logf("launch chain: old immediate undetermined %d/%d, mismatches %d/%d; bounded check mismatches %d, undetermined %d, failures %d/%d", oldUndetermined, starts, oldMismatches, starts, boundedMismatches, boundedUndetermined, boundedFailures, starts)
	if boundedFailures != 0 {
		t.Fatalf("bounded identity verification failed %d/%d chained launches (mismatches %d, undetermined %d)", boundedFailures, starts, boundedMismatches, boundedUndetermined)
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
