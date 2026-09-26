// Package control is the launcher's local control channel (ADR-0045): a small
// versioned JSON protocol served on loopback with a bearer token. It is the
// only bridge from the host (and Studio through it) to launcher lifecycle
// operations. The wire contract is pinned by the JSON fixtures in
// core/platform/src/launcher-control/fixtures, shared with the TS client.
package control

import (
	"time"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
)

// ProtocolVersion is the wire protocol version; endpoints live under /v1.
const ProtocolVersion = 1

// File is control.json: how a local client finds and authenticates to the
// launcher. It is written 0600 and removed when the launcher exits.
type File struct {
	Protocol int    `json:"protocol"`
	Address  string `json:"address"`
	Token    string `json:"token"`
	PID      int    `json:"pid"`
	Version  string `json:"version"`
}

// LauncherInfo identifies the running launcher.
type LauncherInfo struct {
	Version   string    `json:"version"`
	PID       int       `json:"pid"`
	StartedAt time.Time `json:"startedAt"`
}

// QueueSummary counts update requests by state.
type QueueSummary struct {
	Pending int `json:"pending"`
}

// StatusResponse is the body of GET /v1/status.
type StatusResponse struct {
	OK             bool         `json:"ok"`
	Protocol       int          `json:"protocol"`
	Launcher       LauncherInfo `json:"launcher"`
	Host           host.Status  `json:"host"`
	UpdateRequests QueueSummary `json:"updateRequests"`
}

// RestartResponse is the body of POST /v1/host/restart.
type RestartResponse struct {
	OK       bool            `json:"ok"`
	Protocol int             `json:"protocol"`
	Stopped  host.StopResult `json:"stopped"`
	Host     host.Info       `json:"host"`
}

// UpdateRequestInput is the body of POST /v1/update-request. Exactly one of
// Version and Channel must be set.
type UpdateRequestInput struct {
	Version     string `json:"version,omitempty"`
	Channel     string `json:"channel,omitempty"`
	RequestedBy string `json:"requestedBy,omitempty"`
}

// UpdateRequest is a recorded, not yet executed, update request.
type UpdateRequest struct {
	ID          string    `json:"id"`
	Status      string    `json:"status"`
	Version     string    `json:"version,omitempty"`
	Channel     string    `json:"channel,omitempty"`
	RequestedBy string    `json:"requestedBy,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

// UpdateRequestResponse is the 202 body of POST /v1/update-request.
type UpdateRequestResponse struct {
	OK       bool          `json:"ok"`
	Protocol int           `json:"protocol"`
	Request  UpdateRequest `json:"request"`
}

// ErrorResponse wraps the unified error envelope.
type ErrorResponse struct {
	OK    bool                     `json:"ok"`
	Error *contracts.LauncherError `json:"error"`
}
