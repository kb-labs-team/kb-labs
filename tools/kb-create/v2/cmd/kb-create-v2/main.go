// Package v2cli is the public V2 kb-create frontend. Both the released root
// binary and package-local tests enter through Execute, so there is exactly one
// launcher command surface and no legacy dispatcher to keep in sync.
package v2cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/diagnostics"
	"github.com/kb-labs/create/v2/doctor"
	"github.com/kb-labs/create/v2/installed"
	"github.com/kb-labs/create/v2/logs"
	"github.com/kb-labs/create/v2/preflight"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/services"
	"github.com/kb-labs/create/v2/telemetry"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/verify"
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
	doctorFix := flag.Bool("fix", false, "apply only manifest-declared safe doctor defaults")
	operation := flag.String("operation", "plan", "V2 operation: plan, apply, update, status")
	platformRoot := flag.String("platform-root", "", "platform root for uninstall or rollback")
	snapshotID := flag.String("snapshot", "", "V2 snapshot ID for rollback")
	registry := flag.String("registry", "", "npm registry for exact artifact installation")
	kbdev := flag.String("kb-dev", "", "optional override for release-managed kb-dev binary")
	telemetryURL := flag.String("telemetry-endpoint", "", "opt-in anonymous telemetry endpoint")
	telemetryAllowed := flag.Bool("telemetry-consent", false, "allow anonymous operational telemetry")
	flag.Parse()
	telemetryEndpoint, telemetryConsent = *telemetryURL, *telemetryAllowed
	direct := directRequest{PlatformRoot: *requestRoot, ProjectRoot: *projectRoot, PlatformVersion: *platformVersion, PlatformChannel: *platformChannel, SDKVersion: *sdkVersion, ServiceProfile: *serviceProfile, Plugins: *plugins, Adapters: *adapters, Policy: *policy, Offline: *offline}
	return run(*operation, *index, *input, *doctorInput, *platformRoot, *snapshotID, *registry, *kbdev, *secretEnv, *doctorFix, *scenarioID, *scenarioAnswers, *scenarioResume, direct, os.Stdout)
}

func normalizeOperationArgument() {
	if len(os.Args) < 2 {
		return
	}
	operation := os.Args[1]
	switch operation {
	case "plan", "apply", "update", "uninstall", "rollback", "doctor", "wizard", "status":
		os.Args = append([]string{os.Args[0], "--operation", operation}, os.Args[2:]...)
	}
}

type directRequest struct {
	PlatformRoot, ProjectRoot, PlatformVersion, PlatformChannel, SDKVersion, ServiceProfile, Plugins, Adapters, Policy string
	Offline                                                                                                            bool
}

