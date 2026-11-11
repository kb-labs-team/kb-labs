package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kb-labs/clikit/diag"
	"io"
	"net/http"
	"os"

	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
)

// Client talks to a running launcher through control.json.
type Client struct {
	File File
	HTTP *http.Client
}

// Connect reads control.json and verifies that its launcher process is alive;
// a file left behind by a crashed launcher is ignored.
func Connect(state host.State) (*Client, error) {
	data, err := os.ReadFile(state.Control())
	if err != nil {
		return nil, unavailable(err)
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, unavailable(err)
	}
	switch host.ProcessIdentityOf(file.PID, file.ProcessIdentity) {
	case host.ProcessIdentityMatch:
	case host.ProcessIdentityMismatch:
		return nil, unavailable(fmt.Errorf("launcher process identity for PID %d does not match its control record", file.PID))
	case host.ProcessIdentityUndetermined:
		return nil, unavailable(fmt.Errorf("launcher process identity for PID %d cannot be determined", file.PID))
	default:
		return nil, unavailable(fmt.Errorf("launcher process identity for PID %d is missing or stale", file.PID))
	}
	return &Client{File: file, HTTP: http.DefaultClient}, nil
}

func unavailable(cause error) *diag.Diag {
	return contracts.NewDiag("KB_HOST_CONTROL_UNAVAILABLE", "The launcher control channel is unavailable.", "Start the launcher or the desktop shell.", cause)
}

// Status calls GET /v1/status.
func (c *Client) Status(ctx context.Context) (StatusResponse, error) {
	var out StatusResponse
	return out, c.do(ctx, http.MethodGet, "/v1/status", nil, &out)
}

// Restart calls POST /v1/host/restart.
func (c *Client) Restart(ctx context.Context, interrupt bool) (RestartResponse, error) {
	var out RestartResponse
	return out, c.do(ctx, http.MethodPost, "/v1/host/restart", RestartRequest{Interrupt: interrupt}, &out)
}

// RequestUpdate calls POST /v1/update-request.
func (c *Client) RequestUpdate(ctx context.Context, input UpdateRequestInput) (UpdateRequestResponse, error) {
	var out UpdateRequestResponse
	return out, c.do(ctx, http.MethodPost, "/v1/update-request", input, &out)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://"+c.File.Address+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.File.Token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return unavailable(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return unavailable(err)
	}
	if response.StatusCode >= 400 {
		var failure ErrorResponse
		if json.Unmarshal(data, &failure) == nil && failure.Error != nil {
			return failure.Error
		}
		return unavailable(errors.New(response.Status))
	}
	return json.Unmarshal(data, out)
}
