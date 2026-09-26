// Package host supervises the platform host process for the launcher. A
// Runner is the only thing the CLI and the control channel know about; the
// legacy kb-dev startup and the direct ProcessRunner are two implementations.
package host

import (
	"fmt"
	"net/url"
	"path/filepath"
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/receipt"
)

const (
	defaultReadyTimeout = 30 * time.Second
	defaultStopGrace    = 10 * time.Second
)

// Spec is a validated HostSpec with absolute paths and durations.
type Spec struct {
	Command      string
	Args         []string
	Env          map[string]string
	WorkingDir   string
	HealthURL    string
	ReadyTimeout time.Duration
	StopGrace    time.Duration
	// Recover is the platform's account recovery tool, when it ships one.
	Recover *Tool
}

// Tool is a validated ToolSpec: a command the launcher runs once, in the
// host's working directory and environment, instead of the long-running host.
type Tool struct {
	Command string
	Args    []string
}

// LoadSpec returns the host spec declared by the active receipt. A receipt
// without one predates the host-only launcher and cannot be run.
func LoadSpec(platformRoot string) (Spec, error) {
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return Spec{}, contracts.NewLauncherError(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err)
	}
	if active.Plan.Host == nil {
		return Spec{}, specInvalid(fmt.Errorf("the receipt declares no host"))
	}
	spec, err := NewSpec(platformRoot, *active.Plan.Host)
	if err != nil {
		return Spec{}, specInvalid(err)
	}
	return spec, nil
}

// NewSpec validates a declared spec and resolves it against the platform root.
func NewSpec(platformRoot string, declared contracts.HostSpec) (Spec, error) {
	if err := declared.Validate(); err != nil {
		return Spec{}, err
	}
	spec := Spec{
		Command: declared.Command, Args: append([]string(nil), declared.Args...), Env: declared.Env,
		WorkingDir: declared.WorkingDir, HealthURL: declared.HealthURL,
		ReadyTimeout: seconds(declared.ReadyTimeoutSeconds, defaultReadyTimeout),
		StopGrace:    seconds(declared.StopGraceSeconds, defaultStopGrace),
	}
	if spec.WorkingDir == "" {
		spec.WorkingDir = platformRoot
	} else if !filepath.IsAbs(spec.WorkingDir) {
		spec.WorkingDir = filepath.Join(platformRoot, spec.WorkingDir)
	}
	spec.Command = resolveCommand(platformRoot, spec.Command)
	if declared.Recover != nil {
		spec.Recover = &Tool{Command: resolveCommand(platformRoot, declared.Recover.Command), Args: append([]string(nil), declared.Recover.Args...)}
	}
	return spec, nil
}

// resolveCommand looks a bare command name up on PATH; anything with a
// separator is a path and is anchored at the platform root when relative.
func resolveCommand(platformRoot, command string) string {
	if !filepath.IsAbs(command) && filepath.Base(command) != command {
		return filepath.Join(platformRoot, command)
	}
	return command
}

func seconds(value int, fallback time.Duration) time.Duration {
	if value == 0 {
		return fallback
	}
	return time.Duration(value) * time.Second
}

// HealthAddress is the host:port that must be free before the host starts.
func (spec Spec) HealthAddress() string {
	parsed, _ := url.Parse(spec.HealthURL)
	return parsed.Host
}
