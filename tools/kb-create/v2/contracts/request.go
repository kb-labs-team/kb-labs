// Package contracts contains the versioned V2 launcher boundary shared by
// humans, CI, agents, resolver, engine adapters and recovery tooling.
package contracts

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	marketplaceinstallspec "github.com/kb-labs/create/v2/marketplace/install_spec"
)

const RequestSchema = "kb.create/v2"

type Channel string

const (
	ChannelStable       Channel = "stable"
	ChannelCanary       Channel = "canary"
	ChannelExperimental Channel = "experimental"
)

type CompatibilityPolicy string

const (
	PolicyStrict     CompatibilityPolicy = "strict"
	PolicyCompatible CompatibilityPolicy = "compatible"
)

type ArtifactSource string

const (
	SourceRegistry ArtifactSource = "registry"
	SourceOffline  ArtifactSource = "offline"
)

// VersionSelector identifies an artifact by an immutable version or a
// channel. Resolver output always contains an immutable version and hash.
type VersionSelector struct {
	Version string  `json:"version,omitempty"`
	Channel Channel `json:"channel,omitempty"`
}

// ComponentRequest is an independently versioned plugin or adapter request.
// Platform services are not components here: they are owned by the selected
// platform bundle and resolved from its release manifest.
type ComponentRequest struct {
	ID      string          `json:"id"`
	Version VersionSelector `json:"version,omitempty"`
}

// MarketplaceSources contains install-time endpoints and environment-variable
// names. Secret values are never accepted or persisted by this request. The
// declared source contract is core/config/src/types/marketplace.ts; the Go
// projection is guarded by render/render_test.go's schema validation test.
type MarketplaceSources struct {
	RegistryURL         string `json:"registryUrl"`
	SigningPublicKeyEnv string `json:"signingPublicKeyEnv"`
	RegistryTokenEnv    string `json:"registryTokenEnv,omitempty"`
	NpmURL              string `json:"npmUrl,omitempty"`
}

// MarketplaceInstallRecord joins the exact Marketplace install spec with the
// resolved manifest identity and source after the host becomes ready.
type MarketplaceInstallRecord struct {
	ID              string `json:"id"`
	Spec            string `json:"spec"`
	Version         string `json:"version"`
	PrimaryKind     string `json:"primaryKind"`
	Source          string `json:"source"`
	SignatureStatus string `json:"signatureStatus"`
}

// InstallRequest is deliberately transport-neutral. Wizard answers, CI flags,
// agent protocol messages and scenario files all normalize to this type before
// resolution. Values only carry non-secret input; secret input is referenced by
// key and retrieved through the engine's secret store at apply time.
type InstallRequest struct {
	Schema                  string              `json:"schema"`
	Platform                VersionSelector     `json:"platform"`
	SDK                     VersionSelector     `json:"sdk,omitempty"`
	ServiceProfile          string              `json:"serviceProfile,omitempty"`
	GatewayURL              string              `json:"gatewayUrl,omitempty"`
	MarketplaceSources      *MarketplaceSources `json:"marketplaceSources,omitempty"`
	Plugins                 []ComponentRequest  `json:"plugins,omitempty"`
	MarketplaceInstallSpecs []string            `json:"marketplaceInstallSpecs,omitempty"`
	Adapters                []ComponentRequest  `json:"adapters,omitempty"`
	ProviderPreferences     map[string]string   `json:"providerPreferences,omitempty"`
	Values                  map[string]string   `json:"values,omitempty"`
	SecretInputs            []string            `json:"secretInputs,omitempty"`
	Policy                  CompatibilityPolicy `json:"policy"`
	Source                  ArtifactSource      `json:"source"`
	ScenarioID              string              `json:"scenarioId,omitempty"`
	// ScenarioStateDigest is a non-secret checksum of persisted scenario
	// answers. It is provenance only: the resolver never treats it as input.
	ScenarioStateDigest string `json:"scenarioStateDigest,omitempty"`
	PlatformRoot        string `json:"platformRoot"`
	ProjectRoot         string `json:"projectRoot,omitempty"`
}

