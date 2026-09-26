package host

import (
	"context"

	"github.com/kb-labs/create/v2/services"
)

// KBDevRunner is the existing behaviour: the launcher drives the resolved
// service graph through the public kb-dev protocol. It stays the default until
// a receipt declares a host spec.
type KBDevRunner struct {
	PlatformRoot string
	ServiceIDs   []string
	Client       services.KBDev
}

func (r *KBDevRunner) Name() string { return "kb-dev" }

func (r *KBDevRunner) Start(context.Context) (Info, error) {
	if err := r.Client.Ensure(r.PlatformRoot, r.ServiceIDs); err != nil {
		return Info{}, hostError("KB_HOST_START_FAILED", "The host process failed while starting.", "Read the reason in the log and report the correlationId if it is unclear.", err, nil)
	}
	return Info{Runner: r.Name()}, nil
}

func (r *KBDevRunner) Stop(context.Context) (StopResult, error) {
	status, err := r.Status(context.Background())
	if err == nil && status.State == StateStopped {
		return StopResult{Runner: r.Name()}, nil
	}
	if err := r.Client.Stop(r.PlatformRoot, r.ServiceIDs); err != nil {
		return StopResult{}, hostError("KB_HOST_STOP_FAILED", "The host process did not stop.", "Run \"kb-create stop\" again, or end the process manually and remove the stale pid file.", err, nil)
	}
	return StopResult{Runner: r.Name(), WasRunning: true, Graceful: true}, nil
}

func (r *KBDevRunner) Status(context.Context) (Status, error) {
	observed, err := r.Client.ServiceStatuses(r.PlatformRoot)
	if err != nil {
		return Status{}, hostError("KB_HOST_UNREACHABLE", "The KB Labs host is not running: kb-dev status failed.", "Run \"kb-create start\", or \"kb-create doctor\" if the host should already be running.", err, nil)
	}
	alive := 0
	for _, service := range observed {
		if service.State == "alive" {
			alive++
		}
	}
	state := StateUnhealthy
	switch {
	case alive == 0:
		state = StateStopped
	case alive == len(observed):
		state = StateRunning
	}
	return Status{Runner: r.Name(), State: state, Healthy: state == StateRunning}, nil
}
