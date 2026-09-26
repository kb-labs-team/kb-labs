package contracts

// HostSpec tells the launcher how to run the platform host as one supervised
// process (ADR-0043 / ADR-0045). It is optional in the resolved plan: an
// installation whose plan declares no host keeps being driven through kb-dev.
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
}