func run(operation, indexPath, inputPath, doctorInput, platformRoot, snapshotID, registry, kbdev, secretEnv string, doctorFix bool, scenarioID, scenarioAnswers string, scenarioResume bool, direct directRequest, output *os.File) int {
	if operation != "plan" && operation != "apply" && operation != "update" && operation != "uninstall" && operation != "rollback" && operation != "doctor" && operation != "wizard" && operation != "status" {
		write(output, failure("KB_CREATE_OPERATION_INVALID", "operation is not supported", "use plan, apply, update, uninstall, rollback, doctor, wizard, or status", nil))
		return 2
	}
	if operation == "doctor" {
		return runDoctor(doctorInput, platformRoot, kbdev, doctorFix, output)
	}
	if operation == "status" {
		return runStatus(platformRoot, kbdev, output)
	}
	if operation == "wizard" {
		return runWizard(indexPath, direct.PlatformRoot, scenarioID, output)
	}
	if operation == "apply" || operation == "update" {
		if err := preflight.Ensure(nil); err != nil {
			write(output, failure("KB_CREATE_TOOLCHAIN_UNSUPPORTED", "runtime preflight failed", "use Node.js 24.x and pnpm 11.x, or update the runtime and retry", err))
			return 2
		}
	}
	if operation == "uninstall" || operation == "rollback" {
		return runRecovery(operation, platformRoot, snapshotID, registry, kbdev, output)
	}
	if indexPath == "" || (inputPath == "" && direct.PlatformRoot == "") {
		write(output, failure("KB_CREATE_INPUT_REQUIRED", "--index and either --input or --request-platform-root are required", "pass immutable release index plus V2 request JSON or direct CI flags", nil))
		return 2
	}
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		write(output, failure("KB_CREATE_RELEASE_INDEX_INVALID", "release index could not be loaded", "supply a valid immutable V2 release index", err))
		return 2
	}
	var response transport.PlanResponse
	if inputPath != "" {
		data, err := os.ReadFile(inputPath)
		if err != nil {
			write(output, failure("KB_CREATE_INPUT_REQUIRED", "request could not be read", "supply a readable V2 request JSON file", err))
			return 2
		}
		response = transport.Plan(data, source)
	} else {
		request, requestErr := direct.normalize()
		if requestErr != nil {
			write(output, failure("KB_CREATE_INPUT_REQUIRED", "direct request is invalid", "correct direct CI flags or provide --input", requestErr))
			return 2
		}
		if scenarioID != "" {
			compiled, scenarioErr := compileScenario(scenarioID, scenarioAnswers, scenarioResume, request)
			if scenarioErr != nil {
				write(output, failure("KB_CREATE_SCENARIO_INVALID", "scenario could not be compiled", "inspect scenario answers and manifest requirements", scenarioErr))
				return 2
			}
			request = compiled
		}
		data, _ := json.Marshal(request)
		response = transport.Plan(data, source)
	}
	if !response.OK {
		write(output, response)
		return 2
	}
	started := time.Now()
	outcome, errorCode := "failure", "KB_CREATE_OPERATION_FAILED"
	defer func() {
		telemetry.Send(telemetryEndpoint, telemetryConsent, telemetry.New(operation, outcome, errorCode, string(response.Plan.Request.Platform.Channel), string(response.Plan.Request.Source), len(response.Plan.Artifacts), time.Since(started)))
	}()
	if operation == "plan" {
		write(output, response)
		outcome, errorCode = "success", ""
		return 0
	}
	correlationID := fmt.Sprintf("%s-%d", operation, time.Now().UTC().UnixNano())
	transcript, err := logs.New(response.Plan.Request.PlatformRoot, correlationID, nil)
	if err != nil {
		write(output, failure("KB_CREATE_LOG_UNAVAILABLE", "could not create local operation log", "check that the platform root is writable", err))
		return 2
	}
	defer transcript.Close()
	store := secrets.Store{PlatformRoot: response.Plan.Request.PlatformRoot}
	if err := populateSecrets(store, secretEnv); err != nil {
		write(output, failure("KB_CREATE_SECRET_INPUT_INVALID", "secret input could not be stored", "use --secret-env requirement=ENV_VAR and set the environment variable", err))
		return 2
	}
	offlineArtifacts := response.Plan.Request.Source == contracts.SourceOffline
	artifactExecutor := artifacts.Composite{Packages: artifacts.Pnpm{Root: response.Plan.Request.PlatformRoot, Registry: registry, Offline: offlineArtifacts, Log: transcript}, Binaries: artifacts.Binaries{Root: response.Plan.Request.PlatformRoot, Offline: offlineArtifacts}}
	deps := runtime.Dependencies{Artifacts: artifactExecutor, Activator: services.KBDev{Binary: kbdev, Log: transcript}, Status: services.KBDev{Binary: kbdev}, CorrelationID: correlationID, Secrets: &store}
	if operation == "apply" {
		receipt, applyErr := runtime.Apply(*response.Plan, deps)
		if applyErr == nil {
			write(output, map[string]any{"ok": true, "operation": operation, "receipt": receipt, "logPath": transcript.Path()})
			outcome, errorCode = "success", ""
			return 0
		}
		writeFailureDossier(output, *response.Plan, correlationID, transcript.Path(), applyErr)
		return 1
	}
	receipt, snapshot, updateErr := runtime.Update(*response.Plan, deps)
	if updateErr == nil {
		write(output, map[string]any{"ok": true, "operation": operation, "receipt": receipt, "snapshot": snapshot, "logPath": transcript.Path()})
		outcome, errorCode = "success", ""
		return 0
	}
	writeFailureDossier(output, *response.Plan, correlationID, transcript.Path(), updateErr)
	return 1
}

