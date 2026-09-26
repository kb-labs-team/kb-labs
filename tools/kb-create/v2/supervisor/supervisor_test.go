package supervisor

import (
	"context"
	"errors"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/host"
)

type stubRunner struct{ calls []string }

func (r *stubRunner) Name() string { return "stub" }
func (r *stubRunner) Start(context.Context) (host.Info, error) {
	r.calls = append(r.calls, "start")
	return host.Info{Runner: "stub"}, nil
}
func (r *stubRunner) Stop(context.Context) (host.StopResult, error) {
	r.calls = append(r.calls, "stop")
	return host.StopResult{Runner: "stub"}, nil
}
func (r *stubRunner) Status(context.Context) (host.Status, error) {
	return host.Status{Runner: "stub", State: host.StateRunning, Healthy: true}, nil
}

func TestRunPublishesControlChannelAndStopsHostOnCancel(t *testing.T) {
	state := host.State{Dir: t.TempDir()}
	runner := &stubRunner{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- (&Supervisor{Runner: runner, State: state, Version: "t"}).Run(ctx) }()

	deadline := time.Now().Add(5 * time.Second)
	var client *control.Client
	for {
		var err error
		if client, err = control.Connect(state); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("control channel never appeared: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, err := client.Status(context.Background()); err != nil || status.Host.State != host.StateRunning {
		t.Fatalf("status: %+v %v", status, err)
	}
	// A second supervisor for the same state home must refuse to start.
	err := (&Supervisor{Runner: &stubRunner{}, State: state}).Run(context.Background())
	var typed *contracts.LauncherError
	if !errors.As(err, &typed) || typed.Code != "KB_HOST_ALREADY_RUNNING" {
		t.Fatalf("second supervisor: %v", err)
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := runner.calls; len(got) != 2 || got[0] != "start" || got[1] != "stop" {
		t.Fatalf("runner calls: %v", got)
	}
	for _, path := range []string{state.Control(), state.SupervisorPID()} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s should be removed on shutdown", path)
		}
	}
}

func TestLivePIDRemovesStalePidFile(t *testing.T) {
	state := host.State{Dir: t.TempDir()}
	if err := os.WriteFile(state.SupervisorPID(), []byte(strconv.Itoa(2147483646)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, alive := LivePID(state); alive {
		t.Fatal("dead pid reported alive")
	}
	if _, err := os.Stat(state.SupervisorPID()); !os.IsNotExist(err) {
		t.Fatal("stale supervisor.pid must be removed")
	}
}
