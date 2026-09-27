// Package v2cli is the public V2 kb-create frontend. Both the released root
// binary and package-local tests enter through Execute, so there is exactly one
// launcher command surface and no legacy dispatcher to keep in sync.
package v2cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/logs"
	"github.com/kb-labs/create/v2/preflight"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/telemetry"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/wizard"
)

var telemetryEndpoint string
var telemetryConsent bool
var buildVersion = "dev"

// SetVersionInfo preserves the released binary's version contract without
// exposing the retired command dispatcher to V2.
func SetVersionInfo(version, _ string, _ string) {
	if version != "" {
		buildVersion = version
	}
}

// Execute runs the public kb-create command and returns its process status.
// A positional operation is accepted for human use while the explicit
// --operation form remains the stable CI/agent protocol.
func Execute() int {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Fprintf(os.Stdout, "kb-create %s\n", buildVersion)
		return 0
	}
	normalizeOperationArgument()
	index := flag.String("index", "", "path to immutable V2 release index JSON")
	input := flag.String("input", "", "path to V2 InstallRequest JSON")
	requestRoot := flag.String("request-platform-root", "", "platform root for direct CI/agent request")
	projectRoot := flag.String("project-root", "", "project root for the user-owned V2 config pointer")
	platformVersion := flag.String("platform-version", "", "exact platform version for direct request")
	platformChannel := flag.String("platform-channel", "", "platform channel: stable, canary, experimental")
	sdkVersion := flag.String("sdk-version", "", "exact SDK version for direct request")
	serviceProfile := flag.String("service-profile", "", "platform-owned service profile for direct request")
	plugins := flag.String("plugins", "", "comma-separated plugin IDs or id@version pins")
	adapters := flag.String("adapters", "", "comma-separated adapter IDs or id@version pins")
	policy := flag.String("policy", "strict", "compatibility policy: strict, compatible, upgrade-safe")
	offline := flag.Bool("offline", false, "use offline artifact source")
	secretEnv := flag.String("secret-env", "", "comma-separated requirement=ENV_VAR secret sources (never serialized)")
	doctorInput := flag.String("doctor-input", "", "path to V2 manifest-derived doctor JSON")
	scenarioID := flag.String("scenario", "", "built-in V2 scenario ID")
	scenarioAnswers := flag.String("scenario-answers", "", "JSON object of V2 scenario field answers")
	scenarioResume := flag.Bool("resume", false, "resume persisted non-secret V2 scenario answers")
	doctorFix := flag.Bool("fix", false, "doctor: apply only manifest-declared safe defaults and restart the host")
	doctorRecover := flag.Bool("recover", false, "doctor: recover the administrator account with the platform's recovery tool (the host must be stopped)")
	recoverEmail := flag.String("email", "", "doctor --recover: administrator email")
	recoverTenant := flag.String("tenant", "", "doctor --recover: tenant ID")
	recoverPasswordStdin := flag.Bool("password-stdin", false, "doctor --recover: read the new password from stdin")
	recoverGenerate := flag.Bool("generate", false, "doctor --recover: generate a password and print it once")
	recoverYes := flag.Bool("yes", false, "doctor --recover: apply the changes (without it the recovery is a dry run)")
	operation := flag.String("operation", "plan", "V2 operation: plan, apply, update, uninstall, rollback, doctor, wizard, status, start, stop, restart")
	platformRoot := flag.String("platform-root", "", "platform root for lifecycle operations")
	snapshotID := flag.String("snapshot", "", "V2 snapshot ID for rollback (default: the snapshot taken by the last update)")
	registry := flag.String("registry", "", "npm registry for exact artifact installation")
	telemetryURL := flag.String("telemetry-endpoint", "", "opt-in anonymous telemetry endpoint")
	foreground := flag.Bool("foreground", false, "start: run the host directly in this process, without the control channel")
	jsonOutput := flag.Bool("json", false, "emit the JSON envelope instead of text (host commands, doctor --recover)")
	telemetryAllowed := flag.Bool("telemetry-consent", false, "allow anonymous operational telemetry")
	flag.Parse()
	telemetryEndpoint, telemetryConsent = *telemetryURL, *telemetryAllowed
	executable, _ := os.Executable()
	if isHostOperation(*operation) {
		return hostCommand{PlatformRoot: *platformRoot, Foreground: *foreground, JSON: *jsonOutput || *operation == "supervise", Executable: executable, Version: buildVersion, Out: os.Stdout, Err: os.Stderr}.run(*operation)
	}
	direct := directRequest{PlatformRoot: *requestRoot, ProjectRoot: *projectRoot, PlatformVersion: *platformVersion, PlatformChannel: *platformChannel, SDKVersion: *sdkVersion, ServiceProfile: *serviceProfile, Plugins: *plugins, Adapters: *adapters, Policy: *policy, Offline: *offline}
	return invocation{
		Operation: *operation, Index: *index, Input: *input, DoctorInput: *doctorInput, PlatformRoot: *platformRoot, Snapshot: *snapshotID,
		Registry: *registry, SecretEnv: *secretEnv, DoctorFix: *doctorFix,
		Recover:    recoverRequest{Enabled: *doctorRecover, Email: *recoverEmail, Tenant: *recoverTenant, PasswordStdin: *recoverPasswordStdin, Generate: *recoverGenerate, Yes: *recoverYes, JSON: *jsonOutput},
		ScenarioID: *scenarioID, ScenarioAnswers: *scenarioAnswers, ScenarioResume: *scenarioResume, Direct: direct, Executable: executable,
	}.run(os.Stdout)
}

