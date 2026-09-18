package manager

import "time"

// Event is a structured service lifecycle event for JSONL streaming.
type Event struct {
	Event    string    `json:"event"`              // starting, alive, crashed, restarting, stopped, health, failed, done
	Service  string    `json:"service,omitempty"`  // service ID
	TS       time.Time `json:"ts"`                 // timestamp
	Elapsed  string    `json:"elapsed,omitempty"`  // duration for start/stop operations
	Latency  string    `json:"latency,omitempty"`  // health check latency
	Slow     bool      `json:"slow,omitempty"`     // latency > threshold
	ExitCode int       `json:"exitCode,omitempty"` // process exit code on crash
	Error    string    `json:"error,omitempty"`    // error description
	LogsTail []string  `json:"logsTail,omitempty"` // last lines of log on crash/fail
	Attempt  int       `json:"attempt,omitempty"`  // restart attempt number
	Backoff  string    `json:"backoff,omitempty"`  // next retry delay
	Detail   string    `json:"detail,omitempty"`   // additional context
}

// Action describes what was done for a single service during an operation.
type Action struct {
	Service  string   `json:"service"`
	Action   string   `json:"action"`             // started, stopped, skipped, failed, restarted
	Reason   string   `json:"reason,omitempty"`   // why skipped
	Elapsed  string   `json:"elapsed,omitempty"`  // how long the action took
	Error    string   `json:"error,omitempty"`    // error if failed
	LogsTail []string `json:"logsTail,omitempty"` // last log lines on failure
}

// Result is the unified response from any Manager operation.
type Result struct {
	OK      bool     `json:"ok"`
	Actions []Action `json:"actions,omitempty"`
	Hint    string   `json:"hint,omitempty"` // actionable fix on failure
}

// ServiceHealth is a snapshot of a service's health state.
type ServiceHealth struct {
	OK      bool   `json:"ok"`
	Latency string `json:"latency,omitempty"`
	Slow    bool   `json:"slow,omitempty"`
}

// ServiceStatus is a snapshot of a service's full state for JSON output.
type ServiceStatus struct {
	State            string            `json:"state"`
	PID              int               `json:"pid,omitempty"`
	PGID             int               `json:"pgid,omitempty"`
	StartedBy        string            `json:"startedBy,omitempty"`
	StartedAt        string            `json:"startedAt,omitempty"`
	Uptime           string            `json:"uptime,omitempty"`
	Health           *ServiceHealth    `json:"health,omitempty"`
	Resources        *ResourceUsage    `json:"resources,omitempty"`
	Port             int               `json:"port,omitempty"`
	URL              string            `json:"url,omitempty"`
	Deps             []string          `json:"deps,omitempty"`
	DepsState        map[string]string `json:"depsState,omitempty"`
	Detail           string            `json:"detail,omitempty"`
	Cleanup          string            `json:"cleanupCommand,omitempty"`
	LogFile          string            `json:"logFile,omitempty"`
	PortOccupant     *PortOccupant     `json:"portOccupant,omitempty"`
	LogsTail         []string          `json:"logsTail,omitempty"`
	ContainerID      string            `json:"containerId,omitempty"`
	ContainerName    string            `json:"containerName,omitempty"`
	ContainerRunning bool              `json:"containerRunning,omitempty"`
	ContainerOwned   bool              `json:"containerOwned,omitempty"`
}

// ResourceUsage tracks CPU and memory for a running process.
type ResourceUsage struct {
	CPU    string `json:"cpu"`    // percentage, e.g. "58.1%"
	Memory string `json:"memory"` // human-readable, e.g. "201MB"
	RSS    int64  `json:"rss"`    // resident set size in bytes
}

// PortOccupant describes an alien process holding a port.
type PortOccupant struct {
	PID     int    `json:"pid"`
	Command string `json:"command"`
}

// StatusResult is the full status response.
type StatusResult struct {
	OK             bool                     `json:"ok"`
	Services       map[string]ServiceStatus `json:"services"`
	Summary        StatusSummary            `json:"summary"`
	RuntimeAnomaly []RuntimeAnomaly         `json:"runtimeAnomalies,omitempty"`
}

// RuntimeAnomaly explains a catalog/process mismatch without authorizing a
// destructive action. Agents can use the suggested action after inspection.
type RuntimeAnomaly struct {
	Service  string `json:"service"`
	PID      int    `json:"pid"`
	PGID     int    `json:"pgid,omitempty"`
	Instance string `json:"instanceId,omitempty"`
	State    string `json:"state"` // orphaned or stale-runtime
	Reason   string `json:"reason"`
	Action   string `json:"action"`
}

// StatusSummary provides aggregate counts.
type StatusSummary struct {
	Alive    int `json:"alive"`
	Starting int `json:"starting"`
	Failed   int `json:"failed"`
	Dead     int `json:"dead"`
	Stopping int `json:"stopping"`
	Total    int `json:"total"`
}

// HealthResult is the health check response.
type HealthResult struct {
	OK       bool                      `json:"ok"`
	Services map[string]*ServiceHealth `json:"services"`
}

// DoctorCheck is a single environment check result.
type DoctorCheck struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Path   string `json:"path,omitempty"`
	// Warn marks a passing check that still deserves attention (OK stays true).
	Warn bool `json:"warn,omitempty"`
}

// DoctorResult is the environment diagnostics response.
type DoctorResult struct {
	OK     bool          `json:"ok"`
	Checks []DoctorCheck `json:"checks"`
	Hint   string        `json:"hint,omitempty"`
}