// RequestValidationError identifies the request field that needs correction at
// the shared V2 request boundary.
type RequestValidationError struct {
	Field   string
	Message string
	Hint    string
	Cause   error
}

func (e *RequestValidationError) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *RequestValidationError) Unwrap() error { return e.Cause }

func invalidRequestField(field, message, action string, cause error) error {
	return &RequestValidationError{
		Field: field, Message: message,
		Hint: action, Cause: cause,
	}
}

func (r InstallRequest) Normalize() (InstallRequest, error) {
	r.ServiceProfile = strings.TrimSpace(r.ServiceProfile)
	if r.ServiceProfile == "" {
		r.ServiceProfile = "default"
	}
	if r.Schema == "" {
		r.Schema = RequestSchema
	}
	if r.Schema != RequestSchema {
		return InstallRequest{}, invalidRequestField("schema",
			fmt.Sprintf("unsupported request schema %q", r.Schema), "Set schema to `kb.create/v2` in the request JSON, then retry.", nil)
	}
	if source := r.MarketplaceSources; source != nil {
		hasRegistry := source.RegistryURL != "" || source.SigningPublicKeyEnv != ""
		if hasRegistry && (source.RegistryURL == "" || source.SigningPublicKeyEnv == "") {
			return InstallRequest{}, invalidRequestField("marketplaceSources",
				"Marketplace Registry URL and signing public-key environment variable are required together",
				"Set --marketplace-registry-url and --marketplace-registry-public-key-env, then rerun `kb-create plan`.", nil)
		}
		if !hasRegistry && source.NpmURL == "" {
			return InstallRequest{}, invalidRequestField("marketplaceSources",
				"Marketplace source configuration must include a Registry or npm URL",
				"Set --marketplace-registry-url with its signing-key reference or set --marketplace-npm-url, then rerun `kb-create plan`.", nil)
		}
		if source.RegistryTokenEnv != "" && !hasRegistry {
			return InstallRequest{}, invalidRequestField("marketplaceSources.registryTokenEnv",
				"Marketplace Registry token reference requires a Registry URL and signing-key reference",
				"Set --marketplace-registry-url and --marketplace-registry-public-key-env with the token reference, then rerun `kb-create plan`.", nil)
		}
		for field, name := range map[string]string{"signingPublicKeyEnv": source.SigningPublicKeyEnv, "registryTokenEnv": source.RegistryTokenEnv} {
			if name != "" && !validEnvironmentVariableName(name) {
				return InstallRequest{}, invalidRequestField("marketplaceSources."+field,
					"Marketplace credential reference must be an environment variable name",
					"Set the Marketplace credential flag to an environment variable name such as KB_REGISTRY_KEY, then rerun `kb-create plan`.", nil)
			}
		}
		for field, endpoint := range map[string]string{"registryUrl": source.RegistryURL, "npmUrl": source.NpmURL} {
			if endpoint == "" {
				continue
			}
			parsed, err := url.Parse(endpoint)
			if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
				return InstallRequest{}, invalidRequestField("marketplaceSources."+field,
					"Marketplace source URL must be an absolute HTTP(S) URL without embedded credentials",
					"Set the Marketplace source URL to an absolute HTTP(S) URL, then rerun `kb-create plan`.", err)
			}
		}
	}
	if r.Platform.Version == "" && r.Platform.Channel == "" {
		r.Platform.Channel = ChannelStable
	}
	if err := validateSelector("platform", r.Platform); err != nil {
		return InstallRequest{}, err
	}
	if err := validateSelector("sdk", r.SDK); err != nil {
		return InstallRequest{}, err
	}
	if r.GatewayURL != "" {
		parsed, err := url.Parse(r.GatewayURL)
		if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Port() == "" ||
			(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			// URL parse errors can quote fragments of credentials; the validation
			// message supplies the safe, actionable reason instead.
			return InstallRequest{}, invalidRequestField("gatewayUrl",
				"gateway URL must be an http loopback origin with an explicit port",
				"Set gatewayUrl to an http loopback origin with an explicit port in the request JSON, then retry.", nil)
		}
		port, err := strconv.Atoi(parsed.Port())
		if err != nil || port < 1 || port > 65535 {
			return InstallRequest{}, invalidRequestField("gatewayUrl",
				"gateway URL port must be between 1 and 65535",
				"Set gatewayUrl to an http loopback origin with a port from 1 to 65535, then retry.", err)
		}
		hostname := parsed.Hostname()
		ip := net.ParseIP(hostname)
		if hostname != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return InstallRequest{}, invalidRequestField("gatewayUrl",
				"gateway URL must use a loopback host",
				"Set gatewayUrl to use localhost or a loopback IP address, then retry.", nil)
		}
		r.GatewayURL = "http://" + parsed.Host
	}
	if r.Policy == "" {
		r.Policy = PolicyStrict
	}
	if r.Policy != PolicyStrict && r.Policy != PolicyCompatible {
		return InstallRequest{}, invalidRequestField("policy",
			fmt.Sprintf("unsupported compatibility policy %q", r.Policy),
			"Set policy to `strict` or `compatible` in the request JSON, then retry.", nil)
	}
	if r.Source == "" {
		r.Source = SourceRegistry
	}
	if r.Source != SourceRegistry && r.Source != SourceOffline {
		return InstallRequest{}, invalidRequestField("source",
			fmt.Sprintf("unsupported artifact source %q", r.Source),
			"Set source to `registry` or `offline` in the request JSON, then retry.", nil)
	}
	if r.PlatformRoot == "" {
		return InstallRequest{}, invalidRequestField("platformRoot", "platformRoot is required",
			"Set `platformRoot` to a non-empty directory in the request JSON.", nil)
	}
	// Resolve user supplied paths at the request boundary so later execution
	// never interprets a relative root against a changed working directory.
	root, err := CanonicalPath(r.PlatformRoot)
	if err != nil {
		return InstallRequest{}, invalidRequestField("platformRoot", "platform root could not be resolved",
			"Set `platformRoot` to a directory path that can be resolved in the request JSON.", err)
	}
	r.PlatformRoot = root
	if r.ProjectRoot != "" {
		project, err := AbsolutePath(r.ProjectRoot)
		if err != nil {
			return InstallRequest{}, invalidRequestField("projectRoot", "project directory could not be resolved",
				"Pass a project directory path that can be resolved, then retry.", err)
		}
		r.ProjectRoot = project
	}
	plugins, err := normalizeComponents("plugin", r.Plugins)
	if err != nil {
		return InstallRequest{}, err
	}
	adapters, err := normalizeComponents("adapter", r.Adapters)
	if err != nil {
		return InstallRequest{}, err
	}
	r.Plugins = plugins
	for _, spec := range r.MarketplaceInstallSpecs {
		if err := marketplaceinstallspec.Validate(spec); err != nil {
			return InstallRequest{}, invalidRequestField("marketplaceInstallSpecs", "scenario contains an invalid Marketplace install spec", "Correct the Marketplace install spec and rerun `kb-create plan`.", err)
		}
	}
	r.Adapters = adapters
	r.SecretInputs = uniqueSorted(r.SecretInputs)
	for _, key := range r.SecretInputs {
		delete(r.Values, key)
	}
	return r, nil
}

