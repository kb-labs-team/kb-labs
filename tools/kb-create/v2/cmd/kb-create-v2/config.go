package v2cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
)

// installConfig is the safe, declarative overlay accepted by plan/apply.
// Values are keyed by release manifest requirement IDs; config paths and
// operations are never accepted from this file.
type installConfig struct {
	MarketplaceSources   *contracts.MarketplaceSources `json:"marketplaceSources,omitempty"`
	ServiceTransportURLs map[string]string             `json:"serviceTransportURLs,omitempty"`
	Values               map[string]json.RawMessage    `json:"values,omitempty"`
	SecretInputs         []string                      `json:"secretInputs,omitempty"`
}

func readInstallConfig(path string) (installConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return installConfig{}, fmt.Errorf("read install config: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config installConfig
	if err := decoder.Decode(&config); err != nil {
		return installConfig{}, fmt.Errorf("decode install config: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return installConfig{}, fmt.Errorf("decode install config: expected one JSON value")
	}
	return config, nil
}

func mergeInstallConfig(request contracts.InstallRequest, config installConfig) (contracts.InstallRequest, error) {
	if config.MarketplaceSources != nil {
		request.MarketplaceSources = config.MarketplaceSources
	}
	if len(config.ServiceTransportURLs) > 0 {
		if request.ServiceTransportURLs == nil {
			request.ServiceTransportURLs = map[string]string{}
		}
		for serviceID, endpoint := range config.ServiceTransportURLs {
			request.ServiceTransportURLs[serviceID] = endpoint
		}
	}
	if len(config.Values) > 0 {
		if request.Values == nil {
			request.Values = map[string]string{}
		}
		for id, value := range config.Values {
			if id == "" || !json.Valid(value) {
				return contracts.InstallRequest{}, fmt.Errorf("config value for %q must be a JSON value", id)
			}
			if id == "marketplace.sources" {
				return contracts.InstallRequest{}, fmt.Errorf("Marketplace sources must use the typed marketplaceSources config")
			}
			request.Values[id] = string(value)
		}
	}
	if len(config.SecretInputs) > 0 {
		request.SecretInputs = append(request.SecretInputs, config.SecretInputs...)
	}
	for id := range request.Values {
		for _, secretID := range request.SecretInputs {
			if id == secretID {
				return contracts.InstallRequest{}, fmt.Errorf("configuration %q cannot be both a literal value and a secret reference", id)
			}
		}
	}
	return request.Normalize()
}

func validateConfigValues(request contracts.InstallRequest, artifacts []contracts.Artifact) error {
	requirements := make([]contracts.ConfigRequirement, 0)
	for _, artifact := range artifacts {
		requirements = append(requirements, artifact.Config...)
	}
	for id, raw := range request.Values {
		for _, requirement := range requirements {
			if requirement.ID != id {
				continue
			}
			if requirement.Secret {
				return fmt.Errorf("configuration %q is secret and must be supplied by its declared environment reference", id)
			}
			// Marketplace source credentials have a dedicated typed contract that
			// emits references. A raw sources patch could persist authToken values.
			if requirement.Path == "/marketplace/sources" {
				if err := rejectInlineMarketplaceCredentials(raw); err != nil {
					return err
				}
			}
			var value any
			if err := json.Unmarshal([]byte(raw), &value); err != nil {
				continue // The resolver reports invalid JSON with its normal diagnostic.
			}
			for _, secret := range requirements {
				if !secret.Secret || secret.Env == "" {
					continue
				}
				relative, nested := nestedConfigPath(requirement.Path, secret.Path)
				if !nested || len(relative) == 0 {
					continue
				}
				leaf, present := configAtPath(value, relative)
				if !present {
					continue
				}
				reference, isString := leaf.(string)
				if !isString || reference != "${"+secret.Env+"}" {
					return fmt.Errorf("configuration %q contains data for secret requirement %q; use exactly ${%s}", id, secret.ID, secret.Env)
				}
			}
		}
	}
	return nil
}

func rejectInlineMarketplaceCredentials(raw string) error {
	var sources []map[string]any
	if err := json.Unmarshal([]byte(raw), &sources); err != nil {
		return nil // The resolver reports malformed values with its normal diagnostic.
	}
	for _, source := range sources {
		if endpoint, ok := source["url"].(string); ok {
			parsed, err := url.Parse(endpoint)
			if err == nil && parsed.RawQuery != "" {
				return fmt.Errorf("Marketplace source URL must not contain query parameters")
			}
		}
		for _, field := range []string{"authToken", "token", "password"} {
			value, ok := source[field].(string)
			if !ok || value == "" || (strings.HasPrefix(value, "${") && strings.HasSuffix(value, "}")) {
				continue
			}
			return fmt.Errorf("Marketplace source %q contains an inline credential; use an environment reference", field)
		}
	}
	return nil
}

func nestedConfigPath(parent, child string) ([]string, bool) {
	if parent == "" || child == "" || !strings.HasPrefix(parent, "/") || !strings.HasPrefix(child, parent+"/") {
		return nil, false
	}
	segments := strings.Split(strings.TrimPrefix(child, parent+"/"), "/")
	for index, segment := range segments {
		segments[index] = strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")
	}
	return segments, true
}

func configAtPath(value any, path []string) (any, bool) {
	for _, segment := range path {
		switch current := value.(type) {
		case map[string]any:
			next, ok := current[segment]
			if !ok {
				return nil, false
			}
			value = next
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(current) {
				return nil, false
			}
			value = current[index]
		default:
			return nil, false
		}
	}
	return value, true
}
