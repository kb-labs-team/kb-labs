// Package v2cli is the public V2 kb-create frontend. Both the released root
// binary and package-local tests enter through Execute, so there is exactly one
// launcher command surface and no legacy dispatcher to keep in sync.
package v2cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kb-labs/clikit/diag"

	clikitcommand "github.com/kb-labs/clikit/command"
	"github.com/kb-labs/create/v2/artifacts"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/gateway"
	"github.com/kb-labs/create/v2/marketplace"
	"github.com/kb-labs/create/v2/preflight"
	"github.com/kb-labs/create/v2/runtime"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/shim"
	"github.com/spf13/cobra"
)

var buildVersion = "dev"
var buildCommit = "none"

type repeatedValue []string

type projectRegistrationResult struct {
	ID             string
	CanonicalPath  string
	AlreadyExisted bool
}

type applyCommandResult struct {
	OK                        bool                     `json:"ok"`
	Operation                 string                   `json:"operation"`
	Receipt                   contracts.InstallReceipt `json:"receipt"`
	LogPath                   string                   `json:"logPath"`
	Profile                   string                   `json:"profile"`
	Services                  []contracts.Service      `json:"services"`
	Shim                      *shim.EnsureResult       `json:"shim,omitempty"`
	FirstAdmin                *firstAdminCredential    `json:"firstAdmin,omitempty"`
	ProjectRegistrationNotice string                   `json:"projectRegistrationNotice,omitempty"`
	disclosureStoreRoot       string
}

type firstAdminState string

const (
	firstAdminDisclosed           firstAdminState = "disclosed"
	firstAdminSupplied            firstAdminState = "supplied"
	firstAdminPreviouslyDisclosed firstAdminState = "previously-disclosed"
)

type firstAdminCredential struct {
	State           firstAdminState `json:"state"`
	Email           string          `json:"email"`
	Password        string          `json:"password,omitempty"`
	Notice          string          `json:"notice,omitempty"`
	RecoveryCommand string          `json:"recoveryCommand,omitempty"`
	StopCommand     string          `json:"stopCommand,omitempty"`
	StartCommand    string          `json:"startCommand,omitempty"`
}

func (values *repeatedValue) String() string { return strings.Join(*values, ",") }
func (values *repeatedValue) Type() string   { return "string" }
func (values *repeatedValue) Set(value string) error {
	*values = append(*values, value)
	return nil
}
func (values *repeatedValue) ResetFlagValue(defaultValue string) error {
	*values = nil
	if defaultValue == "" {
		return nil
	}
	return values.Set(defaultValue)
}

// SetVersionInfo exposes the build identity to diagnostics without changing
// the human --version output contract.
func SetVersionInfo(version, commit, _ string) {
	if version != "" {
		buildVersion = version
	}
	if commit != "" {
		buildCommit = commit
	}
}

// Execute runs the public kb-create Cobra tree through the shared clikit boundary.
func Execute() diag.ExitStatus {
	root := newRootCommand()
	root.Version = buildVersion
	root.SetVersionTemplate("kb-create {{.Version}}\n")
	return clikitcommand.Execute(root, os.Args[1:], os.Stdout, os.Stderr)
}

type directRequest struct {
	Registry                                                                                                                       string
	BinarySource                                                                                                                   string
	PlatformRoot, ProjectRoot, PlatformVersion, PlatformChannel, SDKVersion, ServiceProfile, GatewayURL, Plugins, Adapters, Policy string
	MarketplaceRegistryURL, MarketplaceSigningKeyEnv, MarketplaceTokenEnv, MarketplaceNpmURL                                       string
	Providers                                                                                                                      []string
	Offline                                                                                                                        bool
}

type commandDependencies struct {
	Runtime          *runtime.Dependencies
	ArtifactRunner   artifacts.Runner
	NodeCheck        func() error
	InstallInput     io.Reader
	InstallOutput    io.Writer
	ProjectRegistrar func(string, string) (projectRegistrationResult, error)
	Marketplace      marketplace.InstallClient
	Command          *cobra.Command
	Executable       string
}

func productionCommandDependencies(command *cobra.Command) commandDependencies {
	return commandDependencies{
		Runtime:       &runtime.Dependencies{},
		NodeCheck:     func() error { return preflight.EnsureNode(nil) },
		InstallInput:  clikitcommand.FromCommand(command).Input(),
		InstallOutput: clikitcommand.FromCommand(command).ProgressWriter(),
		Command:       command,
		Executable:    executablePath(),
		ProjectRegistrar: func(platformRoot, projectRoot string) (projectRegistrationResult, error) {
			return registerInstalledProject(platformRoot, projectRoot, nil)
		},
	}
}

func recordedGatewayURL(active contracts.InstallReceipt) string {
	if active.Plan.Request.GatewayURL != "" {
		return active.Plan.Request.GatewayURL
	}
	origin, _ := gateway.OriginFromHealthURL(active.Verification.HostHealthURL)
	return origin
}

func planHasGateway(plan contracts.ResolvedInstallPlan) bool {
	for _, service := range plan.ServiceGraph.Services {
		if service.ID == "gateway" {
			return true
		}
	}
	return false
}

func progressWriteFailure(err error, next string) *diag.Diag {
	command := contracts.ShellCommand("kb-create", next)
	return contracts.NewDiag("KB_RUNTIME_UNEXPECTED", "Command progress could not be written.",
		fmt.Sprintf("Check that command output is writable, then run `%s` to verify the installation.", command), err)
}

