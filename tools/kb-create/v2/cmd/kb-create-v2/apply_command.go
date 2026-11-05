package v2cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/clikit/diag"
	sharedtoolchain "github.com/kb-labs/clikit/toolchain"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/logs"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/preflight"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/telemetry"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/versionroot"
)

type applyCommandInput struct {
	Plan                       planInput
	Resolved                   *resolvedPlan
	Arguments                  []string
	SecretEnv                  string
	PendingSecrets             map[string]secrets.PendingSecret
	Executable                 string
	Progress                   runtime.ProgressSink
	JSON                       bool
	TelemetryEndpoint          string
	TelemetryConsent           bool
	AllowBootstrapRegistration bool
}

func secretRedactionValues(store secrets.Store, plan contracts.ResolvedInstallPlan, mappings string) ([]string, error) {
	values := make([]string, 0)
	seen := make(map[string]struct{})
	add := func(value string) {
		if value == "" {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	for _, artifact := range plan.Artifacts {
		for _, requirement := range artifact.Config {
			if !requirement.Secret {
				continue
			}
			add(requirement.ID)
			add(requirement.Env)
			value, present, err := store.Get(requirement.ID)
			if err != nil {
				return nil, err
			}
			if present {
				add(value)
			}
		}
	}
	for _, mapping := range splitSecretMappings(mappings) {
		add(mapping[0])
		add(mapping[1])
	}
	return values, nil
}

func executeApply(ctx context.Context, applyInput applyCommandInput, deps commandDependencies) (applyCommandResult, *diag.Diag) {
	return applyPlan(ctx, applyInput, deps)
}

func applyPlan(ctx context.Context, input applyCommandInput, deps commandDependencies) (applyCommandResult, *diag.Diag) {
	if err := deps.NodeCheck(); err != nil {
		return applyCommandResult{}, sharedtoolchain.NodeCheckDiagnostic(err)
	}
	started := time.Now()
	outcome, errorCode := "failure", "KB_INSTALL_OPERATION_FAILED"
	var planned contracts.ResolvedInstallPlan
	defer func() {
		telemetry.Send(input.TelemetryEndpoint, input.TelemetryConsent, telemetry.New("apply", outcome, errorCode,
			string(planned.Request.Platform.Channel), string(planned.Request.Source), len(planned.Artifacts), time.Since(started)))
	}()
	resolved := input.Resolved
	if resolved == nil {
		result, failure := resolvePlan(input.Plan)
		if failure != nil {
			return applyCommandResult{}, failure
		}
		resolved = &result
	}
	planned = resolved.Plan
	secretIDs := make([]string, 0)
	for _, mapping := range splitSecretMappings(input.SecretEnv) {
		secretIDs = append(secretIDs, mapping[0])
	}
	for id := range input.PendingSecrets {
		secretIDs = append(secretIDs, id)
	}
	if failure := resolve.ValidateSecretInputIDs(planned.Artifacts, secretIDs); failure != nil {
		return applyCommandResult{}, asDiag(failure)
	}
	root := planned.Request.PlatformRoot
	installRoot := root
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeOperationFailed, "the platform root could not be resolved", "check the install path, then rerun `kb-create install`", layoutErr)
	}
	initialInstall := false
	operationRoot := root
	platformRoot := root
	initialStage := ""
	platformRoot = layout.PlatformRoot()
	if err := layout.PrepareInitialTarget(); err != nil {
		return applyCommandResult{}, unsupportedPlatformLayout(root, err)
	}
	if _, receiptErr := receipt.Read(platformRoot); receiptErr != nil {
		if !os.IsNotExist(receiptErr) {
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeReceiptUnavailable, "the active receipt could not be read", "run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)+"` before reinstalling", receiptErr)
		}
		if _, activeErr := receipt.Read(layout.PlatformRoot()); activeErr == nil {
			if err := layout.Validate(); err != nil {
				return applyCommandResult{}, unsupportedPlatformLayout(root, err)
			}
			platformRoot = layout.PlatformRoot()
			operationRoot = platformRoot
			planned.Request.PlatformRoot = platformRoot
		} else if !os.IsNotExist(activeErr) {
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeReceiptUnavailable, "the recovered active receipt could not be read", "run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)+"` before reinstalling", activeErr)
		} else {
			stage, stageErr := layout.StageInitial()
			if stageErr != nil {
				return applyCommandResult{}, unsupportedPlatformLayout(root, stageErr)
			}
			initialStage = stage
			initialInstall = true
			operationRoot = initialStage
			planned.Request.PlatformRoot = initialStage
		}
	} else if err := layout.Validate(); err != nil {
		return applyCommandResult{}, unsupportedPlatformLayout(root, err)
	} else {
		platformRoot = layout.PlatformRoot()
		activeRoot, activeErr := layout.Active()
		if activeErr != nil {
			return applyCommandResult{}, unsupportedPlatformLayout(root, activeErr)
		}
		operationRoot = activeRoot
		planned.Request.PlatformRoot = activeRoot
	}
	initialActivated := false
	if initialStage != "" {
		defer func() {
			if !initialActivated {
				_ = os.RemoveAll(initialStage)
			}
		}()
	}
	state, err := host.StateForRoot(installRoot)
	if err != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "The installation lifecycle state path could not be resolved.", "Pass the install root used by this installation, then rerun `kb-create install`.", err)
	}
	if !initialInstall {
		if _, failure := existingProjectSelection(platformRoot, planned.Request.ProjectRoot); failure != nil {
			return applyCommandResult{}, failure
		}
	}
	release, err := state.AcquireOperation("apply")
	if err != nil {
		return applyCommandResult{}, asDiag(err)
	}
	defer release()
	request, changed, err := requestWithGeneratedSecrets(planned.Request, planned.Artifacts)
	if err != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired,
			"The install request could not include generated secrets.", "rerun `kb-create install` with the selected platform manifest", err)
	}
	if changed {
		encoded, marshalErr := json.Marshal(request)
		if marshalErr != nil {
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired, "the install request could not be encoded", "rerun `kb-create apply` with the same request", marshalErr)
		}
		response := transport.PlanWith(encoded, resolved.Catalog, resolve.Options{LauncherVersion: buildVersion, BinarySource: planned.BinarySource, Registry: planned.Registry})
		if !response.OK {
			return applyCommandResult{}, response.Error
		}
		planned = *response.Plan
	}
	reusedHost, running := reusableApplyHost(planned, installRoot)
	if running != nil {
		return applyCommandResult{}, running
	}
	if err := preflight.CheckInstallResources(operationRoot); err != nil {
		var typed *diag.Diag
		if errors.As(err, &typed) {
			return applyCommandResult{}, typed
		}
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeResourceCheckFailed,
			"The launcher could not check available memory and disk space.",
			"Check that the platform root is on a mounted writable filesystem, then run `kb-create install` again.", err)
	}
	if planned.Host != nil {
		if err := host.CheckPorts(planned, "apply"); err != nil {
			return applyCommandResult{}, asDiag(err)
		}
	}
	correlationID := fmt.Sprintf("apply-%d", time.Now().UTC().UnixNano())
	store := secrets.Store{PlatformRoot: operationRoot}
	if err := storePendingSecrets(store, input.PendingSecrets); err != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeSecretInputInvalid, "secret input could not be stored", "verify the declared secret inputs, then rerun `kb-create install`", err)
	}
	if err := populateSecrets(store, input.SecretEnv); err != nil {
		if errors.Is(err, secrets.ErrUnsupportedSecretStoreFormat) {
			return applyCommandResult{}, asDiag(err)
		}
		if errors.Is(err, secrets.ErrBootstrapCredentialLocked) {
			return applyCommandResult{}, asDiag(err)
		}
		if errors.Is(err, secrets.ErrBootstrapPasswordDisclosed) {
			adminEmail, _ := configuredFirstAdmin(planned.Request)
			recovery := buildFirstAdminRecoveryCommands(root, adminEmail)
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeInputRequired,
				"the first-administrator password was already disclosed and cannot be stored again",
				"Run `"+recovery.Stop+"`, then `"+recovery.Doctor+"`, then `"+recovery.Start+"` to generate and disclose a replacement.", nil)
		}
		return applyCommandResult{}, contracts.NewDiag("KB_INSTALL_SECRET_INPUT_INVALID", "secret input could not be stored", "use --secret-env requirement=ENV_VAR and set the environment variable", err)
	}
	adminEmail, securedAdmin := configuredFirstAdmin(planned.Request)
	bootstrapCompleted := false
	if securedAdmin {
		var existsErr error
		bootstrapCompleted, existsErr = store.BootstrapCompleted()
		if existsErr != nil {
			if errors.Is(existsErr, secrets.ErrUnsupportedSecretStoreFormat) {
				return applyCommandResult{}, asDiag(existsErr)
			}
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the first administrator password could not be read from the secret store", "check that the platform root is writable, then rerun `kb-create install`", existsErr)
		}
	}
	if err := secrets.EnsureGenerated(&planned, store); err != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
			"the session signing secret could not be generated or stored.",
			"check that the platform root is writable, then rerun `kb-create install`", err)
	}
	redactions, err := secretRedactionValues(store, planned, input.SecretEnv)
	if err != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the installation secret state could not be read for safe logging", "check that the platform root is writable, then rerun `kb-create install`", err)
	}
	transcript, err := logs.New(layout.OperationLogsDir(), correlationID, redactions)
	if err != nil {
		return applyCommandResult{}, contracts.NewDiag("KB_INSTALL_LOG_UNAVAILABLE", "could not create local operation log", "check that the platform root is writable", err)
	}
	defer transcript.Close()
	if ctx == nil {
		ctx = context.Background()
	}
	applyCtx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	offline := planned.Request.Source == contracts.SourceOffline
	artifactExecutor, err := newArtifactExecutor(layout, operationRoot, planned.Registry, offline, transcript, deps.ArtifactRunner)
	if err != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeInstallLayoutUnsupported,
			"the shared artifact cache path could not be resolved",
			"run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", installRoot)+"` before retrying the install", err)
	}
	prober := host.Prober{PlatformRoot: installRoot, Operation: "apply"}
	runtimeDeps := runtime.Dependencies{Artifacts: artifactExecutor, CorrelationID: correlationID, Secrets: &store, Progress: input.Progress}
	if deps.Runtime != nil {
		if deps.Runtime.Artifacts != nil {
			runtimeDeps.Artifacts = deps.Runtime.Artifacts
		}
		if deps.Runtime.Host != nil {
			runtimeDeps.Host = deps.Runtime.Host
		}
		if deps.Runtime.Clock != nil {
			runtimeDeps.Clock = deps.Runtime.Clock
		}
		if deps.Runtime.Secrets != nil {
			runtimeDeps.Secrets = deps.Runtime.Secrets
		}
		if deps.Runtime.Progress != nil {
			runtimeDeps.Progress = deps.Runtime.Progress
		}
	}
	if runtimeDeps.Host == nil && planned.Host != nil {
		if !initialInstall && reusedHost == nil {
			runtimeDeps.Host = prober
		}
	}
	postInstallStarter := runtimeDeps.Host
	if initialInstall {
		runtimeDeps.Host = nil
	}
	if securedAdmin && !bootstrapCompleted && runtimeDeps.Host != nil {
		runtimeDeps.Host = bootstrapOutcomeHost{starter: runtimeDeps.Host, store: store}
	}
	applied, applyErr := runtime.Apply(applyCtx, planned, runtimeDeps)
	if applyErr != nil {
		diagnostic := applyDossier(root, correlationID, transcript.Path(), planned, redactions, applyErr)
		arguments := input.Arguments
		if len(arguments) == 0 {
			arguments = input.Plan.Arguments
		}
		if len(arguments) > 0 {
			invocation, variables := retryArguments(arguments)
			diagnostic.Hint += " Retry: " + invocation
			for _, variable := range variables {
				diagnostic.Hint += " Set " + variable + " before retrying."
			}
		}
		return applyCommandResult{}, diagnostic
	}
	if reusedHost != nil {
		applied.ID = reusedHost.ID
		applied.CreatedAt = reusedHost.CreatedAt
		applied.InstallationID = reusedHost.InstallationID
		if err := receipt.Write(operationRoot, applied); err != nil {
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeReceiptUnavailable,
				"the running host identity could not be preserved in the active receipt.",
				"run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", installRoot)+"` and repair the active receipt before retrying.", err)
		}
	}
	var firstAdmin *firstAdminCredential
	if initialInstall {
		if _, err := layout.ActivateInitial(initialStage, applied.Plan.ServiceGraph.PlatformVersion, applied.Plan.PlanHash); err != nil {
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the verified first installation could not be atomically activated", "the stable platform path remains unchanged; inspect permissions and rerun `kb-create install`", err)
		}
		initialActivated = true
		platformRoot = layout.PlatformRoot()
		activeRoot, activeErr := layout.Active()
		if activeErr != nil {
			return applyCommandResult{}, unsupportedPlatformLayout(root, activeErr)
		}
		store = secrets.Store{PlatformRoot: activeRoot}
		applied.Plan.Request.PlatformRoot = installRoot
		if err := receipt.Write(platformRoot, applied); err != nil {
			return applyCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed, "the activated installation receipt could not be finalized", "run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)+"` and resolve the reported layout issue", err)
		}
		if planned.Host != nil {
			starter := postInstallStarter
			if starter == nil {
				starter = installedHostStarter{root: installRoot, executable: input.Executable}
			}
			if securedAdmin && !bootstrapCompleted {
				starter = bootstrapOutcomeHost{starter: starter, store: store}
			}
			if runtimeDeps.Progress != nil {
				if err := runtimeDeps.Progress.Emit(runtime.ProgressEvent{Phase: "Start host", Start: true}); err != nil {
					return applyCommandResult{}, progressWriteFailure(err, "apply")
				}
			}
			_, startErr := starter.Start(applyCtx, *planned.Host)
			if runtimeDeps.Progress != nil {
				startErr = errors.Join(startErr, runtimeDeps.Progress.Emit(runtime.ProgressEvent{Phase: "Start host"}))
			}
			if startErr != nil {
				return applyCommandResult{}, installHostFailure(root, startErr)
			}
		}
	} else {
		applied.Plan.Request.PlatformRoot = platformRoot
	}
	if specs := applied.Plan.Request.MarketplaceInstallSpecs; len(specs) > 0 {
		installer := deps.Marketplace
		if installer == nil {
			installer = marketplace.GatewayInstallClient{}
		}
		if marketplaceFailure := installMarketplaceScenarioPlugins(applyCtx, platformRoot, &applied, installer); marketplaceFailure != nil {
			return applyCommandResult{}, marketplaceFailure
		}
	}
	if planned.Host != nil {
		roots := make([]gateway.Root, 0, 2)
		if owner, ok := shim.Owner(input.Executable); ok && !shim.Correct(input.Executable, platformRoot) {
			ownerLayout, layoutErr := versionroot.ForPlatformPath(owner)
			if layoutErr == nil {
				if activeOwner, ownerErr := receipt.Read(ownerLayout.PlatformRoot()); ownerErr == nil {
					if ownerURL := recordedGatewayURL(activeOwner); ownerURL != "" {
						roots = append(roots, gateway.Root{PlatformRoot: ownerLayout.PlatformRoot(), URL: ownerURL})
					}
				}
			}
		}
		origin, originErr := gateway.OriginFromHealthURL(applied.Verification.HostHealthURL)
		if originErr != nil {
			return applyCommandResult{}, contracts.HostSpecDiagnostic("the applied Gateway address could not be recorded", "rerun `"+contracts.ShellCommand("kb-create", "update", "--platform-root", root)+"` after checking the receipt", originErr.Error(), originErr)
		}
		roots = append(roots, gateway.Root{PlatformRoot: platformRoot, URL: origin})
		if err := (gateway.Registry{OperationRoot: root}).Writer(gateway.Apply).RegisterMany(roots); err != nil {
			return applyCommandResult{}, asDiag(err)
		}
	}
	var shimResult shim.EnsureResult
	if input.Executable != "" {
		if runtimeDeps.Progress != nil {
			if err := runtimeDeps.Progress.Emit(runtime.ProgressEvent{Phase: "Create kb shim", Start: true}); err != nil {
				return applyCommandResult{}, progressWriteFailure(err, "apply")
			}
		}
		var shimErr error
		shimResult, shimErr = shim.Ensure(input.Executable, platformRoot)
		if shimErr != nil {
			if runtimeDeps.Progress != nil {
				shimErr = errors.Join(shimErr, runtimeDeps.Progress.Emit(runtime.ProgressEvent{Phase: "Create kb shim"}))
			}
			return applyCommandResult{}, shimFailure("KB_INSTALL_APPLY_FAILED", root, shimErr)
		}
		if runtimeDeps.Progress != nil {
			if err := runtimeDeps.Progress.Emit(runtime.ProgressEvent{Phase: "Create kb shim"}); err != nil {
				return applyCommandResult{}, progressWriteFailure(err, "status")
			}
		}
	}
	outcome, errorCode = "success", ""
	logPath := transcript.Path()
	if initialActivated {
		if activeRoot, activeErr := layout.Active(); activeErr == nil {
			if relative, relErr := filepath.Rel(operationRoot, transcript.Path()); relErr == nil {
				logPath = filepath.Join(activeRoot, relative)
			}
		}
	}
	if securedAdmin {
		var failure *diag.Diag
		firstAdmin, failure = firstAdminResult(store, adminEmail, platformRoot)
		if failure != nil {
			return applyCommandResult{}, failure
		}
	}
	registrationNotice, noticeErr := completedBootstrapProjectNotice(applied, applied.Plan.Request.ProjectRoot, input.AllowBootstrapRegistration)
	if noticeErr != nil {
		return applyCommandResult{}, contracts.NewDiag(contracts.CodeApplyFailed,
			"the project registration state could not be read", "check platform-root permissions, then rerun `"+contracts.ShellCommand("kb-create", "apply", "--platform-root", root)+"`", noticeErr)
	}
	return applyCommandResult{OK: true, Operation: "apply", Receipt: applied, LogPath: logPath,
		Profile: applied.Plan.ServiceGraph.Profile, Services: applied.Plan.ServiceGraph.Services,
		Shim: optionalShim(input.Executable, shimResult), FirstAdmin: firstAdmin, ProjectRegistrationNotice: registrationNotice,
		disclosureStoreRoot: store.PlatformRoot}, nil
}

func installHostFailure(root string, cause error) *diag.Diag {
	var diagnostic *diag.Diag
	if errors.As(cause, &diagnostic) {
		return diagnostic
	}
	return contracts.NewDiag(contracts.CodeApplyFailed, "the installed host did not become healthy", "run `"+contracts.ShellCommand("kb-create", "doctor", "--platform-root", root)+"` to inspect the installation, then rerun `"+contracts.ShellCommand("kb-create", "start", "--platform-root", root)+"`", cause)
}

func installMarketplaceScenarioPlugins(ctx context.Context, platformRoot string, applied *contracts.InstallReceipt, installer marketplace.InstallClient) *diag.Diag {
	specs := applied.Plan.Request.MarketplaceInstallSpecs
	if len(specs) == 0 {
		return nil
	}
	if applied.Verification.HostHealthURL == "" {
		return contracts.NewDiag(contracts.CodeScenarioInvalid,
			"the scenario requests Marketplace plugins but the selected platform has no recorded host Gateway",
			"select a platform release with the Marketplace service, then rerun `kb-create install`", nil)
	}
	origin, err := gateway.OriginFromHealthURL(applied.Verification.HostHealthURL)
	if err != nil {
		return contracts.HostSpecDiagnostic("the applied Gateway address could not be used for Marketplace installation", "run `kb-create doctor --json` to inspect the installed host", err.Error(), err)
	}
	installs, err := installer.Install(ctx, origin, specs)
	if err != nil {
		var failure *marketplace.InstallFailure
		if errors.As(err, &failure) {
			return contracts.MarketplaceInstallDiagnostic(failure.Spec, failure.Source, failure)
		}
		return contracts.MarketplaceInstallDiagnostic(strings.Join(specs, ", "), "Marketplace response", err)
	}
	applied.MarketplaceInstalls = installs
	if err := receipt.Write(platformRoot, *applied); err != nil {
		return contracts.NewDiag(contracts.CodeReceiptUnavailable,
			"Marketplace installed the scenario plugins, but their source and version could not be recorded in the receipt.",
			"run `kb-create doctor --json` to inspect the installed receipt", err)
	}
	return nil
}

func storePendingSecrets(store secrets.Store, pending map[string]secrets.PendingSecret) error {
	ids := make([]string, 0, len(pending))
	for id := range pending {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		input := pending[id]
		if id == secrets.BootstrapPassword {
			if err := store.PutBootstrapPassword(input.Value, input.Origin); err != nil {
				return err
			}
			continue
		}
		if err := store.Put(id, input.Value); err != nil {
			return err
		}
	}
	return nil
}

func unsupportedPlatformLayout(root string, cause error) *diag.Diag {
	if errors.Is(cause, versionroot.ErrOwnershipPublicationConflict) {
		next := contracts.ShellCommand("kb-create", "install", "--platform-root", root)
		failure := contracts.NewDiag(contracts.CodeOperationInProgress,
			"Another first install is publishing ownership for this platform root.",
			"Wait for the other install to finish, then retry with `"+next+"`.", cause)
		failure.Meta = map[string]any{"platformRoot": root, "nextCommand": next}
		return failure
	}
	var staging *versionroot.OwnershipStagingArtifactError
	if errors.As(cause, &staging) {
		paths := staging.Paths
		if len(paths) == 0 {
			paths = []string{staging.Path}
		}
		removeArgs := append([]string{"rm", "--"}, paths...)
		remove := contracts.ShellCommand(removeArgs...)
		retry := contracts.ShellCommand("kb-create", "install", "--platform-root", root)
		hint := fmt.Sprintf("The named staging files cannot prove ownership of this root. Inspect %s; after confirming they are abandoned installer staging files, remove them with `%s`, then retry with %s.", strings.Join(paths, ", "), remove, retry)
		failure := contracts.NewDiag(contracts.CodeInstallLayoutUnsupported,
			"The platform root contains an ownership staging file that cannot be validated.", hint, cause)
		failure.Meta = map[string]any{"platformRoot": root, "stagingPaths": paths, "nextCommand": remove}
		return failure
	}
	failure := contracts.NewDiag(contracts.CodeInstallLayoutUnsupported,
		"This platform root does not use the supported versioned installation layout.",
		"Choose a fresh writable path, then run `"+contracts.ShellCommand("kb-create", "install", "--platform-root", "NEW_ROOT")+"`.", cause)
	failure.Meta = map[string]any{"platformRoot": root, "nextCommand": contracts.ShellCommand("kb-create", "install", "--platform-root", "NEW_ROOT")}
	return failure
}

func optionalShim(executable string, result shim.EnsureResult) *shim.EnsureResult {
	if executable == "" {
		return nil
	}
	return &result
}

type installedHostStarter struct {
	root       string
	executable string
}

func (starter installedHostStarter) Start(ctx context.Context, spec contracts.HostSpec) (func() error, error) {
	layout, err := versionroot.New(starter.root)
	if err != nil {
		return nil, err
	}
	installed, err := receipt.Read(layout.PlatformRoot())
	if err != nil {
		return nil, err
	}
	if installed.Plan.Host == nil || !reflect.DeepEqual(*installed.Plan.Host, spec) {
		return nil, fmt.Errorf("host starter does not match the active receipt")
	}
	runner, err := host.NewRunner(starter.root)
	if err != nil {
		return nil, err
	}
	command := hostCommand{PlatformRoot: starter.root, Executable: starter.executable, Version: buildVersion}
	if _, failure := command.start(ctx, runner, runner.State); failure != nil {
		return nil, failure
	}
	return func() error {
		_, failure := command.stop(context.Background(), runner, runner.State)
		return failure
	}, nil
}

func applyDossier(root, correlationID, logPath string, plan contracts.ResolvedInstallPlan, redactions []string, cause error) *diag.Diag {
	var failure *diag.Diag
	if !errors.As(cause, &failure) {
		failure = contracts.NewDiag(contracts.CodeApplyFailed, "V2 operation did not reach a verified installation", "Inspect the local log and diagnostic dossier, then fix the reported prerequisite or run doctor --fix.", cause)
	}
	failure.CorrelationID = correlationID
	dossier := diagnostics.Dossier{CorrelationID: correlationID, Error: failure, Stage: contracts.StageApply, LogPath: logPath,
		PlanHash: plan.PlanHash, ReleaseDigest: plan.ReleaseDigest, ScenarioStateDigest: plan.ScenarioStateDigest}
	layout, layoutErr := versionroot.ForPlatformPath(root)
	if layoutErr != nil {
		return contracts.NewDiag("KB_INSTALL_DIAGNOSTIC_UNAVAILABLE", "The operation failed and the diagnostic dossier could not be written.", "inspect the local operation log", layoutErr)
	}
	path, err := diagnostics.Write(layout.FailureDossiersDir(), dossier, redactions)
	if err != nil {
		return contracts.NewDiag("KB_INSTALL_DIAGNOSTIC_UNAVAILABLE", "The operation failed and the diagnostic dossier could not be written.", "inspect the local operation log", err)
	}
	failure.Meta = ensureMeta(failure.Meta)
	failure.Meta["logPath"], failure.Meta["diagnosticPath"] = logPath, path
	return failure
}

func ensureMeta(meta map[string]any) map[string]any {
	if meta == nil {
		return map[string]any{}
	}
	return meta
}

func shimFailure(code, root string, cause error) *diag.Diag {
	var failureCause *shim.Failure
	if errors.As(cause, &failureCause) {
		reason := failureCause.Reason
		if failureCause.Cause != nil {
			reason = failureCause.Cause.Error()
		}
		hint := "Fix the filesystem reason for the shim path, then run `" + contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root) + "`."
		if strings.Contains(failureCause.Reason, "unverified target") {
			hint = fmt.Sprintf("Inspect the existing target, then remove the unverified launcher with %s and rerun `%s`.", shim.RemoveCommand(failureCause.Path), contracts.ShellCommand("kb-create", "apply", "--platform-root", root))
		}
		diagnostic := contracts.NewDiag(code, fmt.Sprintf("Platform files and receipt remain applied at %s, but the kb command shim could not be created.", root), hint, cause)
		diagnostic.Reason = fmt.Sprintf("The filesystem refused shim path %s: %s", failureCause.Path, reason)
		diagnostic.Meta = map[string]any{"path": failureCause.Path, "reason": reason}
		return diagnostic
	}
	return contracts.NewDiag(code, fmt.Sprintf("Platform files and receipt remain applied at %s, but the kb command shim could not be created: %s", root, cause),
		"Fix the filesystem reason for the shim path, then run `"+contracts.ShellCommand("kb-create", "doctor", "--fix", "--platform-root", root)+"`.", cause)
}
