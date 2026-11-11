package marketplace

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
)

const installEndpoint = "/api/v1/marketplace/packages/install"

type InstallClient interface {
	Install(ctx context.Context, gatewayOrigin string, specs []string) ([]contracts.MarketplaceInstallRecord, error)
}

type GatewayInstallClient struct {
	HTTP *http.Client
}

type InstallFailure struct {
	Spec    string
	Source  string
	Code    string
	Message string
	Cause   error
}

func (failure *InstallFailure) Error() string {
	if failure.Code != "" {
		if failure.Cause != nil {
			return fmt.Sprintf("%s: %s; %v", failure.Code, failure.Message, failure.Cause)
		}
		return fmt.Sprintf("%s: %s", failure.Code, failure.Message)
	}
	return fmt.Sprintf("Marketplace install for %s failed through %s: %v", failure.Spec, failure.Source, failure.Cause)
}

func (failure *InstallFailure) Unwrap() error { return failure.Cause }

func (client GatewayInstallClient) Install(ctx context.Context, gatewayOrigin string, specs []string) ([]contracts.MarketplaceInstallRecord, error) {
	if gatewayOrigin == "" || len(specs) == 0 {
		return nil, fmt.Errorf("Gateway origin and Marketplace install specs are required")
	}
	body, err := json.Marshal(struct {
		Specs []string `json:"specs"`
		Scope string   `json:"scope"`
	}{Specs: specs, Scope: "platform"})
	if err != nil {
		return nil, fmt.Errorf("encode Marketplace install request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(gatewayOrigin, "/")+installEndpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create Marketplace install request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	httpClient := client.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, &InstallFailure{Spec: strings.Join(specs, ", "), Source: "configured Marketplace sources", Cause: err}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read Marketplace install response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error struct {
				Code    string         `json:"code"`
				Message string         `json:"message"`
				Cause   string         `json:"cause"`
				Details map[string]any `json:"details"`
				Meta    map[string]any `json:"meta"`
			} `json:"error"`
		}
		if err := json.Unmarshal(data, &failure); err != nil {
			return nil, fmt.Errorf("Marketplace install returned HTTP %d with an invalid error envelope", response.StatusCode)
		}
		spec := strings.Join(specs, ", ")
		if len(specs) == 1 {
			spec = specs[0]
		}
		source := ""
		for _, details := range []map[string]any{failure.Error.Details, failure.Error.Meta} {
			for _, key := range []string{"plugin", "package"} {
				if value, ok := details[key].(string); ok && value != "" {
					spec = value
					break
				}
			}
			if value, ok := details["source"].(string); ok {
				source = value
			}
		}
		if source == "" {
			source = "configured Marketplace sources"
		}
		message := failure.Error.Message
		if message == "" {
			message = fmt.Sprintf("Marketplace returned HTTP %d", response.StatusCode)
		}
		var cause error
		if failure.Error.Cause != "" {
			cause = fmt.Errorf("%s", failure.Error.Cause)
		}
		return nil, &InstallFailure{Spec: spec, Source: source, Code: failure.Error.Code, Message: message, Cause: cause}
	}
	var result struct {
		Installed []contracts.MarketplaceInstallRecord `json:"installed"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("decode Marketplace install response: %w", err)
	}
	if len(result.Installed) != len(specs) {
		return nil, fmt.Errorf("Marketplace returned %d installed records for %d requested specs", len(result.Installed), len(specs))
	}
	for index, spec := range specs {
		if result.Installed[index].Spec != spec {
			return nil, fmt.Errorf("Marketplace returned install spec %q at position %d, want %q", result.Installed[index].Spec, index, spec)
		}
	}
	return result.Installed, nil
}
