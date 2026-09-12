// Package services adapts the public kb-dev JSON protocol to V2 verification.
// It never imports kb-dev implementation code: the binary protocol is the
// compatibility boundary that remains valid after launcher cutover.
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sort"

	"github.com/kb-labs/create/v2/verify"
)

type Runner interface {
	Output(context.Context, string, ...string) ([]byte, error)
}

type combinedRunner interface {
	CombinedOutput(context.Context, string, ...string) ([]byte, error)
}

type commandRunner struct{}

func (commandRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

func (commandRunner) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// KBDev reads the public JSON emitted by `kb-dev status --json`.
type KBDev struct {
	Binary string
	Runner Runner
	// Log receives kb-dev ensure's own JSON transcript (its per-service
	// started/skipped/failed action list), successful or not. Without this,
	// a successful `kb-dev ensure` call's own view of what it did is
	// discarded — the only place V2 could later show it disagreed with a
	// subsequent `kb-dev status` snapshot (KB_CREATE_SERVICE_GRAPH_MISMATCH)
	// is this log, so it needs to survive that case, not just failures.
	Log io.Writer
}

func (client KBDev) ServiceStatuses(platformRoot string) ([]verify.ObservedService, error) {
	binary := client.binary(platformRoot)
	runner := client.Runner
	if runner == nil {
		runner = commandRunner{}
	}
	data, err := runner.Output(context.Background(), binary, "--config", filepath.Join(platformRoot, ".kb", "devservices.yaml"), "status", "--json")
	if err != nil {
		return nil, fmt.Errorf("kb-dev status: %w", err)
	}
	var response struct {
		Services map[string]struct {
			State string `json:"state"`
		} `json:"services"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("decode kb-dev status JSON: %w", err)
	}
	result := make([]verify.ObservedService, 0, len(response.Services))
	for id, service := range response.Services {
		result = append(result, verify.ObservedService{ID: id, State: service.State})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

// Ensure brings the exact resolved graph to its desired state before V2 reads
// status. The public `kb-dev ensure --json` command is idempotent and agent
// friendly; its non-zero exit is preserved as an apply failure.
func (client KBDev) Ensure(platformRoot string, serviceIDs []string) error {
	if len(serviceIDs) == 0 {
		return nil
	}
	binary := client.binary(platformRoot)
	runner := client.Runner
	if runner == nil {
		runner = commandRunner{}
	}
	// Do not pin an offset here. kb-dev resolves the project-specific offset
	// consistently for ensure, status and stop (or honours KB_NET_OFFSET), so
	// V2 never starts services on a different network from the caller.
	args := []string{"--config", filepath.Join(platformRoot, ".kb", "devservices.yaml"), "ensure"}
	args = append(args, serviceIDs...)
	args = append(args, "--json")
	var output []byte
	var err error
	if combined, ok := runner.(combinedRunner); ok {
		output, err = combined.CombinedOutput(context.Background(), binary, args...)
	} else {
		output, err = runner.Output(context.Background(), binary, args...)
	}
	if client.Log != nil && len(output) > 0 {
		_, _ = client.Log.Write(output)
		_, _ = client.Log.Write([]byte("\n"))
	}
	if err != nil {
		if len(output) > 0 {
			return fmt.Errorf("kb-dev ensure: %w: %s", err, output)
		}
		return fmt.Errorf("kb-dev ensure: %w", err)
	}
	return nil
}

func (client KBDev) Stop(platformRoot string, serviceIDs []string) error {
	if len(serviceIDs) == 0 {
		return nil
	}
	binary := client.binary(platformRoot)
	runner := client.Runner
	if runner == nil {
		runner = commandRunner{}
	}
	// `kb-dev stop` accepts one optional target, unlike `ensure`, which accepts
	// a list. Stop each resolved service explicitly so uninstall can deactivate
	// the whole graph before replacing or removing its artifacts.
	for _, serviceID := range serviceIDs {
		args := []string{"--config", filepath.Join(platformRoot, ".kb", "devservices.yaml"), "stop", serviceID, "--json"}
		if _, err := runner.Output(context.Background(), binary, args...); err != nil {
			return fmt.Errorf("kb-dev stop %s: %w", serviceID, err)
		}
	}
	return nil
}

func (client KBDev) binary(platformRoot string) string {
	if client.Binary != "" {
		return client.Binary
	}
	return filepath.Join(platformRoot, ".kb", "v2", "bin", "kb-dev")
}
