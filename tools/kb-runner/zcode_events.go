//go:build darwin || linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

// zcodeErrorAttribution mirrors the structured attribution the ZCode CLI
// projects into a turn failure (core/src/errors/error-payload.ts).
type zcodeErrorAttribution struct {
	ProviderErrorCode string `json:"providerErrorCode"`
	StatusCode        int    `json:"statusCode"`
	Source            string `json:"source"`
	ExceptionKind     string `json:"exceptionKind"`
	ErrorPhase        string `json:"errorPhase"`
}

func parseZcodeEvent(line []byte) (VendorEvent, error) {
	var row struct {
		Type      string `json:"type"`
		SessionID string `json:"sessionId"`
		Response  string `json:"response"`
		Payload   struct {
			Error struct {
				Message     string                `json:"message"`
				Code        string                `json:"code"`
				Attribution zcodeErrorAttribution `json:"attribution"`
			} `json:"error"`
		} `json:"payload"`
		Usage struct {
			Input  uint64 `json:"inputTokens"`
			Output uint64 `json:"outputTokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(line, &row); err != nil {
		return VendorEvent{}, fmt.Errorf("decode ZCode stream event: %w", err)
	}
	if row.Type == "" {
		return VendorEvent{}, errors.New("ZCode stream event is missing its type")
	}
	event := VendorEvent{RawType: row.Type, SessionID: row.SessionID, Kind: EventActivity}
	switch row.Type {
	case "session.created", "session.resumed":
		event.Kind = EventStarted
	case "turn.failed":
		event.Kind = EventVendorError
		event.Message = row.Payload.Error.Message
		if event.Message == "" {
			event.Message = "ZCode turn failed without an error message"
		}
		event.ProviderCode = row.Payload.Error.Attribution.ProviderErrorCode
		if event.ProviderCode == "" {
			event.ProviderCode = row.Payload.Error.Code
		}
		event.StatusCode = row.Payload.Error.Attribution.StatusCode
		event.FailureSource = zcodeFailureSource(row.Payload.Error.Attribution)
	case "result":
		event.Kind = EventFinal
		event.FinalMessage = row.Response
		event.InputTokens = row.Usage.Input
		event.OutputTokens = row.Usage.Output
		event.Tokens = event.InputTokens + event.OutputTokens
	}
	return event, nil
}

// zcodeFailureSource normalizes the vendor's structured transport attribution
// into a single source marker the failure table consumes: connect-phase
// failures, transport exceptions, and network-sourced errors are transport
// losses regardless of which field carried them.
func zcodeFailureSource(attribution zcodeErrorAttribution) string {
	switch {
	case attribution.Source == "network", attribution.ExceptionKind == "transport", attribution.ErrorPhase == "connect":
		return "network"
	default:
		return attribution.Source
	}
}

func zcodeArgs(request AgentRequest, resume bool) []string {
	args := make([]string, 0, 13)
	if resume {
		args = append(args, "--resume", request.SessionID)
	}
	args = append(args,
		"--prompt", request.Prompt,
		"--cwd", request.Workdir,
		"--mode", "yolo",
		"--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode",
		"--output-format", "stream-json",
		"--no-color",
	)
	return args
}
