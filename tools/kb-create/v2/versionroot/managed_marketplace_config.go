package versionroot

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

var marketplaceCredentialReference = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// managedMarketplaceCredentialRefs derives the only environment references
// the helper may receive from the owner-controlled source credentials. URLs,
// arbitrary config fields, and helper-provided names do not grant authority.
func managedMarketplaceCredentialRefs(configRoot string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(configRoot, ".kb", "kb.config.jsonc"))
	if err != nil {
		return nil, fmt.Errorf("read active Marketplace source configuration: %w", err)
	}
	var config struct {
		Marketplace struct {
			Sources []struct {
				AuthToken        string `yaml:"authToken"`
				SigningPublicKey string `yaml:"signingPublicKey"`
			} `yaml:"sources"`
		} `yaml:"marketplace"`
	}
	jsonData, err := normalizeJSONC(data)
	if err != nil {
		return nil, fmt.Errorf("parse active Marketplace source configuration: %w", err)
	}
	if err := json.Unmarshal(jsonData, &config); err != nil {
		return nil, fmt.Errorf("parse active Marketplace source configuration: %w", err)
	}
	refs := make(map[string]struct{})
	for _, source := range config.Marketplace.Sources {
		for _, setting := range []string{source.AuthToken, source.SigningPublicKey} {
			for _, match := range marketplaceCredentialReference.FindAllStringSubmatch(setting, -1) {
				refs[match[1]] = struct{}{}
			}
		}
	}
	if len(refs) > 32 {
		return nil, fmt.Errorf("Marketplace config references too many environment variables")
	}
	result := make([]string, 0, len(refs))
	for ref := range refs {
		if !validMarketplaceCredentialName(ref) {
			return nil, fmt.Errorf("Marketplace config references a prohibited environment variable")
		}
		result = append(result, ref)
	}
	sort.Strings(result)
	return result, nil
}

func normalizeJSONC(input []byte) ([]byte, error) {
	output := make([]byte, 0, len(input))
	inString, escaped := false, false
	for i := 0; i < len(input); i++ {
		ch := input[i]
		if inString {
			output = append(output, ch)
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			output = append(output, ch)
			continue
		}
		if ch == '/' && i+1 < len(input) && input[i+1] == '/' {
			i += 2
			for i < len(input) && input[i] != '\n' && input[i] != '\r' {
				i++
			}
			if i < len(input) {
				output = append(output, input[i])
			}
			continue
		}
		if ch == '/' && i+1 < len(input) && input[i+1] == '*' {
			i += 2
			closed := false
			for i+1 < len(input) {
				if input[i] == '*' && input[i+1] == '/' {
					i++
					closed = true
					break
				}
				if input[i] == '\n' || input[i] == '\r' {
					output = append(output, input[i])
				}
				i++
			}
			if !closed {
				return nil, fmt.Errorf("unterminated JSONC comment")
			}
			continue
		}
		output = append(output, ch)
	}
	if inString {
		return nil, fmt.Errorf("unterminated JSONC string")
	}
	// JSONC permits a trailing comma before a closing object or array.
	clean := make([]byte, 0, len(output))
	inString, escaped = false, false
	for i := 0; i < len(output); i++ {
		ch := output[i]
		if inString {
			clean = append(clean, ch)
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			clean = append(clean, ch)
			continue
		}
		if ch == ',' {
			j := i + 1
			for j < len(output) && (output[j] == ' ' || output[j] == '\t' || output[j] == '\n' || output[j] == '\r') {
				j++
			}
			if j < len(output) && (output[j] == '}' || output[j] == ']') {
				continue
			}
		}
		clean = append(clean, ch)
	}
	return clean, nil
}

func sameMarketplaceCredentialRefs(expected, reported []string) bool {
	if len(expected) != len(reported) {
		return false
	}
	copyReported := append([]string(nil), reported...)
	sort.Strings(copyReported)
	for i := range expected {
		if expected[i] != copyReported[i] {
			return false
		}
	}
	return true
}
