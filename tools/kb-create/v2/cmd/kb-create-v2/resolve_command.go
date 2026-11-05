package v2cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/kb-labs/clikit/diag"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/host"
	"github.com/kb-labs/create/v2/receipt"
	"github.com/kb-labs/create/v2/resolve"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/shim"
	"github.com/kb-labs/create/v2/telemetry"
	"github.com/kb-labs/create/v2/transport"
	"github.com/kb-labs/create/v2/versionroot"
)

type planInput struct {
	Operation     string
	Index         string
	RequestFile   string
	Request       *contracts.InstallRequest
	Direct        directRequest
	ScenarioID    string
	Answers       string
	Resume        bool
	Executable    string
	KnownGateways []gateway.Root
	Arguments     []string
}

type resolvedPlan struct {
	Catalog catalog.Catalog
	Plan    contracts.ResolvedInstallPlan
	State   host.State
}

func savedReleaseIndex(home string) string {
	return filepath.Join(gateway.DataDir(home), "release-index.json")
}

type planResult struct {
	Plan          contracts.ResolvedInstallPlan `json:"plan"`
	UpdateSummary *contracts.UpdateSummary      `json:"updateSummary,omitempty"`
}

type planCommandInput struct {
	Index, RequestFile, ScenarioID, Answers, Executable string
	RetryCommand                                        string
	Direct                                              directRequest
	Resume                                              bool
	KnownGateways                                       []gateway.Root
	TelemetryEndpoint                                   string
	TelemetryConsent                                    bool
	Arguments                                           []string
}

func executePlan(_ context.Context, request planCommandInput) (planResult, *diag.Diag) {
	started := time.Now()
	outcome, errorCode := "failure", "KB_INSTALL_OPERATION_FAILED"
	var plan contracts.ResolvedInstallPlan
	defer func() {
		telemetry.Send(request.TelemetryEndpoint, request.TelemetryConsent, telemetry.New("plan", outcome, errorCode,
			string(plan.Request.Platform.Channel), string(plan.Request.Source), len(plan.Artifacts), time.Since(started)))
	}()

	resolved, failure := resolvePlan(planInput{Index: request.Index, RequestFile: request.RequestFile, Direct: request.Direct,
		Operation: "plan", ScenarioID: request.ScenarioID, Answers: request.Answers, Resume: request.Resume,
		Executable: request.Executable, KnownGateways: request.KnownGateways, Arguments: request.Arguments})
	if failure != nil {
		return planResult{}, failure
	}
	plan = resolved.Plan
	if plan.Host != nil {
		if err := host.CheckPorts(plan, "plan"); err != nil {
			return planResult{}, asDiag(err)
		}
	}
	var updateSummary *contracts.UpdateSummary
	activeRoot, layoutErr := activePlatformRoot(plan.Request.PlatformRoot)
	installed := layoutErr == nil
	if layoutErr != nil && !errors.Is(layoutErr, versionroot.ErrPlatformNotInstalled) {
		return planResult{}, unsupportedPlatformLayout(plan.Request.PlatformRoot, layoutErr)
	}
	if installed {
		receiptPath := receipt.Path(activeRoot)
		if _, err := os.Stat(receiptPath); err != nil {
			failure := contracts.NewDiag(contracts.CodeReceiptUnavailable, "the installed receipt could not be checked for update comparison", "check platform-root permissions, then rerun `kb-create plan`", err)
			return planResult{}, failure
		}
		active, readErr := receipt.Read(activeRoot)
		if readErr != nil {
			if failure := receiptArtifactIdentityFailure(readErr, request.Index, plan.Request.PlatformRoot); failure != nil {
				return planResult{}, failure
			}
			failure := contracts.NewDiag(contracts.CodeReceiptUnavailable, "the installed receipt could not be read for update comparison", "restore a named V2 snapshot, then rerun `kb-create plan`", readErr)
			return planResult{}, failure
		}
		plan, failure = planUpdateWithMarketplaceLock(activeRoot, plan, resolved.Catalog, request.RetryCommand)
		if failure != nil {
			return planResult{}, failure
		}
		resolved.Plan = plan
		summary, summaryErr := resolve.SummarizeUpdate(active, plan, resolved.Catalog)
		if summaryErr != nil {
			failure := contracts.NewDiag(contracts.CodeOperationFailed, "the installed platform could not be compared with the resolved plan", "verify the active receipt and sealed release index, then rerun `kb-create plan`", summaryErr)
			return planResult{}, failure
		}
		updateSummary = &summary
	}
	outcome, errorCode = "success", ""
	return planResult{Plan: plan, UpdateSummary: updateSummary}, nil
}

