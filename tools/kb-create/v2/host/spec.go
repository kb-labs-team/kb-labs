// Package host supervises the platform host process for the launcher. A
// Runner is the only thing the CLI and the control channel know about; the
// legacy kb-dev startup and the direct ProcessRunner are two implementations.
package host

import (
	"fmt"
	"net"
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
}

// LoadSpec returns the host spec declared by the active receipt, or nil when
// the installation does not declare one (kb-dev remains the runner).
func LoadSpec(platformRoot string) (*Spec, error) {
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return nil, fmt.Errorf("read active receipt: %w", err)
	}
	if active.Plan.Host == nil {
		return nil, nil
	}
	spec, err := NewSpec(platformRoot, *active.Plan.Host)
	if err != nil {
		return nil, err
	}
	return &spec, nil
}

// NewSpec validates a declared spec and resolves it against the platform root.
func NewSpec(platformRoot string, declared contracts.HostSpec) (Spec, error) {
	if declared.Command == "" {
		return Spec{}, fmt.Errorf("command is required")
	}
	parsed, err := url.Parse(declared.HealthURL)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() == "" {
		return Spec{}, fmt.Errorf("healthUrl must be an http URL")
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return Spec{}, fmt.Errorf("healthUrl must point at a loopback address")
	}
	if parsed.Port() == "" {
		return Spec{}, fmt.Errorf("healthUrl must include an explicit port")
	}
	if declared.ReadyTimeoutSeconds < 0 || declared.StopGraceSeconds < 0 {
		return Spec{}, fmt.Errorf("timeouts must not be negative")
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
	// A bare command name is looked up on PATH; anything with a separator is
	// a path and is anchored at the platform root when relative.
	if !filepath.IsAbs(spec.Command) && filepath.Base(spec.Command) != spec.Command {
		spec.Command = filepath.Join(platformRoot, spec.Command)
	}
	return spec, nil
}

func seconds(value int, fallback time.Duration) time.Duration {
	if value == 0 {
		return fallback
	}
	return time.Duration(value) * time.Second
}

func isLoopbackHost(name string) bool {
	if name == "localhost" {
		return true
	}
	ip := net.ParseIP(name)
	return ip != nil && ip.IsLoopback()
}

// HealthAddress is the host:port that must be free before the host starts.
func (spec Spec) HealthAddress() string {
	parsed, _ := url.Parse(spec.HealthURL)
	return parsed.Host
}
