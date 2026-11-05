package host

import (
	"context"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"path/filepath"
	"strconv"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
)

// Host states reported by Runner.Status.
const (
	StateRunning   = "running"
	StateUnhealthy = "unhealthy"
	StateStopped   = "stopped"
)

// Info describes a host that Start brought up.
type Info struct {
	Runner         string `json:"runner"`
	PID            int    `json:"pid,omitempty"`
	HealthURL      string `json:"healthUrl,omitempty"`
	ControlAddress string `json:"-"`
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
	Runner          string     `json:"runner"`
	State           string     `json:"state"`
	PID             int        `json:"pid,omitempty"`
	Healthy         bool       `json:"healthy"`
	HealthURL       string     `json:"healthUrl,omitempty"`
	StudioURL       string     `json:"studioUrl,omitempty"`
	PlatformVersion string     `json:"platformVersion,omitempty"`
	TreeRoot        string     `json:"-"`
	ReceiptID       string     `json:"receiptId,omitempty"`
	ServiceIDs      []string   `json:"serviceIds,omitempty"`
	StartedAt       *time.Time `json:"startedAt,omitempty"`
	// StalePID is true when a pid file pointed at a dead process and was cleaned.
	StalePID bool `json:"stalePid,omitempty"`
}

// Runner starts, stops and inspects the platform host. Errors are
// *diag.Diag with KB_HOST_* codes.
type Runner interface {
	Name() string
	Start(ctx context.Context) (Info, error)
	Stop(ctx context.Context) (StopResult, error)
	Status(ctx context.Context) (Status, error)
}

// NewRunner builds the runner for an installation: the host process its
// receipt declares, supervised under the install-root state directory. Its secret
// environment is read from the platform's private store at every start, so a
// value stored after the launcher began still reaches the next host process.
func NewRunner(platformRoot string) (*ProcessRunner, error) {
	layout, err := versionroot.ForPlatformPath(platformRoot)
	if err != nil {
		return nil, err
	}
	platformRoot = layout.PlatformRoot()
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return nil, contracts.NewDiag(contracts.CodeReceiptUnavailable,
			"The active install receipt could not be read.",
			"Run `"+contracts.ShellCommand("kb-create", "update", "--platform-root", platformRoot)+"` or reinstall the platform, then retry.", err)
	}
	if active.InstallationID == "" {
		return nil, contracts.NewDiag(contracts.CodeReceiptUnavailable,
			"The active install receipt has no installation ID.",
			"Run `"+contracts.ShellCommand("kb-create", "update", "--platform-root", platformRoot)+"` or reinstall the platform, then retry.", nil)
	}
	installationID, err := versionroot.InstallationIDForPath(layout.InstallRoot())
	if err != nil || active.InstallationID != installationID {
		return nil, contracts.NewDiag(contracts.CodeReceiptUnavailable,
			"The active receipt does not match the install-root ownership identity.",
			"Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", layout.InstallRoot())+"` and repair or reinstall the platform.", err)
	}
	spec, err := LoadSpec(platformRoot)
	if err != nil {
		return nil, err
	}
	store := secrets.Store{PlatformRoot: platformRoot}
	root, err := filepath.Abs(platformRoot)
	if err != nil {
		return nil, err
	}
	root = filepath.Clean(root)
	treeRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	state, err := StateForRoot(layout.InstallRoot())
	if err != nil {
		return nil, err
	}
	serviceIDs := make([]string, 0, len(active.Plan.ServiceGraph.Services))
	for _, service := range active.Plan.ServiceGraph.Services {
		serviceIDs = append(serviceIDs, service.ID)
	}
	identity, err := NewProcessIdentity(active, root, filepath.Clean(treeRoot))
	if err != nil {
		return nil, err
	}
	return &ProcessRunner{Spec: spec, State: state, InstallRoot: layout.InstallRoot(), InstallationID: installationID, PlatformRoot: root, TreeRoot: filepath.Clean(treeRoot),
		Identity: identity, SecretEnv: store.Environment}, nil
}

func NewRecordedRunner(installRoot string) (*ProcessRunner, error) {
	layout, err := versionroot.ForPlatformPath(installRoot)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(layout.PlatformRoot())
	if err != nil {
		return nil, err
	}
	state, err := StateForRoot(filepath.Clean(layout.InstallRoot()))
	if err != nil {
		return nil, err
	}
	installationID, err := versionroot.InstallationIDForPath(layout.InstallRoot())
	if err != nil {
		return nil, err
	}
	return &ProcessRunner{InstallRoot: layout.InstallRoot(), InstallationID: installationID, PlatformRoot: filepath.Clean(root), State: state, Spec: Spec{StopGrace: defaultStopGrace}}, nil
}

// Prober starts the plan's host under its installation-owned state directory.
// Runtime stops it if verification fails and keeps it running after commit.
type Prober struct {
	PlatformRoot string
	Operation    string
}

// Start launches the declared host and returns its cleanup operation.
func (p Prober) Start(ctx context.Context, declared contracts.HostSpec) (func() error, error) {
	runner, err := NewRunner(p.PlatformRoot)
	if err != nil {
		return nil, err
	}
	if runner.Spec.Command != resolveCommand(runner.PlatformRoot, declared.Command) || runner.Spec.HealthURL != declared.HealthURL {
		return nil, specInvalid(fmt.Errorf("probe specification does not match the active receipt"))
	}
	runner.Operation = p.Operation
	if _, err := runner.Start(ctx); err != nil {
		return nil, err
	}
	return func() error {
		_, err := runner.Stop(context.Background())
		return err
	}, nil
}

// Probe starts and stops the declared host for update staging without changing
// the prior running state.
func (p Prober) Probe(ctx context.Context, declared contracts.HostSpec) error {
	stop, err := p.Start(ctx, declared)
	if err != nil {
		return err
	}
	return stop()
}

func specInvalid(cause error) *diag.Diag {
	return contracts.HostSpecDiagnostic("The host specification in the installation receipt is invalid: "+cause.Error()+".", "Reinstall the platform with \"kb-create apply\".", cause.Error(), cause)
}

func hostError(code, message, hint string, cause error, details map[string]string) *diag.Diag {
	e := contracts.NewDiag(code, message, hint, cause)
	e.Meta = make(map[string]any, len(details))
	for key, value := range details {
		e.Meta[key] = value
	}
	return e
}

func pidDetail(pid int) map[string]string { return map[string]string{"pid": strconv.Itoa(pid)} }