func receiptArtifactIdentityFailure(err error, index, platformRoot string) *diag.Diag {
	var failure *diag.Diag
	if !errors.As(err, &failure) || failure.Code != contracts.CodeArtifactIdentityInvalid {
		return nil
	}
	failure.Hint = "Reinstall this platform with `" + contracts.ShellCommand("kb-create", "apply", "--index", index, "--platform-root", platformRoot) + "`."
	return failure
}

func knownGatewayRoots(executable string) []gateway.Root {
	known := map[string]gateway.Root{}
	remember := func(candidate string) {
		if candidate == "" {
			return
		}
		layout, layoutErr := versionroot.ForPlatformPath(candidate)
		if layoutErr != nil {
			return
		}
		if layoutErr = layout.Validate(); layoutErr != nil {
			return
		}
		if active, readErr := receipt.Read(layout.PlatformRoot()); readErr == nil {
			if url := recordedGatewayURL(active); url != "" && active.InstallationID != "" {
				root := filepath.Clean(layout.PlatformRoot())
				known[root] = gateway.Root{PlatformRoot: root, InstallationID: active.InstallationID, URL: url}
			}
		}
	}
	if owner, ok := shim.Owner(executable); ok {
		remember(owner)
		if state, err := host.StateHome(owner); err == nil {
			if active, ok := host.ActiveHost(state); ok {
				remember(active.PlatformRoot)
			}
		}
	}
	if os.Getenv(host.KBHomeEnv) != "" {
		if state, err := host.StateHome(""); err == nil {
			if active, ok := host.ActiveHost(state); ok {
				remember(active.PlatformRoot)
			}
		}
	}
	result := make([]gateway.Root, 0, len(known))
	for _, root := range known {
		result = append(result, root)
	}
	return result
}

func activePlatformRoot(installRoot string) (string, error) {
	layout, err := versionroot.ForPlatformPath(installRoot)
	if err != nil {
		return "", err
	}
	return layout.ExistingPlatformRoot()
}

