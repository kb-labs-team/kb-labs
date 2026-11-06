package v2cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/diag"
	sharedtoolchain "github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/logs"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/telemetry"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/versionroot"
)

type updateCommandResult struct {
	OK                        bool                      `json:"ok"`
	Operation                 string                    `json:"operation"`
	Receipt                   contracts.InstallReceipt  `json:"receipt"`
	Snapshot                  map[string]any            `json:"snapshot"`
	HostRestarted             bool                      `json:"hostRestarted"`
	AlreadyUpToDate           bool                      `json:"alreadyUpToDate,omitempty"`
	UpdateSummary             *contracts.UpdateSummary  `json:"updateSummary,omitempty"`
	PendingRestart            *contracts.PendingRestart `json:"pendingRestart,omitempty"`
	LogPath                   string                    `json:"logPath"`
	ProjectRegistrationNotice string                    `json:"projectRegistrationNotice,omitempty"`
}

type updateCommandInput struct {
	Index, RequestFile, ScenarioID, Answers string
	Direct                                  directRequest
	RetryCommand                            string
	Resume                                  bool
	Executable, SecretEnv                   string
	ArtifactRunner                          artifacts.Runner
	TelemetryEndpoint                       string
	TelemetryConsent                        bool
	Arguments                               []string
}

func updateActivationRetryHint(input updateCommandInput) string {
	return "the installed version is unchanged; inspect permissions and rerun `" + input.RetryCommand + "`"
}

