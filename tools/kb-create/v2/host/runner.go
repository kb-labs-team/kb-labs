package host

import (
	"context"
	"strconv"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/services"
)

// Host states reported by Runner.Status.
const (
	StateRunning   = "running"
	StateUnhealthy = "unhealthy"
	StateStopped   = "stopped"
)

// Info describes a host that Start brought up.
type Info struct {
	Runner    string `json:"runner"`
	PID       int    `json:"pid,omitempty"`
	HealthURL string `json:"healthUrl,omitempty"`
}

// StopResult reports how a stop ended. Forced means the grace period expired
// and the process group was killed.
type StopResult struct {
	Runner     string `json:"runner"`
	WasRunning bool   `json:"wasRunning"`
	Graceful   bool   `json:"graceful"`
	Forced     bool   `json:"forced"`
	PID        int    `json:"pid,omitempty"`
}

// Status is a point-in-time view of the host.
type Status struct {
	Runner    string     `json:"runner"`
	State     string     `json:"state"`
	PID       int        `json:"pid,omitempty"`
	Healthy   bool       `json:"healthy"`
	HealthURL string     `json:"healthUrl,omitempty"`
	StartedAt *time.Time `json:"startedAt,omitempty"`
	// StalePID is true when a pid file pointed at a dead process and was cleaned.
	StalePID bool `json:"stalePid,omitempty"`
}

// Runner starts, stops and inspects the platform host. Errors are
// *contracts.LauncherError with KB_HOST_* codes.
type Runner interface {
	Name() string
	Start(ctx context.Context) (Info, error)
	Stop(ctx context.Context) (StopResult, error)
	Status(ctx context.Context) (Status, error)
}

// Select picks the runner for an installation. Behaviour-preserving default:
// without a host spec in the receipt the existing kb-dev startup is used.
func Select(platformRoot, kbdevBinary string) (Runner, error) {
	spec, err := LoadSpec(platformRoot)
	if err != nil {
		if _, readErr := receipt.Read(platformRoot); readErr != nil {
			return nil, contracts.NewLauncherError(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", readErr)
		}
		return nil, specInvalid(err)
	}
	if spec != nil {
		return &ProcessRunner{Spec: *spec, State: StateFor(platformRoot)}, nil
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return nil, contracts.NewLauncherError(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err)
	}
	ids := make([]string, 0, len(active.Plan.ServiceGraph.Services))
	for _, service := range active.Plan.ServiceGraph.Services {
		ids = append(ids, service.ID)
	}
	return &KBDevRunner{PlatformRoot: platformRoot, ServiceIDs: ids, Client: services.KBDev{Binary: kbdevBinary}}, nil
}

func specInvalid(cause error) *contracts.LauncherError {
	e := contracts.NewLauncherError("KB_HOST_SPEC_INVALID", "The host specification in the installation receipt is invalid: "+cause.Error()+".", "Run \"kb-create doctor --fix\" or reinstall with \"kb-create apply\".", cause)
	return e
}

func hostError(code, message, hint string, cause error, details map[string]string) *contracts.LauncherError {
	e := contracts.NewLauncherError(code, message, hint, cause)
	e.Details = details
	return e
}

func pidDetail(pid int) map[string]string { return map[string]string{"pid": strconv.Itoa(pid)} }