// resolvePlan performs the shared, read-only request and release resolution
// used by plan, apply, update, and install. The caller owns operation-specific
// validation and mutation after resolution.
func resolvePlan(input planInput) (resolvedPlan, *diag.Diag) {
	if input.Index == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return resolvedPlan{}, failure(contracts.CodeInputRequired, "the home directory could not be determined", "set HOME or pass --index", err)
		}
		input.Index = savedReleaseIndex(home)
	}
	if input.RequestFile == "" && input.Request == nil && input.Direct.PlatformRoot == "" {
		return resolvedPlan{}, failure(contracts.CodeInputRequired, "--index and either --input or --platform-root are required", "pass immutable release index plus V2 request JSON or direct CI flags", nil)
	}
	source, err := catalog.LoadFile(input.Index)
	if err != nil {
		return resolvedPlan{}, indexFailure(err, "supply a valid immutable V2 release index")
	}
	registryRoot := input.Direct.PlatformRoot
	var requestData []byte
	if input.Request != nil {
		registryRoot = input.Request.PlatformRoot
	} else if input.RequestFile != "" {
		var readErr error
		requestData, readErr = readRequest(input.RequestFile)
		if readErr != nil {
			return resolvedPlan{}, failure("KB_INSTALL_INPUT_REQUIRED", "request could not be read", "supply a readable V2 request JSON file", readErr)
		}
		decoded, decodeErr := transport.DecodeRequest(requestData)
		if decodeErr != nil {
			var validation *contracts.RequestValidationError
			if errors.As(decodeErr, &validation) {
				diagnostic := validation.Diagnostic()
				setRequestRetryHint(diagnostic, input, validation.Field)
				return resolvedPlan{}, diagnostic
			}
			return resolvedPlan{}, failure(contracts.CodeIncompatibleComponents, "request could not be read", "supply a readable V2 request JSON file", decodeErr)
		}
		registryRoot = decoded.PlatformRoot
	}
	registrySource := input.Direct.Registry
	if registrySource == "" {
		registrySource = os.Getenv("npm_config_registry")
	}
	if registrySource == "" && registryRoot != "" {
		activeRoot, activeErr := activePlatformRoot(registryRoot)
		if activeErr == nil {
			active, readErr := receipt.Read(activeRoot)
			if readErr != nil {
				return resolvedPlan{}, failure(contracts.CodeReceiptUnavailable, "recorded registry could not be read", "Inspect the install receipt and rerun the command.", readErr)
			}
			registrySource = active.Plan.Registry
		} else if !errors.Is(activeErr, versionroot.ErrPlatformNotInstalled) {
			return resolvedPlan{}, unsupportedPlatformLayout(registryRoot, activeErr)
		}
	}
	registrySource, registryErr := artifacts.NormalizeSourceURL(registrySource)
	if registryErr != nil {
		return resolvedPlan{}, failure(contracts.CodeInputRequired, "registry source is invalid", "Pass --registry or set npm_config_registry, then rerun the command.", registryErr)
	}
	binarySource, sourceErr := selectBinarySource(input.Direct.BinarySource)
	if sourceErr != nil {
		return resolvedPlan{}, failure(contracts.CodeInputRequired, "binary source is invalid", "Pass an HTTP(S) base URL without credentials using --binary-source or set "+artifacts.BinarySourceEnv+", then rerun the command.", sourceErr)
	}
	planOptions := resolve.Options{LauncherVersion: buildVersion, ProjectRootSelection: input.Operation != "update", BinarySource: binarySource, Registry: registrySource}
	if input.Operation == "update" {
		planOptions.Operation = resolve.OperationUpdate
	}
	var response transport.PlanResponse
	if input.Request != nil {
		data, marshalErr := json.Marshal(input.Request)
		if marshalErr != nil {
			return resolvedPlan{}, failure(contracts.CodeInputRequired, "install request could not be encoded", "correct direct CI flags or provide --input", marshalErr)
		}
		response = transport.PlanWith(data, source, planOptions)
	} else if input.RequestFile != "" {
		data := requestData
		if input.Operation == "update" {
			var request contracts.InstallRequest
			if err := json.Unmarshal(data, &request); err != nil {
				return resolvedPlan{}, failure("KB_INSTALL_INPUT_REQUIRED", "request could not be read", "supply a readable V2 request JSON file", err)
			}
			if sources := input.Direct.marketplaceSources(); sources != nil {
				request.MarketplaceSources = sources
				data, err = json.Marshal(request)
				if err != nil {
					return resolvedPlan{}, failure("KB_INSTALL_INPUT_REQUIRED", "request could not be encoded", "correct the update request JSON, then retry", err)
				}
			}
		}
		response = transport.PlanWith(data, source, planOptions)
	} else {
		request, requestErr := input.Direct.normalize()
		if requestErr != nil {
			var diagnostic *diag.Diag
			if errors.As(requestErr, &diagnostic) {
				return resolvedPlan{}, diagnostic
			}
			var validation *contracts.RequestValidationError
			if errors.As(requestErr, &validation) {
				diagnostic := validation.Diagnostic()
				setRequestRetryHint(diagnostic, input, validation.Field)
				return resolvedPlan{}, diagnostic
			}
			diagnostic = failure("KB_INSTALL_INPUT_REQUIRED", "direct request is invalid", "correct direct CI flags or provide --input", requestErr)
			setRequestRetryHint(diagnostic, input, "request")
			return resolvedPlan{}, diagnostic
		}
		if input.Operation != "update" && request.ProjectRoot != "" {
			request.ProjectRoot, requestErr = contracts.ValidateProjectSelection(request.ProjectRoot)
			if requestErr != nil {
				var validation *contracts.RequestValidationError
				if errors.As(requestErr, &validation) {
					diagnostic := validation.Diagnostic()
					setRequestRetryHint(diagnostic, input, validation.Field)
					return resolvedPlan{}, diagnostic
				}
				return resolvedPlan{}, failure(contracts.CodeInputRequired, "project selection is invalid", "pass an existing project directory, then retry", requestErr)
			}
		}
		if input.ScenarioID != "" {
			if failure := validateInstallTarget(request.PlatformRoot); failure != nil {
				return resolvedPlan{}, failure
			}
		}
		if input.ScenarioID != "" {
			ids, idsErr := scenario.IDs()
			if idsErr != nil {
				return resolvedPlan{}, failure("KB_INSTALL_SCENARIO_INVALID", "scenario catalog could not be read", "reinstall kb-create", idsErr)
			}
			if !slices.Contains(ids, input.ScenarioID) {
				return resolvedPlan{}, failure("KB_INSTALL_SCENARIO_INVALID", "unknown scenario", "Pass --scenario with one of: "+strings.Join(ids, ", "), nil)
			}
			request, requestErr = compileScenario(input.ScenarioID, input.Answers, input.Resume, request)
			if requestErr != nil {
				var staging *versionroot.OwnershipStagingArtifactError
				if errors.Is(requestErr, versionroot.ErrOwnershipPublicationConflict) || errors.As(requestErr, &staging) {
					return resolvedPlan{}, unsupportedPlatformLayout(request.PlatformRoot, requestErr)
				}
				return resolvedPlan{}, failure("KB_INSTALL_SCENARIO_INVALID", "scenario could not be compiled", "inspect scenario answers and manifest requirements", requestErr)
			}
		}
		data, marshalErr := json.Marshal(request)
		if marshalErr != nil {
			return resolvedPlan{}, failure(contracts.CodeInputRequired, "direct request is invalid", "correct direct CI flags or provide --input", marshalErr)
		}
		directOptions := resolve.Options{LauncherVersion: buildVersion, BinarySource: binarySource, Registry: registrySource}
		if input.Operation == "update" {
			directOptions.Operation = resolve.OperationUpdate
		}
		response = transport.PlanWith(data, source, directOptions)
	}
	if !response.OK {
		if response.Error != nil {
			if field, ok := response.Error.Meta["field"].(string); ok {
				setRequestRetryHint(response.Error, input, field)
			}
		}
		return resolvedPlan{}, response.Error
	}
	state, err := host.StateHome(response.Plan.Request.PlatformRoot)
	if err != nil {
		return resolvedPlan{}, asDiag(err)
	}
	if response.Plan.Host != nil && planHasGateway(*response.Plan) {
		root := response.Plan.Request.PlatformRoot
		activeRoot, layoutErr := activePlatformRoot(root)
		installed := layoutErr == nil
		if layoutErr != nil && !errors.Is(layoutErr, versionroot.ErrPlatformNotInstalled) {
			return resolvedPlan{}, unsupportedPlatformLayout(root, layoutErr)
		}
		registry := gateway.Registry{}
		known := make([]gateway.Root, 0, len(input.KnownGateways))
		for _, candidate := range input.KnownGateways {
			if candidate.PlatformRoot == "" || gateway.SameInstallation(candidate.PlatformRoot, root) {
				continue
			}
			candidateLayout, ownerErr := versionroot.ForPlatformPath(candidate.PlatformRoot)
			if ownerErr == nil {
				ownerErr = candidateLayout.Validate()
			}
			if ownerErr == nil {
				candidateRoot := filepath.Clean(candidateLayout.PlatformRoot())
				if slices.ContainsFunc(known, func(existing gateway.Root) bool {
					return gateway.SameInstallation(existing.PlatformRoot, candidateRoot)
				}) {
					continue
				}
				activeOwner, readErr := receipt.Read(candidateRoot)
				if readErr != nil {
					continue
				}
				if ownerURL := recordedGatewayURL(activeOwner); ownerURL != "" && activeOwner.InstallationID != "" {
					known = append(known, gateway.Root{PlatformRoot: candidateRoot, InstallationID: activeOwner.InstallationID, URL: ownerURL})
				}
			}
		}
		requestedURL := response.Plan.Request.GatewayURL
		if installed && requestedURL == "" {
			if active, activeErr := receipt.Read(activeRoot); activeErr == nil {
				requestedURL = recordedGatewayURL(active)
			}
		}
		defaultURL, originErr := gateway.OriginFromHealthURL(response.Plan.Host.HealthURL)
		if originErr != nil {
			return resolvedPlan{}, contracts.HostSpecDiagnostic("the release Gateway address is invalid", "select a release with a valid loopback Gateway health URL", originErr.Error(), originErr)
		}
		selectedURL, allocErr := registry.AllocateWithKnown(root, defaultURL, requestedURL, known, response.Plan.ServiceGraph)
		if allocErr != nil {
			return resolvedPlan{}, asDiag(allocErr)
		}
		claimant, claimed, claimErr := registry.ClaimantAmong(root, selectedURL, known)
		if claimErr != nil {
			return resolvedPlan{}, asDiag(claimErr)
		}
		if claimed {
			if running := host.GatewayResourceConflict(selectedURL, input.Operation, claimant.PlatformRoot); running != nil {
				return resolvedPlan{}, running
			}
			diagnostic, diagnosticErr := gatewayAddressClaimConflict(selectedURL, claimant.PlatformRoot, input.Operation)
			if diagnosticErr != nil {
				return resolvedPlan{}, contracts.HostSpecDiagnostic("the selected Gateway address is invalid", "choose a valid loopback Gateway URL, then rerun `kb-create "+input.Operation+"`", diagnosticErr.Error(), diagnosticErr)
			}
			return resolvedPlan{}, diagnostic
		}
		if selectedURL != response.Plan.Request.GatewayURL {
			request := response.Plan.Request
			request.GatewayURL = selectedURL
			data, marshalErr := json.Marshal(request)
			if marshalErr != nil {
				return resolvedPlan{}, failure(contracts.CodeInputRequired, "the install request could not be encoded", "rerun `kb-create plan` with the same request", marshalErr)
			}
			response = transport.PlanWith(data, source, planOptions)
			if !response.OK {
				if response.Error != nil {
					if field, ok := response.Error.Meta["field"].(string); ok {
						setRequestRetryHint(response.Error, input, field)
					}
				}
				return resolvedPlan{}, response.Error
			}
		}
	}
	return resolvedPlan{Catalog: source, Plan: *response.Plan, State: state}, nil
}