func executeUpdate(ctx context.Context, input updateCommandInput, commandDeps commandDependencies) (updateCommandResult, *diag.Diag) {
	if err := commandDeps.NodeCheck(); err != nil {
		return updateCommandResult{}, sharedtoolchain.NodeCheckDiagnostic(err)
	}
	if input.Direct.MarketplaceRegistryURL == "" && input.Direct.MarketplaceSigningKeyEnv == "" && input.Direct.MarketplaceTokenEnv == "" && input.Direct.MarketplaceNpmURL == "" {
		root := input.Direct.PlatformRoot
		if root == "" {
			root = defaultPlatformRoot()
		}
		if layout, err := versionroot.ForPlatformPath(root); err == nil {
			if active, readErr := receipt.Read(layout.PlatformRoot()); readErr == nil && active.Plan.Request.MarketplaceSources != nil {
				sources := active.Plan.Request.MarketplaceSources
				input.Direct.MarketplaceRegistryURL = sources.RegistryURL
				input.Direct.MarketplaceSigningKeyEnv = sources.SigningPublicKeyEnv
				input.Direct.MarketplaceTokenEnv = sources.RegistryTokenEnv
				input.Direct.MarketplaceNpmURL = sources.NpmURL
			}
		}
	}
	resolved, failure := resolvePlan(planInput{Operation: "update", Index: input.Index, RequestFile: input.RequestFile, Direct: input.Direct,
		ScenarioID: input.ScenarioID, Answers: input.Answers, Resume: input.Resume, Executable: input.Executable, Arguments: input.Arguments})
	if failure != nil {
		return updateCommandResult{}, failure
	}
	plan := resolved.Plan
	secretIDs := make([]string, 0)
	for _, mapping := range splitSecretMappings(input.SecretEnv) {
		secretIDs = append(secretIDs, mapping[0])
	}
	if failure := resolve.ValidateSecretInputIDs(plan.Artifacts, secretIDs); failure != nil {
		return updateCommandResult{}, asDiag(failure)
	}
	layout, layoutErr := versionroot.ForPlatformPath(plan.Request.PlatformRoot)
	if layoutErr == nil {
		layoutErr = layout.Validate()
	}
	if layoutErr != nil {
		return updateCommandResult{}, unsupportedPlatformLayout(plan.Request.PlatformRoot, layoutErr)
	}
	platformRoot := layout.PlatformRoot()
	active, err := receipt.Read(platformRoot)
	if err != nil {
		if failure := receiptArtifactIdentityFailure(err, input.Index, plan.Request.PlatformRoot); failure != nil {
			return updateCommandResult{}, failure
		}
		failure := contracts.NewDiag(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err)
		return updateCommandResult{}, failure
	}
	activeRoot, err := layout.Active()
	if err != nil {
		return updateCommandResult{}, unsupportedPlatformLayout(plan.Request.PlatformRoot, err)
	}
	if _, err := (secrets.Store{PlatformRoot: activeRoot, ReadOnly: true}).BootstrapCompleted(); err != nil {
		return updateCommandResult{}, asDiag(err)
	}
	secretStore := secrets.Store{PlatformRoot: activeRoot, ReadOnly: true}
	if failure := refuseUpdateSecretChanges(input, layout.InstallRoot(), secretStore); failure != nil {
		return updateCommandResult{}, failure
	}
	disposition, err := resolve.ValidateUpdate(active, plan, resolved.Catalog)
	if err != nil {
		return updateCommandResult{}, asDiag(err)
	}
	if disposition == resolve.UpdateAlreadyUpToDate {
		registrationNotice, noticeErr := completedBootstrapProjectNotice(active, active.Plan.Request.ProjectRoot, false)
		if noticeErr != nil {
			return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
				"the project registration state could not be read", "check platform-root permissions, then rerun `"+contracts.ShellCommand("kb-create", "update", "--platform-root", platformRoot)+"`", noticeErr)
		}
		return updateCommandResult{OK: true, Operation: "update", Receipt: active, HostRestarted: false, AlreadyUpToDate: true,
			ProjectRegistrationNotice: registrationNotice}, nil
	}
	plan, failure = planUpdateWithMarketplaceLock(activeRoot, plan, resolved.Catalog, input.RetryCommand)
	if failure != nil {
		return updateCommandResult{}, failure
	}
	resolved.Plan = plan
	request, changed, err := requestWithGeneratedSecrets(plan.Request, plan.Artifacts)
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "the install request could not include generated secrets.", "rerun `kb-create install` with the selected platform manifest", err)
	}
	if changed {
		encoded, marshalErr := json.Marshal(request)
		if marshalErr != nil {
			return updateCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "the update request could not be encoded", "rerun `kb-create update` with the same request", marshalErr)
		}
		response := transport.PlanWith(encoded, resolved.Catalog, resolve.Options{LauncherVersion: buildVersion, Operation: resolve.OperationUpdate, BinarySource: plan.BinarySource, Registry: plan.Registry})
		if !response.OK {
			return updateCommandResult{}, response.Error
		}
		plan = *response.Plan
	}
	if failure := requireUpdateSecrets(active, plan, secretStore, input, layout.InstallRoot()); failure != nil {
		return updateCommandResult{}, failure
	}
	updateSummary, err := resolve.SummarizeUpdate(active, plan, resolved.Catalog)
	if err != nil {
		failure := contracts.NewDiag(contracts.CodeOperationFailed, "the installed platform could not be compared with the resolved update", "verify the active receipt and sealed release index, then rerun `kb-create update`", err)
		return updateCommandResult{}, failure
	}
	if running := refuseForeignHost(plan.Request.PlatformRoot); running != nil {
		return updateCommandResult{}, running
	}
	installRoot := plan.Request.PlatformRoot
	lifecycleState, err := host.StateForRoot(installRoot)
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "The installation lifecycle state path could not be resolved.", "Pass the install root used by this installation, then rerun `kb-create update`.", err)
	}
	result, failure := runUpdateCommand(ctx, input, installRoot, plan, lifecycleState, resolved.State, commandDeps.Runtime)
	if failure != nil {
		return updateCommandResult{}, failure
	}
	result.UpdateSummary = &updateSummary
	return result, nil
}