func normalizeOperationArgument() {
	if len(os.Args) < 2 {
		return
	}
	operation := os.Args[1]
	switch operation {
	case "plan", "apply", "update", "uninstall", "rollback", "doctor", "wizard", "status", "start", "stop", "restart", "supervise":
		os.Args = append([]string{os.Args[0], "--operation", operation}, os.Args[2:]...)
	}
}

type directRequest struct {
	PlatformRoot, ProjectRoot, PlatformVersion, PlatformChannel, SDKVersion, ServiceProfile, Plugins, Adapters, Policy string
	Offline                                                                                                            bool
}

// invocation is one parsed non-host command line. Every field is an input; the
// run method reads nothing from package state except the build version.
type invocation struct {
	Operation, Index, Input, DoctorInput, PlatformRoot, Snapshot, Registry, SecretEnv string
	DoctorFix                                                                         bool
	Recover                                                                           recoverRequest
	ScenarioID, ScenarioAnswers                                                       string
	ScenarioResume                                                                    bool
	Direct                                                                            directRequest
	// Executable is the launcher binary re-executed to supervise the host.
	Executable string
}

func (i invocation) hostCommand(output *os.File) hostCommand {
	return hostCommand{PlatformRoot: i.PlatformRoot, Executable: i.Executable, Version: buildVersion, JSON: true, Out: output, Err: os.Stderr}
}