func gatewayAddressClaimConflict(gatewayURL, platformRoot, operation string) (*diag.Diag, error) {
	parsed, err := url.Parse(gatewayURL)
	if err != nil || parsed.Port() == "" {
		return nil, fmt.Errorf("Gateway address %q has no valid port", gatewayURL)
	}
	diagnostic := contracts.NewDiag(contracts.CodePortInUse,
		"Gateway address "+gatewayURL+" is already assigned to installed root "+platformRoot+".",
		"Choose another loopback Gateway URL, then rerun `"+contracts.ShellCommand("kb-create", operation, "--gateway-url", "<url>")+"`.", nil)
	diagnostic.Meta = map[string]any{"address": gatewayURL, "port": parsed.Port(), "platformRoot": platformRoot}
	diagnostic.Meta["operation"] = operation
	return diagnostic, nil
}

func setRequestRetryHint(diagnostic *diag.Diag, input planInput, field string) {
	if diagnostic.Meta == nil {
		diagnostic.Meta = make(map[string]any)
	}
	diagnostic.Meta["field"] = field
	if len(input.Arguments) == 0 {
		return
	}
	command, variables := retryArguments(input.Arguments)
	diagnostic.Hint += " Retry: " + command
	if len(variables) > 0 {
		diagnostic.Hint += " Set " + strings.Join(variables, ", ") + " before retrying. Use URL-encoded passwords and JSON-escaped string contents for scenario secrets."
	}
}