func validEnvironmentVariableName(value string) bool {
	for index, char := range value {
		valid := char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || index > 0 && char >= '0' && char <= '9'
		if !valid {
			return false
		}
	}
	return value != ""
}

// ValidateProjectSelection resolves a project path selected for registration
// and requires it to identify an existing directory. Request normalization
// does not call this because replaying an installed request does not select or
// write to its project.
func ValidateProjectSelection(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	absolute, err := AbsolutePath(value)
	if err != nil {
		return "", invalidRequestField("projectRoot", "project directory could not be resolved",
			"Pass an existing project directory, then retry.", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		if os.IsNotExist(err) {
			if _, linkErr := os.Lstat(absolute); os.IsNotExist(linkErr) {
				return "", invalidRequestField("projectRoot", "the selected project directory must exist",
					fmt.Sprintf("Create it with `%s` or pass an existing project directory, then retry.", ShellCommand("mkdir", "-p", value)), err)
			}
			return "", invalidRequestField("projectRoot", "the selected project path does not resolve to an existing directory",
				"Pass an existing project directory, then retry.", err)
		}
		return "", invalidRequestField("projectRoot", "the selected project directory could not be checked",
			"Pass an existing project directory, then retry.", err)
	}
	if !info.IsDir() {
		return "", invalidRequestField("projectRoot", "the selected project path is not a directory",
			"Pass an existing project directory, then retry.", nil)
	}
	return absolute, nil
}

// ShellQuote returns a POSIX shell-safe single-quoted argument for actionable
// hints. ParseShellCommands parses this word grammar for exact argv execution.
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

// CanonicalPath resolves existing path components and preserves missing
// trailing components, giving install-root requests one filesystem identity.
func CanonicalPath(value string) (string, error) {
	abs, err := AbsolutePath(value)
	if err != nil {
		return "", err
	}
	missing := make([]string, 0)
	for current := filepath.Clean(abs); ; current = filepath.Dir(current) {
		_, err := os.Lstat(current)
		if err == nil {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("no existing ancestor for %q", value)
		}
		missing = append(missing, filepath.Base(current))
	}
}

// AbsolutePath applies the lexical absolute-path rule used for non-install
// paths. It cleans path syntax without resolving filesystem identity.
func AbsolutePath(value string) (string, error) {
	if filepath.IsAbs(value) {
		return filepath.Clean(value), nil
	}
	path, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	return filepath.Clean(path), nil
}

func validateSelector(name string, selector VersionSelector) error {
	field := name + ".version"
	if selector.Channel != "" {
		field = name + ".channel"
	}
	if selector.Version != "" && selector.Channel != "" {
		return invalidRequestField(name,
			fmt.Sprintf("%s cannot specify both version and channel", name),
			fmt.Sprintf("Set either `%s.version` or `%s.channel` in the request JSON, then retry.", name, name), nil)
	}
	if selector.Channel != "" && selector.Channel != ChannelStable && selector.Channel != ChannelCanary && selector.Channel != ChannelExperimental {
		return invalidRequestField(field,
			fmt.Sprintf("unsupported %s channel %q", name, selector.Channel),
			fmt.Sprintf("Set `%s` to `stable`, `canary`, or `experimental` in the request JSON, then retry.", field), nil)
	}
	return nil
}

func normalizeComponents(kind string, components []ComponentRequest) ([]ComponentRequest, error) {
	seen := make(map[string]struct{}, len(components))
	result := make([]ComponentRequest, 0, len(components))
	for _, component := range components {
		if component.ID == "" {
			return nil, invalidRequestField(kind+"s[].id",
				fmt.Sprintf("%s ID is required", kind),
				fmt.Sprintf("Set an `id` for every entry in `%ss` in the request JSON, then retry.", kind), nil)
		}
		if _, exists := seen[component.ID]; exists {
			return nil, invalidRequestField(kind+"s",
				fmt.Sprintf("duplicate %s %q", kind, component.ID),
				fmt.Sprintf("Remove the duplicate `%s` entry from `%ss` in the request JSON, then retry.", component.ID, kind), nil)
		}
		if err := validateSelector(kind+"s["+component.ID+"]", component.Version); err != nil {
			return nil, err
		}
		seen[component.ID] = struct{}{}
		result = append(result, component)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != "" {
			seen[value] = struct{}{}
		}
	}
	result := make([]string, 0, len(seen))
	for value := range seen {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

// PathWithin reports whether path resolves to root or a descendant of root.
// Missing trailing components are allowed; existing symlinks are resolved.
func PathWithin(root, path string) (bool, error) {
	canonicalRoot, err := CanonicalPath(root)
	if err != nil {
		return false, fmt.Errorf("resolve containment root: %w", err)
	}
	canonicalPath, err := CanonicalPath(path)
	if err != nil {
		return false, fmt.Errorf("resolve containment path: %w", err)
	}
	relative, err := filepath.Rel(canonicalRoot, canonicalPath)
	if err != nil {
		return false, err
	}
	return filepath.IsLocal(relative), nil
}