// runInstall is the human frontend. It gathers answers, prints the shared
// resolver's plan, then invokes the same apply engine used by JSON callers.
type humanProgress struct {
	out     io.Writer
	started map[string]time.Time
}

func (p *humanProgress) Emit(event runtime.ProgressEvent) error {
	if event.Start {
		p.started[event.Phase] = time.Now()
		if _, err := fmt.Fprintf(p.out, "  … %s\n", event.Phase); err != nil {
			delete(p.started, event.Phase)
			return progressWriteFailure(err, "apply")
		}
		return nil
	}
	started, ok := p.started[event.Phase]
	if !ok {
		return nil
	}
	if _, err := fmt.Fprintf(p.out, "  ✓ %s (%s)\n", event.Phase, time.Since(started).Round(time.Millisecond)); err != nil {
		return progressWriteFailure(err, "apply")
	}
	delete(p.started, event.Phase)
	return nil
}

// runStatus reports the host of the receipt-owned installation without
// resolving a new release, so it is safe for stable, canary and exact-version
// installations: it describes the immutable decision that was actually applied.
func requestWithGeneratedSecrets(request contracts.InstallRequest, artifacts []contracts.Artifact) (contracts.InstallRequest, bool, error) {
	known := make(map[string]bool, len(request.SecretInputs))
	for _, id := range request.SecretInputs {
		known[id] = true
	}
	changed := false
	for _, artifact := range artifacts {
		for _, requirement := range artifact.Config {
			if requirement.Secret && requirement.Generate && !known[requirement.ID] {
				request.SecretInputs = append(request.SecretInputs, requirement.ID)
				known[requirement.ID] = true
				changed = true
			}
		}
	}
	if changed {
		var err error
		request, err = request.Normalize()
		if err != nil {
			return contracts.InstallRequest{}, false, err
		}
	}
	return request, changed, nil
}

func defaultPlatformRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "kb-platform")
}

func populateSecrets(store secrets.Store, mappings string) error {
	for _, mapping := range splitSecretMappings(mappings) {
		name, environment := mapping[0], mapping[1]
		if environment == "" {
			return errors.New("secret mapping must use requirement=ENV_VAR")
		}
		value, exists := os.LookupEnv(environment)
		if !exists || value == "" {
			return errors.New("the required secret environment value is not set")
		}
		if err := store.Put(name, value); err != nil {
			return err
		}
	}
	return nil
}

func splitSecretMappings(mappings string) [][2]string {
	if strings.TrimSpace(mappings) == "" {
		return nil
	}
	values := make([][2]string, 0)
	for _, pair := range strings.Split(mappings, ",") {
		name, environment, ok := strings.Cut(strings.TrimSpace(pair), "=")
		if !ok || strings.TrimSpace(name) == "" || strings.TrimSpace(environment) == "" {
			values = append(values, [2]string{strings.TrimSpace(pair), ""})
			continue
		}
		values = append(values, [2]string{strings.TrimSpace(name), strings.TrimSpace(environment)})
	}
	return values
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

func (value directRequest) normalize() (contracts.InstallRequest, error) {
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, PlatformRoot: value.PlatformRoot, ProjectRoot: value.ProjectRoot, Platform: contracts.VersionSelector{Version: value.PlatformVersion, Channel: contracts.Channel(value.PlatformChannel)}, SDK: contracts.VersionSelector{Version: value.SDKVersion}, ServiceProfile: value.ServiceProfile, GatewayURL: value.GatewayURL, Policy: contracts.CompatibilityPolicy(value.Policy), Source: contracts.SourceRegistry, MarketplaceSources: value.marketplaceSources()}
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
	request.ProviderPreferences, err = parseProviders(value.Providers)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	return request.Normalize()
}

func (value directRequest) marketplaceSources() *contracts.MarketplaceSources {
	if value.MarketplaceRegistryURL == "" && value.MarketplaceSigningKeyEnv == "" && value.MarketplaceTokenEnv == "" && value.MarketplaceNpmURL == "" {
		return nil
	}
	return &contracts.MarketplaceSources{RegistryURL: value.MarketplaceRegistryURL, SigningPublicKeyEnv: value.MarketplaceSigningKeyEnv, RegistryTokenEnv: value.MarketplaceTokenEnv, NpmURL: value.MarketplaceNpmURL}
}

func configuredFirstAdmin(request contracts.InstallRequest) (string, bool) {
	if request.Values["gateway.access.mode"] != `"secured"` {
		return "", false
	}
	var email string
	if err := json.Unmarshal([]byte(request.Values["gateway.bootstrap.adminEmail"]), &email); err != nil || email == "" {
		return "", false
	}
	return email, true
}

func parseProviders(values []string) (map[string]string, error) {
	preferences := map[string]string{}
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			capability, adapter, ok := strings.Cut(item, "=")
			capability, adapter = strings.TrimSpace(capability), strings.TrimSpace(adapter)
			if !ok || capability == "" || adapter == "" {
				if item == "" {
					return nil, diag.New("KB_RUNTIME_INPUT_INVALID", "The --provider flag contains an empty item.", diag.WithHint("Pass each provider as capability=adapter, or omit --provider for automatic selection, then rerun `kb-create plan`."))
				}
				return nil, fmt.Errorf("provider %q must be capability=adapter", item)
			}
			if _, exists := preferences[capability]; exists {
				return nil, fmt.Errorf("provider for capability %q was specified more than once", capability)
			}
			preferences[capability] = adapter
		}
	}
	return preferences, nil
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

func failure(code, message, hint string, cause error) *diag.Diag {
	return contracts.NewDiag(code, message, hint, cause)
}