func planUpdateWithMarketplaceLock(activeRoot string, plan contracts.ResolvedInstallPlan,
	source catalog.Catalog, retryCommand string) (contracts.ResolvedInstallPlan, *diag.Diag) {
	request := plan.Request
	changed, err := marketplace.PreserveInstalledComponents(activeRoot, &request)
	if err != nil {
		doctor := contracts.ShellCommand("kb-create", "doctor", "--platform-root", activeRoot, "--json")
		failure := contracts.NewDiag(contracts.CodeOperationFailed,
			"the active marketplace installation could not be read for update staging",
			"inspect the installation with `"+doctor+"`, then retry `"+retryCommand+"`", err)
		return contracts.ResolvedInstallPlan{}, failure
	}
	if !changed {
		return plan, nil
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		failure := contracts.NewDiag(contracts.CodeOperationFailed,
			"the update request with installed marketplace packages could not be encoded",
			"retry `"+retryCommand+"` with the same request", err)
		return contracts.ResolvedInstallPlan{}, failure
	}
	response := transport.PlanWith(encoded, source, resolve.Options{LauncherVersion: buildVersion, Operation: resolve.OperationUpdate, BinarySource: plan.BinarySource, Registry: plan.Registry})
	if !response.OK {
		return contracts.ResolvedInstallPlan{}, response.Error
	}
	return *response.Plan, nil
}

func updateSecretDiagnostic(root, secret, index, requestFile string) *diag.Diag {
	stopCommand := contracts.ShellCommand("kb-create", "stop", "--platform-root", root)
	applyArgs := []string{"kb-create", "apply", "--platform-root", root}
	if index != "" {
		applyArgs = append(applyArgs, "--index", index)
	}
	if requestFile != "" {
		applyArgs = append(applyArgs, "--input", requestFile)
	}
	applyArgs = append(applyArgs, "--secret-env", secret+"=ENV_VAR")
	command := stopCommand + " && " + contracts.ShellCommand(applyArgs...)
	failure := contracts.NewDiag(contracts.CodeUpdateSecretRefused,
		"Update cannot create or change installation secret "+secret+".",
		"Set the environment variable configured for this secret to the intended value, then run `"+command+"`.", nil)
	failure.Meta = map[string]any{"secret": secret}
	return failure
}

func refuseUpdateSecretChanges(input updateCommandInput, root string, store secrets.Store) *diag.Diag {
	for _, mapping := range splitSecretMappings(input.SecretEnv) {
		name, environment := mapping[0], mapping[1]
		if environment == "" {
			return contracts.NewDiag(contracts.CodeSecretInputInvalid, "secret mapping is invalid", "use --secret-env requirement=ENV_VAR", nil)
		}
		value, present := os.LookupEnv(environment)
		if !present || value == "" {
			return contracts.NewDiag(contracts.CodeSecretInputInvalid, "the mapped secret environment value is missing", "set the environment variable configured for this secret, then rerun `kb-create update`", nil)
		}
		stored, exists, err := store.Get(name)
		if err != nil {
			if errors.Is(err, secrets.ErrUnsupportedSecretStoreFormat) {
				return asDiag(err)
			}
			failure := contracts.NewDiag(contracts.CodeUpdateSecretRefused, "the stored installation secret could not be compared", "run `kb-create doctor` before changing installation secrets", err)
			failure.Meta = map[string]any{"secret": name}
			return failure
		}
		if !exists || stored != value {
			return updateSecretDiagnostic(root, name, input.Index, input.RequestFile)
		}
	}
	return nil
}

