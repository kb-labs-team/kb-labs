package host

import (
	"context"
	"path/filepath"
	"strconv"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/secrets"
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

// NewRunner builds the runner for an installation: the host process its
// receipt declares, supervised under the per-user state home. Its secret
// environment is read from the platform's private store at every start, so a
// value stored after the launcher began still reaches the next host process.
func NewRunner(platformRoot string, state State) (*ProcessRunner, error) {
	spec, err := LoadSpec(platformRoot)
	if err != nil {
		return nil, err
	}
	store := secrets.Store{PlatformRoot: platformRoot}
	return &ProcessRunner{Spec: spec, State: state, SecretEnv: store.Environment}, nil
}

// Prober is the trial run used to validate a plan's host before its receipt is
// committed: the host starts under a scratch state directory (so it never
// touches the pid file of a real, supervised host), must become healthy, and is
// stopped again. A host that is already running on the same port fails the
// probe with KB_HOST_PORT_IN_USE, which is the right answer.
type Prober struct {
	PlatformRoot string
	State        State
}

// Probe starts and stops the declared host once.
func (p Prober) Probe(ctx context.Context, declared contracts.HostSpec) error {
	spec, err := NewSpec(p.PlatformRoot, declared)
	if err != nil {
		return specInvalid(err)
	}
	store := secrets.Store{PlatformRoot: p.PlatformRoot}
	runner := &ProcessRunner{Spec: spec, State: State{Dir: filepath.Join(p.State.Dir, "probe")}, SecretEnv: store.Environment}
	if _, err := runner.Start(ctx); err != nil {
		return err
	}
	_, err = runner.Stop(context.Background())
	return err
}

func specInvalid(cause error) *contracts.LauncherError {
	return contracts.NewLauncherError(contracts.CodeHostSpecInvalid, "The host specification in the installation receipt is invalid: "+cause.Error()+".", "Reinstall the platform with \"kb-create apply\".", cause)
}

func hostError(code, message, hint string, cause error, details map[string]string) *contracts.LauncherError {
	e := contracts.NewLauncherError(code, message, hint, cause)
	e.Details = details
	return e
}

func pidDetail(pid int) map[string]string { return map[string]string{"pid": strconv.Itoa(pid)} }