func retryArguments(args []string) (string, []string) {
	parts := []string{contracts.ShellQuote("kb-create")}
	var variables []string
	for i, arg := range args {
		name, value, hasEquals := strings.Cut(arg, "=")
		if (i > 0 && args[i-1] == "--scenario-answers") || (hasEquals && name == "--scenario-answers") {
			prefix := ""
			if hasEquals && name == "--scenario-answers" {
				prefix = contracts.ShellQuote(name + "=")
			} else {
				value = arg
			}
			redacted, required := retryScenarioAnswers(value)
			parts = append(parts, prefix+redacted)
			variables = append(variables, required...)
			continue
		}
		urlValue, optionPrefix := arg, ""
		flagName := ""
		if hasEquals && strings.HasPrefix(name, "--") {
			urlValue, optionPrefix = value, name+"="
			flagName = strings.TrimPrefix(name, "--")
		} else if i > 0 {
			flagName = strings.TrimPrefix(args[i-1], "--")
		}
		parsed, err := url.Parse(urlValue)
		if definition, exists := flagCatalog[flagName]; exists && definition.URL && (err != nil || parsed.Host == "") {
			start := strings.Index(urlValue, "://")
			if start >= 0 {
				start += 3
			} else {
				start = 0
			}
			authority := urlValue[start:]
			if end := strings.IndexAny(authority, "/?#"); end >= 0 {
				authority = authority[:end]
			}
			at := strings.LastIndexByte(authority, '@')
			if at >= 0 {
				colon := strings.IndexByte(authority[:at], ':')
				if colon >= 0 {
					variable := fmt.Sprintf("%s_%d", diag.KB_URL_PASSWORD, len(variables)+1)
					parts = append(parts, contracts.ShellQuote(optionPrefix+urlValue[:start+colon+1])+retryVariable(variable)+contracts.ShellQuote(urlValue[start+at:]))
					variables = append(variables, variable)
					continue
				}
			}
		}
		if err == nil && parsed.User != nil && parsed.Scheme != "" && parsed.Host != "" {
			_, hasPassword := parsed.User.Password()
			if !hasPassword {
				parts = append(parts, contracts.ShellQuote(arg))
				continue
			}
			start := strings.Index(urlValue, "://") + 3
			end := strings.Index(urlValue[start:], "@"+parsed.Host)
			if start < 3 || end < 0 {
				variable := fmt.Sprintf("%s_%d", diag.KB_URL_PASSWORD, len(variables)+1)
				parts = append(parts, contracts.ShellQuote(optionPrefix)+retryVariable(variable))
				variables = append(variables, variable)
				continue
			}
			colon := strings.IndexByte(urlValue[start:start+end], ':')
			if colon < 0 {
				variable := fmt.Sprintf("%s_%d", diag.KB_URL_PASSWORD, len(variables)+1)
				parts = append(parts, contracts.ShellQuote(optionPrefix)+retryVariable(variable))
				variables = append(variables, variable)
				continue
			}
			variable := fmt.Sprintf("%s_%d", diag.KB_URL_PASSWORD, len(variables)+1)
			parts = append(parts, contracts.ShellQuote(optionPrefix+urlValue[:start+colon+1])+retryVariable(variable)+contracts.ShellQuote(urlValue[start+end:]))
			variables = append(variables, variable)
			continue
		}
		parts = append(parts, contracts.ShellQuote(arg))
	}
	return strings.Join(parts, " "), variables
}

