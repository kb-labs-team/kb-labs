package contracts

import (
	"fmt"
	"net"
	"net/url"

	"github.com/kb-labs/clikit/diag"
)

// HostControlCredentialEnv is injected by the launcher when the host control
// endpoint is required. The host must use the same name to publish its
// readiness address.
const HostControlCredentialEnv = diag.KB_HOST_CONTROL_TOKEN

// HostActiveWorkAddressHeader carries the loopback control address on the
// host's health response so the launcher can validate readiness.
const HostActiveWorkAddressHeader = "x-kb-host-active-work-address"

// HostSpec tells the launcher how to run the platform host as one supervised
// process (ADR-0043 / ADR-0045). The release index declares it for every
// platform bundle and the resolver copies it into the plan: the launcher has no
// other way to run a platform (kb-dev is an author tool, not part of the user
// path).
//
// Relative Command and WorkingDir values are resolved against the platform
// root. The launcher never interprets Args through a shell.
type HostSpec struct {
	Command    string            `json:"command"`
	Args       []string          `json:"args,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	WorkingDir string            `json:"workingDir,omitempty"`
	// HealthURL must be an http URL on a loopback address; readiness is a 2xx.
	HealthURL string `json:"healthUrl"`
	// ReadyTimeoutSeconds bounds start-to-healthy time (default 30).
	ReadyTimeoutSeconds int `json:"readyTimeoutSeconds,omitempty"`
	// StopGraceSeconds is the SIGTERM-to-kill window (default 10).
	StopGraceSeconds int `json:"stopGraceSeconds,omitempty"`
	// Recover is the platform's account recovery tool, run by
	// "kb-create doctor --recover" while the host is stopped. Optional: a
	// platform without one cannot be recovered this way.
	Recover *ToolSpec `json:"recover,omitempty"`
}

// ToolSpec is a command the launcher runs to completion. Relative Command
// values are resolved against the platform root; Args are never run through a
// shell.
type ToolSpec struct {
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
}

// Validate reports why a declared host cannot be supervised.
func (spec HostSpec) Validate() error {
	if spec.Command == "" {
		return fmt.Errorf("command is required")
	}
	parsed, err := url.Parse(spec.HealthURL)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() == "" {
		return fmt.Errorf("healthUrl must be an http URL")
	}
	if !isLoopbackName(parsed.Hostname()) {
		return fmt.Errorf("healthUrl must point at a loopback address")
	}
	if parsed.Port() == "" {
		return fmt.Errorf("healthUrl must include an explicit port")
	}
	if spec.ReadyTimeoutSeconds < 0 || spec.StopGraceSeconds < 0 {
		return fmt.Errorf("timeouts must not be negative")
	}
	if spec.Recover != nil && spec.Recover.Command == "" {
		return fmt.Errorf("recover command is required")
	}
	return nil
}

func isLoopbackName(name string) bool {
	if name == "localhost" {
		return true
	}
	ip := net.ParseIP(name)
	return ip != nil && ip.IsLoopback()
}