func requireUpdateSecrets(active contracts.InstallReceipt, plan contracts.ResolvedInstallPlan, store secrets.Store, input updateCommandInput, root string) *diag.Diag {
	previouslyRequired := make(map[string]struct{}, len(active.Plan.Request.SecretInputs))
	for _, secret := range active.Plan.Request.SecretInputs {
		previouslyRequired[secret] = struct{}{}
	}
	for _, secret := range plan.Request.SecretInputs {
		if _, alreadyOwned := previouslyRequired[secret]; alreadyOwned {
			continue
		}
		exists, err := store.Exists(secret)
		if err != nil {
			failure := contracts.NewDiag(contracts.CodeApplyFailed,
				"the installation secret store could not be read during update",
				"run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root, "--json")+"` to inspect the installation, then retry `"+input.RetryCommand+"`.", err)
			failure.Meta = map[string]any{"secret": secret}
			return failure
		}
		if !exists {
			return updateSecretDiagnostic(root, secret, input.Index, input.RequestFile)
		}
	}
	return nil
}

// runUpdateCommand stages and verifies a complete version root before the
// stable platform path is atomically switched to it.
func runUpdateCommand(ctx context.Context, input updateCommandInput, installRoot string, plan contracts.ResolvedInstallPlan, state, launcherState host.State, runtimeOverrides *runtime.Dependencies) (commandResult updateCommandResult, failure *diag.Diag) {
	requestRoot := plan.Request.PlatformRoot
	layout, err := versionroot.ForPlatformPath(installRoot)
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeInstallLayoutUnsupported, "The install root cannot use the required atomic layout.", "Run `"+contracts.ShellCommand("kb-create", "install", "--platform-root", "NEW_ROOT")+"` on Linux or macOS.", err)
	}
	root := layout.PlatformRoot()
	previousReceipt, err := receipt.Read(root)
	if err != nil {
		failure := contracts.NewDiag(contracts.CodeReceiptUnavailable, "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err)
		return updateCommandResult{}, failure
	}
	runner, err := host.NewRunner(installRoot)
	if err != nil {
		return updateCommandResult{}, asDiag(err)
	}
	checkCtx, cancelCheck := context.WithTimeout(context.Background(), 5*time.Second)
	priorHost, err := runner.Status(checkCtx)
	cancelCheck()
	if err != nil {
		return updateCommandResult{}, asDiag(err)
	}
	started := time.Now()
	outcome, errorCode := "failure", "KB_INSTALL_OPERATION_FAILED"
	defer func() {
		telemetry.Send(input.TelemetryEndpoint, input.TelemetryConsent, telemetry.New("update", outcome, errorCode,
			string(plan.Request.Platform.Channel), string(plan.Request.Source), len(plan.Artifacts), time.Since(started)))
	}()
	correlationID := fmt.Sprintf("update-%d", time.Now().UTC().UnixNano())
	if runtimeOverrides != nil && runtimeOverrides.CorrelationID != "" {
		correlationID = runtimeOverrides.CorrelationID
	}
	stage, err := layout.Stage()
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeOperationFailed, "the update could not create an isolated version root", "free disk space or fix platform-root permissions, then rerun `kb-create update`", err)
	}
	activated := false
	defer func() {
		if !activated {
			if cleanupErr := os.RemoveAll(stage); cleanupErr != nil {
				failure = contracts.NewDiag(contracts.CodeOperationFailed,
					"the failed update could not remove its staged version root",
					updateActivationRetryHint(input), errors.Join(failure, cleanupErr))
				commandResult = updateCommandResult{}
			}
		}
	}()
	plan.Request.PlatformRoot = stage
	activeRoot, err := layout.Active()
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeInstallLayoutUnsupported, "The active version root could not be resolved for read-only update inputs.", "Run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", installRoot)+"` before retrying the update.", err)
	}
	store := secrets.Store{PlatformRoot: activeRoot, ReadOnly: true}
	redactions, err := secretRedactionValues(store, plan, input.SecretEnv)
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the installation secret state could not be read for safe logging", "run `kb-create doctor` before retrying the update", err)
	}
	transcript, err := logs.New(layout.OperationLogsDir(), correlationID, redactions)
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag("KB_INSTALL_LOG_UNAVAILABLE", "could not create local operation log", "check that the staged version root is writable", err)
	}
	defer transcript.Close()
	release, err := state.AcquireOperation("update")
	if err != nil {
		return updateCommandResult{}, asDiag(err)
	}
	defer release()
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	offline := plan.Request.Source == contracts.SourceOffline
	installer, err := newArtifactExecutor(layout, stage, plan.Registry, offline, transcript, input.ArtifactRunner)
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeInstallLayoutUnsupported, "the shared artifact cache path could not be resolved", "run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", installRoot)+"` before retrying the update", err)
	}
	deps := runtime.Dependencies{Artifacts: installer, CorrelationID: correlationID, Secrets: &store}
	deps.PreserveGeneratedConfig = true
	deps.VerificationConfigRoot = activeRoot
	deps.MarketplaceLockSourceRoot = activeRoot
	if runtimeOverrides != nil {
		if runtimeOverrides.Artifacts != nil {
			deps.Artifacts = runtimeOverrides.Artifacts
		}
		if runtimeOverrides.Clock != nil {
			deps.Clock = runtimeOverrides.Clock
		}
		if runtimeOverrides.Secrets != nil {
			readOnly := *runtimeOverrides.Secrets
			readOnly.ReadOnly = true
			deps.Secrets = &readOnly
		}
		deps.Progress = runtimeOverrides.Progress
		deps.PreserveGeneratedConfig = true
	}
	deps.Host = nil
	// Staging verification is deliberately offline. A second host would bind
	// the same service ports and open the live project state.
	var updated contracts.InstallReceipt
	var snapshot contracts.Snapshot
	if ctx == nil {
		ctx = context.Background()
	}
	updated, snapshot, err = runtime.Update(ctx, plan, deps)
	if err != nil {
		return updateCommandResult{}, applyDossier(stage, correlationID, transcript.Path(), plan, redactions, err)
	}
	updated.Plan.Request.PlatformRoot = requestRoot
	if err := receipt.Write(stage, updated); err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the verified update receipt could not be finalized", "inspect the staged operation log, then rerun `kb-create update`", err)
	}
	if err := shim.EnsureVersionTarget(root, stage); err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
			"the verified update could not prepare the kb command for the new version",
			updateActivationRetryHint(input), err)
	}
	if _, err := receipt.Read(stage); err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
			"the verified update receipt could not be read back before activation",
			"inspect the staged operation log, then rerun `kb-create update`", err)
	}
	logRelative, err := filepath.Rel(installRoot, transcript.Path())
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the update operation log is outside the installation container", "inspect the staged update and rerun `kb-create update`", err)
	}
	transcriptPath := transcript.Path()
	registrationNotice, noticeErr := completedBootstrapProjectNotice(previousReceipt, previousReceipt.Plan.Request.ProjectRoot, false)
	if noticeErr != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
			"the project registration state could not be read", "check platform-root permissions, then rerun `"+contracts.ShellCommand("kb-create", "update", "--platform-root", installRoot)+"`", noticeErr)
	}
	runningRoot := ""
	if priorHost.PID > 0 {
		runningRoot = priorHost.TreeRoot
	}
	statusCtx, cancelStatus := context.WithTimeout(context.Background(), 5*time.Second)
	running, err := runner.Status(statusCtx)
	cancelStatus()
	if err != nil {
		return updateCommandResult{}, asDiag(err)
	}
	activate := func() error {
		_, activateErr := layout.ActivateUpdate(stage, updated.Plan.ServiceGraph.PlatformVersion, updated.Plan.PlanHash, runningRoot,
			versionroot.UpdateMetadata{SnapshotID: snapshot.ID, LogPath: logRelative})
		return activateErr
	}
	if updated.Plan.Host != nil {
		origin, originErr := gateway.OriginFromHealthURL(updated.Verification.HostHealthURL)
		if originErr != nil {
			return updateCommandResult{}, contracts.HostSpecDiagnostic("the updated Gateway address could not be recorded", "rerun `"+contracts.ShellCommand("kb-create", "update", "--platform-root", installRoot)+"` after checking the receipt", originErr.Error(), originErr)
		}
		registry := gateway.Registry{OperationRoot: installRoot}
		err = registry.Writer(gateway.Update).RegisterForTransaction(root, origin, activate)
	} else {
		err = activate()
	}
	if err != nil {
		return updateCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the verified update could not be atomically activated", updateActivationRetryHint(input), err)
	}
	activated = true
	outcome, errorCode = "success", ""
	return updateCommandResult{OK: true, Operation: "update", Receipt: updated, Snapshot: snapshotSummary(snapshot), HostRestarted: false,
		PendingRestart: pendingRestart(updated, running, installRoot), LogPath: transcriptPath,
		ProjectRegistrationNotice: registrationNotice}, nil
}