// runStatus verifies the receipt-owned graph without resolving a new release.
// That makes status safe for stable, canary and exact-version installations:
// it reports the immutable decision that was actually applied.
func runStatus(platformRoot, kbdev string, output *os.File) int {
	if platformRoot == "" {
		write(output, failure("KB_CREATE_INPUT_REQUIRED", "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil))
		return 2
	}
	active, err := receipt.Read(platformRoot)
	if err != nil {
		write(output, failure("KB_CREATE_RECEIPT_UNAVAILABLE", "active V2 receipt could not be read", "run apply first or restore a named V2 snapshot", err))
		return 2
	}
	check, err := verify.Run(active.Plan, services.KBDev{Binary: kbdev}, time.Now().UTC())
	if err != nil {
		write(output, failure("KB_CREATE_STATUS_UNHEALTHY", "installed V2 service graph is not ready", "inspect kb-dev status or run doctor --fix", err))
		return 1
	}
	write(output, map[string]any{"ok": true, "operation": "status", "receipt": active, "verification": check})
	return 0
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
		write(output, failure("KB_CREATE_INPUT_REQUIRED", "--index and --request-platform-root are required", "pass the sealed release index and desired platform root", nil))
		return 2
	}
	source, err := catalog.LoadFile(indexPath)
	if err != nil {
		write(output, failure("KB_CREATE_RELEASE_INDEX_INVALID", "release index could not be loaded", "supply a valid sealed V2 release index", err))
		return 2
	}
	request, err := wizard.RequestScenario(source, platformRoot, scenarioID, wizard.IO{In: os.Stdin, Out: os.Stderr})
	if err != nil {
		write(output, failure("KB_CREATE_WIZARD_INPUT_INVALID", "wizard answer is invalid", "choose one of the displayed compatible options", err))
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

func runDoctor(path, platformRoot, kbdev string, fix bool, output *os.File) int {
	var input doctor.Input
	var err error
	if path != "" {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			write(output, failure("KB_CREATE_INPUT_REQUIRED", "doctor input could not be read", "supply a readable V2 doctor input JSON file", readErr))
			return 2
		}
		input, err = doctor.Decode(data)
	} else {
		if platformRoot == "" {
			write(output, failure("KB_CREATE_INPUT_REQUIRED", "--platform-root is required for automatic doctor", "pass the V2 platform root or a manifest-derived --doctor-input", nil))
			return 2
		}
		input, err = automaticDoctorInput(platformRoot)
	}
	if err != nil {
		write(output, failure("KB_CREATE_DOCTOR_INPUT_INVALID", "installed manifest diagnostics could not be prepared", "install exact V2 artifacts that ship matching V2 manifests", err))
		return 2
	}
	findings := doctor.Diagnose(input.Manifests, input.Configured)
	response := doctor.Response{OK: len(findings) == 0, Findings: findings, Repair: doctor.PlanRepair(findings)}
	if fix {
		if platformRoot == "" {
			write(output, failure("KB_CREATE_INPUT_REQUIRED", "--platform-root is required with --fix", "pass the V2 platform root that owns the active receipt", nil))
			return 2
		}
		service := services.KBDev{Binary: kbdev}
		snapshot, fixErr := runtime.DoctorFix(platformRoot, response.Repair, runtime.Dependencies{Activator: service, Status: service})
		if fixErr != nil {
			writeRecoveryFailure(output, platformRoot, fmt.Sprintf("doctor-fix-%d", time.Now().UTC().UnixNano()), "", fixErr)
			return 1
		}
		write(output, map[string]any{"ok": true, "operation": "doctor-fix", "findings": response.Findings, "snapshot": snapshot})
		return 0
	}
	write(output, response)
	if !response.OK {
		return 1
	}
	return 0
}

func automaticDoctorInput(platformRoot string) (doctor.Input, error) {
	active, err := receipt.Read(platformRoot)
	if err != nil {
		return doctor.Input{}, fmt.Errorf("read active V2 receipt: %w", err)
	}
	manifests, err := installed.LoadAll(platformRoot, active.Plan.Artifacts)
	if err != nil {
		return doctor.Input{}, err
	}
	paths := make([]string, 0)
	for _, manifest := range manifests {
		for _, requirement := range manifest.Requirements {
			if !requirement.Secret {
				paths = append(paths, requirement.Path)
			}
		}
	}
	configured, err := installed.ConfiguredPaths(platformRoot, paths)
	if err != nil {
		return doctor.Input{}, err
	}
	return installed.DoctorInput(platformRoot, active.Plan.Artifacts, configured)
}

func runRecovery(operation, platformRoot, snapshotID, registry, kbdev string, output *os.File) int {
	if platformRoot == "" {
		write(output, failure("KB_CREATE_INPUT_REQUIRED", "--platform-root is required", "pass the V2 platform root that owns the active receipt", nil))
		return 2
	}
	correlationID := fmt.Sprintf("%s-%d", operation, time.Now().UTC().UnixNano())
	transcript, err := logs.New(platformRoot, correlationID, nil)
	if err != nil {
		write(output, failure("KB_CREATE_LOG_UNAVAILABLE", "could not create local operation log", "check that the platform root is writable", err))
		return 2
	}
	defer transcript.Close()
	service := services.KBDev{Binary: kbdev, Log: transcript}
	deps := runtime.Dependencies{Artifacts: artifacts.Composite{Packages: artifacts.Pnpm{Root: platformRoot, Registry: registry, Log: transcript}, Binaries: artifacts.Binaries{Root: platformRoot}}, Activator: service, Deactivator: service, Status: service, CorrelationID: correlationID}
	if operation == "uninstall" {
		snapshot, uninstallErr := runtime.Uninstall(platformRoot, deps)
		if uninstallErr == nil {
			write(output, map[string]any{"ok": true, "operation": operation, "snapshot": snapshot, "logPath": transcript.Path()})
			return 0
		}
		writeRecoveryFailure(output, platformRoot, correlationID, transcript.Path(), uninstallErr)
		return 1
	}
	snapshot, rollbackErr := runtime.Rollback(platformRoot, snapshotID, deps)
	if rollbackErr == nil {
		write(output, map[string]any{"ok": true, "operation": operation, "snapshot": snapshot, "logPath": transcript.Path()})
		return 0
	}
	writeRecoveryFailure(output, platformRoot, correlationID, transcript.Path(), rollbackErr)
	return 1
}

func write(output *os.File, value any) { _ = json.NewEncoder(output).Encode(value) }

func failure(code, message, hint string, cause error) map[string]any {
	errorValue := map[string]string{"code": code, "message": message, "hint": hint}
	if cause != nil {
		errorValue["cause"] = cause.Error()
	}
	return map[string]any{"ok": false, "error": errorValue}
}

func writeFailureDossier(output *os.File, plan contracts.ResolvedInstallPlan, correlationID, logPath string, cause error) {
	launcherError := &contracts.LauncherError{Code: "KB_CREATE_APPLY_FAILED", Stage: contracts.StageApply, Message: "V2 operation did not reach a verified installation", Cause: cause.Error(), Hint: "Inspect the local log and diagnostic dossier, then fix the reported prerequisite or run doctor --fix."}
	path, dossierErr := diagnostics.Write(plan.Request.PlatformRoot, diagnostics.Dossier{CorrelationID: correlationID, Error: launcherError, PlanHash: plan.PlanHash, ReleaseDigest: plan.ReleaseDigest, ScenarioStateDigest: plan.ScenarioStateDigest, Stage: launcherError.Stage, LogPath: logPath}, nil)
	if dossierErr != nil {
		write(output, failure("KB_CREATE_DIAGNOSTIC_UNAVAILABLE", "V2 operation failed and diagnostic dossier could not be written", "inspect the local operation log", dossierErr))
		return
	}
	write(output, map[string]any{"ok": false, "error": launcherError, "logPath": logPath, "diagnosticPath": path})
}

func writeRecoveryFailure(output *os.File, platformRoot, correlationID, logPath string, cause error) {
	launcherError := &contracts.LauncherError{Code: "KB_CREATE_RECOVERY_FAILED", Stage: contracts.StageRecover, Message: "V2 recovery operation did not reach a verified state", Cause: cause.Error(), Hint: "Inspect the local log and diagnostic dossier, then retry with the named receipt or snapshot."}
	path, dossierErr := diagnostics.Write(platformRoot, diagnostics.Dossier{CorrelationID: correlationID, Error: launcherError, Stage: launcherError.Stage, LogPath: logPath}, nil)
	if dossierErr != nil {
		write(output, failure("KB_CREATE_DIAGNOSTIC_UNAVAILABLE", "V2 recovery failed and diagnostic dossier could not be written", "inspect the local operation log", dossierErr))
		return
	}
	write(output, map[string]any{"ok": false, "error": launcherError, "logPath": logPath, "diagnosticPath": path})
}