func retryScenarioAnswers(value string) (string, []string) {
	var answers map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &answers) != nil || answers == nil {
		return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
	}
	ids, err := scenario.IDs()
	if err != nil {
		return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
	}
	fields := map[string]bool{}
	for _, id := range ids {
		definition, err := scenario.Load(id)
		if err != nil {
			return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
		}
		for _, field := range definition.Fields {
			fields[field.ID] = fields[field.ID] || field.Secret
		}
		for _, page := range definition.Pages {
			for _, section := range page.Sections {
				for _, field := range section.Fields {
					fields[field.ID] = fields[field.ID] || field.Secret
				}
			}
		}
	}
	decoder := json.NewDecoder(strings.NewReader(value))
	if _, err := decoder.Token(); err != nil {
		return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
	}
	var parts []string
	var variables []string
	last := 0
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
		}
		key, ok := token.(string)
		if !ok {
			return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
		}
		start := int(decoder.InputOffset())
		for start < len(value) && (value[start] == ':' || value[start] == ' ' || value[start] == '\n' || value[start] == '\r' || value[start] == '\t') {
			start++
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
		}
		end := int(decoder.InputOffset())
		secret, known := fields[key]
		if secret || !known {
			var stringValue string
			if json.Unmarshal(raw, &stringValue) != nil {
				return retryVariable(diag.KB_SCENARIO_ANSWERS), []string{diag.KB_SCENARIO_ANSWERS}
			}
			variable := fmt.Sprintf("%s_%d", diag.KB_SCENARIO_SECRET, len(variables)+1)
			parts = append(parts, contracts.ShellQuote(value[last:start]+`"`)+retryVariable(variable)+contracts.ShellQuote(`"`))
			variables = append(variables, variable)
			last = end
		}
	}
	if len(variables) == 0 {
		return contracts.ShellQuote(value), nil
	}
	parts = append(parts, contracts.ShellQuote(value[last:]))
	return strings.Join(parts, ""), variables
}

func retryVariable(name string) string { return `"$` + name + `"` }

func readRequest(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read request %q: %w", path, err)
	}
	return data, nil
}

func indexFailure(err error, hint string) *diag.Diag {
	var typed *diag.Diag
	if errors.As(err, &typed) {
		return typed
	}
	return contracts.NewDiag(contracts.CodeReleaseIndexInvalid, "The release index could not be loaded.", hint, err)
}

// selectBinarySource resolves command input once before building the immutable plan.
func selectBinarySource(flag string) (string, error) {
	source := flag
	if source == "" {
		source = os.Getenv(artifacts.BinarySourceEnv)
	}
	if source == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		data, err := os.ReadFile(filepath.Join(filepath.Dir(savedReleaseIndex(home)), "binary-source"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		source = strings.TrimSpace(string(data))
	}
	return artifacts.NormalizeSourceURL(source)
}