func (i invocation) run(output *os.File) int {
	operation := i.Operation
	switch operation {
	case "plan", "apply", "update", "uninstall", "rollback", "doctor", "wizard", "status":
	default:
		write(output, failure("KB_INSTALL_OPERATION_INVALID", "operation is not supported", "use plan, apply, update, uninstall, rollback, doctor, wizard, status, start, stop or restart", nil))
		return 2
	}
	if operation == "doctor" {
		return i.runDoctor(output)
	}
	if operation == "status" {
		return i.runStatus(output)
	}
	if operation == "wizard" {
		return runWizard(i.Index, i.Direct.PlatformRoot, i.ScenarioID, output)
	}
	if operation == "apply" || operation == "update" {
		if err := preflight.Ensure(nil); err != nil {
			write(output, failure("KB_INSTALL_TOOLCHAIN_UNSUPPORTED", "runtime preflight failed", "use Node.js 24.x and pnpm 11.x, or update the runtime and retry", err))
			return 2
		}
	}
	if operation == "uninstall" || operation == "rollback" {
		return i.runRecovery(output)
	}
	if i.Index == "" || (i.Input == "" && i.Direct.PlatformRoot == "") {
		write(output, failure("KB_INSTALL_INPUT_REQUIRED", "--index and either --input or --request-platform-root are required", "pass immutable release index plus V2 request JSON or direct CI flags", nil))
		return 2
	}
	source, err := catalog.LoadFile(i.Index)
	if err != nil {
		writeIndexFailure(output, err, "supply a valid immutable V2 release index")
		return 2
	}
	var response transport.PlanResponse
	if i.Input != "" {
		data, err := os.ReadFile(i.Input)
		if err != nil {
			write(output, failure("KB_INSTALL_INPUT_REQUIRED", "request could not be read", "supply a readable V2 request JSON file", err))
			return 2
		}
		response = transport.PlanWith(data, source, resolve.Options{LauncherVersion: buildVersion})
	} else {
		request, requestErr := i.Direct.normalize()
		if requestErr != nil {
			write(output, failure("KB_INSTALL_INPUT_REQUIRED", "direct request is invalid", "correct direct CI flags or provide --input", requestErr))
			return 2
		}
		if i.ScenarioID != "" {
			compiled, scenarioErr := compileScenario(i.ScenarioID, i.ScenarioAnswers, i.ScenarioResume, request)
			if scenarioErr != nil {
				write(output, failure("KB_INSTALL_SCENARIO_INVALID", "scenario could not be compiled", "inspect scenario answers and manifest requirements", scenarioErr))
				return 2
			}
			request = compiled
		}
		data, _ := json.Marshal(request)
		response = transport.PlanWith(data, source, resolve.Options{LauncherVersion: buildVersion})
	}
	if !response.OK {
		write(output, response)
		return 2
	}
	started := time.Now()
	outcome, errorCode := "failure", "KB_INSTALL_OPERATION_FAILED"
	defer func() {
		telemetry.Send(telemetryEndpoint, telemetryConsent, telemetry.New(operation, outcome, errorCode, string(response.Plan.Request.Platform.Channel), string(response.Plan.Request.Source), len(response.Plan.Artifacts), time.Since(started)))
	}()
	if operation == "plan" {
		write(output, response)
		outcome, errorCode = "success", ""
		return 0
	}
	root := response.Plan.Request.PlatformRoot
	correlationID := fmt.Sprintf("%s-%d", operation, time.Now().UTC().UnixNano())
	transcript, err := logs.New(root, correlationID, nil)
	if err != nil {
		write(output, failure("KB_INSTALL_LOG_UNAVAILABLE", "could not create local operation log", "check that the platform root is writable", err))
		return 2
	}
	defer transcript.Close()
	store := secrets.Store{PlatformRoot: root}
	if err := populateSecrets(store, i.SecretEnv); err != nil {
		write(output, failure("KB_INSTALL_SECRET_INPUT_INVALID", "secret input could not be stored", "use --secret-env requirement=ENV_VAR and set the environment variable", err))
		return 2
	}
	state, stateErr := host.StateHome()
	if stateErr != nil {
		write(output, map[string]any{"ok": false, "error": asLauncherError(stateErr)})
		return 2
	}
	if operation == "apply" {
		if running := refuseRunningHost(state); running != nil {
			write(output, map[string]any{"ok": false, "error": running})
			return 2
		}
	}
	release, lockErr := state.AcquireOperation(operation)
	if lockErr != nil {
		write(output, map[string]any{"ok": false, "error": asLauncherError(lockErr)})
		return 2
	}
	defer release()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	offlineArtifacts := response.Plan.Request.Source == contracts.SourceOffline
	artifactExecutor := artifacts.Composite{Packages: artifacts.Pnpm{Root: root, Registry: i.Registry, Offline: offlineArtifacts, Log: transcript}, Binaries: artifacts.Binaries{Root: root, Offline: offlineArtifacts}}
	prober := host.Prober{PlatformRoot: root, State: state}
	deps := runtime.Dependencies{Artifacts: artifactExecutor, CorrelationID: correlationID, Secrets: &store}
	if operation == "apply" {
		deps.Host = prober
		receipt, applyErr := runtime.Apply(ctx, *response.Plan, deps)
		if applyErr == nil {
			write(output, map[string]any{"ok": true, "operation": operation, "receipt": receipt, "logPath": transcript.Path()})
			outcome, errorCode = "success", ""
			return 0
		}
		writeFailureDossier(output, *response.Plan, correlationID, transcript.Path(), applyErr)
		return 1
	}
	return i.runUpdate(ctx, output, *response.Plan, deps, prober, state, correlationID, transcript.Path(), &outcome, &errorCode)
}

// runStatus reports the host of the receipt-owned installation without
// resolving a new release, so it is safe for stable, canary and exact-version
// installations: it describes the immutable decision that was actually applied.
func (i invocation) runStatus(output *os.File) int {
	command := i.hostCommand(output)
	runner, state, setupErr := command.setup()
	if setupErr != nil {
		return command.fail(2, setupErr)
	}
	return command.hostStatus(context.Background(), runner, state)
}

func populateSecrets(store secrets.Store, mappings string) error {
	if strings.TrimSpace(mappings) == "" {
		return nil
	}
	for _, pair := range strings.Split(mappings, ",") {
		name, environment, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok || strings.TrimSpace(name) == "" || strings.TrimSpace(environment) == "" {
			return fmt.Errorf("secret mapping %q must be requirement=ENV_VAR", pair)
		}
		value, exists := os.LookupEnv(environment)
		if !exists || value == "" {
			return fmt.Errorf("environment variable %q is not set", environment)
		}
		if err := store.Put(name, value); err != nil {
			return err
		}
	}
	return nil
}

