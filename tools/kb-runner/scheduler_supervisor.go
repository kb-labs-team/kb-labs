//go:build darwin || linux

package main

import (
	"context"
	"os"

	"github.com/kb-labs/kb-runner/internal/proc"
)

// schedulerJobSupervisor is the scheduler's only process-supervision boundary.
// Scheduler logic consumes identity, liveness, terminal records, and output
// without depending on how the job process is launched.
type schedulerJobSupervisor interface {
	Start(context.Context, proc.Config) (schedulerJobRun, error)
	List(state string) proc.Listing
	RunByID(state, runID string) (proc.RunInfo, bool, error)
	WaitTag(context.Context, string, string) (proc.RunInfo, error)
	RunOwnsProcess(state, runID string, pid int, identity string) (bool, error)
	RunTagActive(state, tag string) (bool, error)
	ReadOutput(path string) ([]byte, error)
}

type schedulerJobRun interface {
	Wait() error
}

type clikitSchedulerSupervisor struct{}

func (supervisor clikitSchedulerSupervisor) Start(ctx context.Context, config proc.Config) (schedulerJobRun, error) {
	return proc.Start(ctx, config)
}

func (clikitSchedulerSupervisor) RunByID(state, runID string) (proc.RunInfo, bool, error) {
	listing := clikitSchedulerSupervisor{}.List(state)
	if listing.Error != nil {
		return proc.RunInfo{}, false, schedulerRunUnknownError{RunID: runID, Cause: listing.Error}
	}
	for _, run := range listing.Runs {
		if run.RunID == runID {
			return run, true, nil
		}
	}
	return proc.RunInfo{}, false, nil
}

func (clikitSchedulerSupervisor) List(state string) proc.Listing {
	return proc.List(state)
}

func (clikitSchedulerSupervisor) WaitTag(ctx context.Context, state, tag string) (proc.RunInfo, error) {
	return proc.WaitTag(ctx, state, tag)
}

func (clikitSchedulerSupervisor) RunOwnsProcess(state, runID string, pid int, identity string) (bool, error) {
	return proc.RunOwnsProcess(state, runID, pid, identity)
}

func (clikitSchedulerSupervisor) RunTagActive(state, tag string) (bool, error) {
	return proc.RunTagActive(state, tag)
}

func (clikitSchedulerSupervisor) ReadOutput(path string) ([]byte, error) {
	return os.ReadFile(path)
}
