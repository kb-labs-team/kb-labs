//go:build darwin || linux

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var childBaseEnvironment = []string{
	"HOME", "PATH", "USER", "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE", "TERM", "TMPDIR", "SHELL",
}

func childEnvironment(declared []string) ([]string, error) {
	values := make(map[string]string, len(childBaseEnvironment)+len(declared))
	for _, name := range childBaseEnvironment {
		if value, ok := os.LookupEnv(name); ok {
			values[name] = value
		}
	}
	for _, entry := range declared {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || name == "" || strings.Contains(name, "=") {
			return nil, fmt.Errorf("invalid vendor child environment declaration %q", name)
		}
		values[name] = value
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	env := make([]string, 0, len(names))
	for _, name := range names {
		env = append(env, name+"="+values[name])
	}
	return env, nil
}

func vendorChildEnvironment(vendor string) ([]string, error) {
	spec, ok := vendorRegistry[vendor]
	if !ok {
		return nil, fmt.Errorf("unsupported vendor %q", vendor)
	}
	return childEnvironment(spec.childEnv)
}

func vendorWorkerEnvironment(vendor string) ([]string, error) {
	spec, ok := vendorRegistry[vendor]
	if !ok {
		return nil, fmt.Errorf("unsupported vendor %q", vendor)
	}
	declared := append([]string(nil), spec.childEnv...)
	if binary := os.Getenv(spec.binaryEnv); binary != "" {
		declared = append(declared, spec.binaryEnv+"="+binary)
	}
	if vendor == "zai" {
		keyName, err := zaiKeyFileEnvironmentName()
		if err != nil {
			return nil, err
		}
		keyFile := os.Getenv(keyName)
		if _, err := readZaiKeyFile(keyFile); err != nil {
			return nil, err
		}
		declared = append(declared, keyName+"="+keyFile)
	}
	return childEnvironment(declared)
}

func vendorAgentEnvironment(vendor string, declared []string, r AgentRequest, secret string) ([]string, error) {
	state, jobID := r.StateDir, r.JobID
	if vendor == "zcode" {
		home, ok := os.LookupEnv("HOME")
		if !ok || home == "" {
			return nil, errors.New("ZCode agent environment requires the account HOME for its login data")
		}
		values := append([]string(nil), declared...)
		values = append(values, "ZCODE_DATA_BASE_DIR="+zcodeDataBaseDir(home), "TMPDIR="+zcodeJobTemp(r))
		if r.Model != "" {
			// The ZCode CLI completes this modelId with its highest reasoning level and
			// fails the run when no configured provider serves it.
			values = append(values, "ZCODE_MODEL="+r.Model)
		}
		return childEnvironmentWithCommandShims(values, r)
	}
	if vendor != "zai" {
		return childEnvironmentWithCommandShims(declared, r)
	}
	if state == "" || jobID == "" || secret == "" {
		return nil, errors.New("z.ai agent environment requires state, job identity, and a validated key")
	}
	vendorDir := filepath.Join(state, "vendors", "zai", jobID)
	vendorHome := filepath.Join(vendorDir, "home")
	configDir := filepath.Join(vendorDir, "claude-config")
	if err := os.MkdirAll(vendorHome, 0o700); err != nil {
		return nil, fmt.Errorf("create isolated z.ai home directory: %w", err)
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, fmt.Errorf("create isolated z.ai Claude config directory: %w", err)
	}
	models := []struct {
		setting      string
		name         string
		defaultValue string
	}{
		{"ZAI_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "glm-5.3"},
		{"ZAI_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-5.3"},
		{"ZAI_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "glm-5.3-flash"},
	}
	values := append([]string(nil), declared...)
	values = append(values,
		"HOME="+vendorHome,
		"ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic",
		"ANTHROPIC_AUTH_TOKEN="+secret,
		"CLAUDE_CONFIG_DIR="+configDir,
	)
	for _, model := range models {
		value := os.Getenv(model.setting)
		if value == "" {
			value = model.defaultValue
		}
		values = append(values, model.name+"="+value)
	}
	return childEnvironmentWithCommandShims(values, r)
}

func childEnvironmentWithCommandShims(declared []string, request AgentRequest) ([]string, error) {
	if request.StateDir == "" || request.JobID == "" {
		return nil, errors.New("agent command admission requires state and job identity")
	}
	runner, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate kb-runner for command shims: %w", err)
	}
	runner, err = filepath.Abs(runner)
	if err != nil {
		return nil, fmt.Errorf("resolve kb-runner command shim target: %w", err)
	}
	shimDir, err := installCommandShims(request.StateDir, request.JobID, runner)
	if err != nil {
		return nil, fmt.Errorf("install agent command admission shims: %w", err)
	}
	path := os.Getenv("PATH")
	for _, entry := range declared {
		if name, value, ok := strings.Cut(entry, "="); ok && name == "PATH" {
			path = value
		}
	}
	return childEnvironment(append(append([]string(nil), declared...), "PATH="+shimDir+string(os.PathListSeparator)+path))
}