func compileScenario(id, answers string, resume bool, base contracts.InstallRequest) (contracts.InstallRequest, error) {
	definition, err := scenario.Load(id)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	state, err := scenario.New(definition)
	if resume {
		state, err = scenario.LoadState(base.PlatformRoot, definition)
	}
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	if answers != "" {
		var values map[string]json.RawMessage
		if err := json.Unmarshal([]byte(answers), &values); err != nil {
			return contracts.InstallRequest{}, fmt.Errorf("decode scenario answers: %w", err)
		}
		for field, value := range values {
			state, err = scenario.Answer(definition, state, field, value)
			if err != nil {
				return contracts.InstallRequest{}, err
			}
		}
	}
	if err := scenario.SaveState(base.PlatformRoot, definition, state); err != nil {
		return contracts.InstallRequest{}, err
	}
	request, err := scenario.Compile(definition, state, base)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	request.ScenarioStateDigest, err = scenario.StateDigest(definition, state)
	return request, err
}

func runWizard(indexPath, platformRoot, scenarioID string, output *os.File) int {
	if indexPath == "" || platformRoot == "" {
		write(output, failure("KB_INSTALL_INPUT_REQUIRED", "--index and --request-platform-root are required", "pass the sealed release index and desired platform root", nil))
		return 2
	}
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		writeIndexFailure(output, err, "supply a valid sealed V2 release index")
		return 2
	}
	request, err := wizard.RequestScenario(source, platformRoot, scenarioID, wizard.IO{In: os.Stdin, Out: os.Stderr})
	if err != nil {
		write(output, failure("KB_INSTALL_WIZARD_INPUT_INVALID", "wizard answer is invalid", "choose one of the displayed compatible options", err))
		return 2
	}
	write(output, map[string]any{"ok": true, "request": request})
	return 0
}

func (value directRequest) normalize() (contracts.InstallRequest, error) {
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: value.PlatformRoot, ProjectRoot: value.ProjectRoot, Platform: contracts.VersionSelector{Version: value.PlatformVersion, Channel: contracts.Channel(value.PlatformChannel)}, SDK: contracts.VersionSelector{Version: value.SDKVersion}, ServiceProfile: value.ServiceProfile, Policy: contracts.CompatibilityPolicy(value.Policy), Source: contracts.SourceRegistry}
	if value.Offline {
		request.Source = contracts.SourceOffline
	}
	plugins, err := parseComponents(value.Plugins)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	adapters, err := parseComponents(value.Adapters)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	request.Plugins, request.Adapters = plugins, adapters
	return request.Normalize()
}

func parseComponents(value string) ([]contracts.ComponentRequest, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	items := strings.Split(value, ",")
	result := make([]contracts.ComponentRequest, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, fmt.Errorf("component list contains empty item")
		}
		// Scoped npm-style component IDs contain an @ themselves. Only the last
		// separator denotes an optional immutable version pin.
		id, version, pinned := item, "", false
		if at := strings.LastIndex(item, "@"); at > 0 {
			id, version, pinned = item[:at], item[at+1:], true
		}
		if strings.TrimSpace(id) == "" {
			return nil, fmt.Errorf("component ID is required")
		}
		component := contracts.ComponentRequest{ID: id}
		if pinned {
			if version == "" {
				return nil, fmt.Errorf("component %q has empty version", id)
			}
			component.Version.Version = version
		}
		result = append(result, component)
	}
	return result, nil
}

func write(output *os.File, value any) { _ = json.NewEncoder(output).Encode(value) }

// writeIndexFailure emits a typed launcher error from the index gate as is
// (schema unsupported, corrupt digest); anything else is a generic load failure.
func writeIndexFailure(output *os.File, err error, hint string) {
	var typed *contracts.LauncherError
	if errors.As(err, &typed) {
		write(output, map[string]any{"ok": false, "error": typed})
		return
	}
	write(output, failure("KB_INSTALL_RELEASE_INDEX_INVALID", "release index could not be loaded", hint, err))
}

func failure(code, message, hint string, cause error) map[string]any {
	return map[string]any{"ok": false, "error": contracts.NewLauncherError(code, message, hint, cause)}
}

func writeFailureDossier(output *os.File, plan contracts.ResolvedInstallPlan, correlationID, logPath string, cause error) {
	launcherError := contracts.NewLauncherError(contracts.CodeApplyFailed, "V2 operation did not reach a verified installation", "Inspect the local log and diagnostic dossier, then fix the reported prerequisite or run doctor --fix.", cause)
	writeLauncherFailure(output, plan.Request.PlatformRoot, correlationID, logPath, launcherError, &plan)
}
