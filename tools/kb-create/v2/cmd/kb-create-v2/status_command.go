package v2cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/control"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/supervisor"
	"github.com/kb-labs/create/v2/versionroot"
)

type statusCommandInput struct{ PlatformRoot, Executable string }

func executeStatus(ctx context.Context, inv statusCommandInput) (map[string]any, *diag.Diag) {
	root := inv.PlatformRoot
	if root == "" {
		root = defaultPlatformRoot()
	}
	layout, err := versionroot.ForPlatformPath(root)
	if err != nil {
		return nil, asDiag(err)
	}
	platformRoot := layout.PlatformRoot()
	active, receiptErr := receipt.Read(platformRoot)
	var shimState map[string]any
	if inv.Executable != "" {
		classification, classifyErr := shim.Classify(inv.Executable, platformRoot)
		if classifyErr != nil {
			return nil, asDiag(classifyErr)
		}
		shimState = map[string]any{"linked": classification.Kind == shim.ClassificationOwned, "owner": classification.Owner}
	}
	if receiptErr == nil && active.Plan.ServiceGraph.Profile == "client" {
		completed, err := (secrets.Store{PlatformRoot: platformRoot}).BootstrapCompleted()
		if err != nil {
			return nil, asDiag(err)
		}
		payload := map[string]any{"ok": true, "operation": "status", "installed": true, "running": false, "reachable": false, "bootstrapCompleted": completed, "profile": "client", "services": []contracts.Service{}}
		if shimState != nil {
			payload["shim"] = shimState
		}
		return payload, nil
	}
	runner, err := host.NewRecordedRunner(root)
	if err != nil {
		return nil, asDiag(err)
	}
	if _, err := (gateway.Registry{OperationRoot: root}).Read(); err != nil {
		return nil, asDiag(err)
	}
	state := runner.State
	status, err := runner.Status(ctx)
	if err != nil {
		return nil, asDiag(err)
	}
	if status.State == host.StateStopped {
		if failure := host.RegisteredPortConflict(platformRoot, "status"); failure != nil {
			return nil, failure
		}
	}
	if record, identityStatus, stale := supervisor.StaleRecord(state); stale {
		if identityStatus == host.ProcessIdentityUndetermined && record.InstallationID != "" {
			return nil, host.UndeterminedProcessIdentityFailure(state.SupervisorPID(), "supervisor", record.PID, platformRoot, host.GatewayURLForState(state))
		}
		return nil, host.StaleProcessIdentityFailure(state.SupervisorPID(), "supervisor", record.PID, platformRoot, host.GatewayURLForState(state))
	}
	installed := receiptErr == nil
	payload := map[string]any{"ok": true, "operation": "status", "host": status, "installed": installed,
		"running": status.State == host.StateRunning, "reachable": status.Healthy}
	if status.StudioURL != "" {
		payload["studioUrl"] = status.StudioURL
	}
	bootstrapCompleted, err := (secrets.Store{PlatformRoot: platformRoot}).BootstrapCompleted()
	if err != nil {
		return nil, asDiag(err)
	}
	payload["bootstrapCompleted"] = bootstrapCompleted
	if installed {
		payload["installedVersion"] = active.Plan.ServiceGraph.PlatformVersion
		if sources, err := marketplaceSourceStatus(platformRoot); err != nil {
			return nil, contracts.NewDiag(contracts.CodeApplyFailed, "The installed Marketplace source configuration could not be read.", "Run `kb-create doctor` to inspect the installation, then retry `kb-create status`.", err)
		} else if sources != nil {
			payload["marketplaceSources"] = sources
		}
	}
	if status.PlatformVersion != "" {
		payload["runningVersion"] = status.PlatformVersion
	}
	if installed {
		if pending := pendingRestart(active, status, root); pending != nil {
			payload["pendingRestart"] = pending
		}
	}
	next := "kb-create start"
	if status.State == host.StateRunning && status.Healthy {
		if status.StudioURL != "" {
			next = "Open Studio: " + status.StudioURL
		} else {
			next = "Register a project with kb-create install --project-root <path>"
		}
	}
	if inv.Executable != "" && installed && !shim.Correct(inv.Executable, platformRoot) {
		next = "kb-create install"
	}
	payload["next"] = next
	if inv.Executable != "" {
		payload["kbShimCorrect"] = shim.Correct(inv.Executable, platformRoot)
		payload["shim"] = shimState
	}
	if installed {
		payload["installation"] = map[string]any{"receiptId": active.ID, "platformVersion": active.Plan.ServiceGraph.PlatformVersion, "platformChannel": active.Plan.PlatformChannel}
	}
	if pid, ok := supervisor.LivePID(state, platformRoot); ok {
		info := map[string]any{"pid": pid}
		if client, connectErr := control.Connect(state); connectErr == nil {
			info["address"], info["version"] = client.File.Address, client.File.Version
		}
		payload["supervisor"] = info
	}
	if status.State == host.StateUnhealthy {
		return nil, contracts.NewDiag("KB_HOST_UNHEALTHY", "The host responds but is unhealthy.", "Run \"kb-create restart\" or \"kb-create doctor\".", nil)
	}
	return payload, nil
}

func marketplaceSourceStatus(platformRoot string) ([]map[string]any, error) {
	data, err := os.ReadFile(filepath.Join(platformRoot, ".kb", "kb.config.jsonc"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var config struct {
		Marketplace struct {
			Sources []struct {
				Kind             string `json:"kind"`
				URL              string `json:"url"`
				SigningPublicKey string `json:"signingPublicKey"`
				AuthToken        string `json:"authToken"`
			} `json:"sources"`
		} `json:"marketplace"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	if len(config.Marketplace.Sources) == 0 {
		return nil, nil
	}
	status := make([]map[string]any, 0, len(config.Marketplace.Sources))
	for _, source := range config.Marketplace.Sources {
		status = append(status, map[string]any{
			"kind": source.Kind, "url": source.URL,
			"signingKeyConfigured": source.SigningPublicKey != "",
			"authTokenConfigured":  source.AuthToken != "",
		})
	}
	return status, nil
}
