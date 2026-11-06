// Package wizard is a deliberately thin human frontend. It gathers a V2
// InstallRequest and delegates compatibility decisions to the shared resolver;
// it never carries installer state or recreates an interactive-only plan.
package wizard

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/charmbracelet/x/term"
	"github.com/kb-labs/create/v2/catalog"
	"github.com/kb-labs/create/v2/contracts"
	"github.com/kb-labs/create/v2/flow"
	"github.com/kb-labs/create/v2/scenario"
	"github.com/kb-labs/create/v2/secrets"
	"github.com/kb-labs/create/v2/versionroot"
)

type IO struct {
	In              io.Reader
	Out             io.Writer
	PlatformChannel string
	ServiceProfile  string
	Answers         map[string]json.RawMessage
	// PendingSecrets holds values in memory until the resolved plan accepts the
	// requirements. The apply owner persists them after validating all sources.
	PendingSecrets map[string]secrets.PendingSecret
	// ReadSecret reads one line of secret input without echoing it. When nil, a
	// real terminal is read with echo disabled and any other input (a pipe, a
	// test) is read as a plain line.
	ReadSecret       func() (string, error)
	SkipRequirements []string
}

func renderPrompt(output io.Writer, format string, values ...any) error {
	_, err := fmt.Fprintf(output, format, values...)
	return err
}

// secretAttempts bounds how often a hidden, unverifiable answer is re-asked
// (bad format, mismatched confirmation) before the wizard gives up.
const secretAttempts = 3

func Request(source catalog.Catalog, platformRoot string, terminal IO) (contracts.InstallRequest, error) {
	if err := catalog.Verify(source); err != nil {
		return contracts.InstallRequest{}, err
	}
	if strings.TrimSpace(platformRoot) == "" {
		return contracts.InstallRequest{}, fmt.Errorf("platform root is required")
	}
	layout, err := versionroot.New(platformRoot)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	if err := layout.ValidateInitialTarget(); err != nil {
		return contracts.InstallRequest{}, contracts.NewDiag(contracts.CodeInstallLayoutUnsupported,
			"The chosen install root is not an empty directory or an owned installation container.",
			"Choose a fresh writable path, then run `"+contracts.ShellCommand("kb-create", "install", "--platform-root", "NEW_ROOT")+"`.", err)
	}
	if terminal.In == nil || terminal.Out == nil {
		return contracts.InstallRequest{}, fmt.Errorf("wizard input and output are required")
	}
	reader := bufio.NewReader(terminal.In)
	channels := availableChannels(source)
	channel, err := choose(reader, terminal.Out, "Platform channel", channels, string(contracts.ChannelStable))
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	version := source.Channels[contracts.Channel(channel)]
	platform, ok := findPlatform(source.Platforms, version)
	if !ok {
		return contracts.InstallRequest{}, fmt.Errorf("channel %q does not resolve to a platform bundle", channel)
	}
	profiles := make([]string, 0, len(platform.Profiles))
	for profile := range platform.Profiles {
		profiles = append(profiles, profile)
	}
	sort.Strings(profiles)
	profile, err := choose(reader, terminal.Out, "Service profile", profiles, "default")
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	plugins, err := chooseMany(reader, terminal.Out, "Plugins (comma-separated IDs; blank for none)", componentIDs(source.Plugins))
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	adapters, err := chooseMany(reader, terminal.Out, "Adapters (comma-separated IDs; blank for automatic providers)", adapterIDs(source.Adapters))
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	request := contracts.InstallRequest{Schema: contracts.RequestSchema, Platform: contracts.VersionSelector{Channel: contracts.Channel(channel)}, ServiceProfile: profile, Plugins: components(plugins), Adapters: components(adapters), Policy: contracts.PolicyCompatible, Source: contracts.SourceRegistry, PlatformRoot: platformRoot}
	return request.Normalize()
}

// RequestScenario is the human-facing compiler for a declarative V2 scenario.
// It owns prompts and navigation only; scenario.Compile and the shared V2
// resolver remain the authority for request meaning and compatibility.
func RequestScenario(source catalog.Catalog, platformRoot, scenarioID, projectRoot string, terminal IO) (contracts.InstallRequest, error) {
	if err := catalog.Verify(source); err != nil {
		return contracts.InstallRequest{}, err
	}
	if strings.TrimSpace(platformRoot) == "" {
		return contracts.InstallRequest{}, fmt.Errorf("platform root is required")
	}
	if terminal.In == nil || terminal.Out == nil {
		return contracts.InstallRequest{}, fmt.Errorf("wizard input and output are required")
	}
	reader := bufio.NewReader(terminal.In)
	interactive := true
	if file, ok := terminal.In.(*os.File); ok {
		interactive = term.IsTerminal(file.Fd())
	}
	if strings.TrimSpace(projectRoot) == "" && interactive {
		if err := renderPrompt(terminal.Out,
			"Project directory (press Enter to install without a project): "); err != nil {
			return contracts.InstallRequest{}, err
		}
		value, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return contracts.InstallRequest{}, readErr
		}
		projectRoot = strings.TrimSpace(value)
	}
	if projectRoot != "" {
		canonical, pathErr := contracts.ValidateProjectSelection(projectRoot)
		if pathErr != nil {
			return contracts.InstallRequest{}, pathErr
		}
		projectRoot = canonical
	}
	if scenarioID == "" {
		scenarioID = "explore"
		if interactive {
			ids, err := scenario.IDs()
			if err != nil {
				return contracts.InstallRequest{}, err
			}
			scenarioID, err = choose(reader, terminal.Out, "Scenario", ids, "explore")
			if err != nil {
				return contracts.InstallRequest{}, err
			}
		}
	}
	definition, err := scenario.Load(scenarioID)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	if len(terminal.SkipRequirements) > 0 {
		definition = withoutRequirements(definition, terminal.SkipRequirements)
	}
	channels := availableChannels(source)
	channel := terminal.PlatformChannel
	if channel == "" {
		if _, ok := source.Channels[contracts.ChannelStable]; ok {
			channel = string(contracts.ChannelStable)
		} else if len(channels) == 1 {
			channel = channels[0]
		}
		if interactive {
			channel, err = choose(reader, terminal.Out, "Platform channel", channels, channel)
			if err != nil {
				return contracts.InstallRequest{}, err
			}
		}
	}
	if channel == "" {
		return contracts.InstallRequest{}, fmt.Errorf("platformChannel: required answer is missing")
	}
	version := source.Channels[contracts.Channel(channel)]
	platform, ok := findPlatform(source.Platforms, version)
	if !ok {
		return contracts.InstallRequest{}, fmt.Errorf("channel %q does not resolve to a platform bundle", channel)
	}
	profiles := make([]string, 0, len(platform.Profiles))
	for profile := range platform.Profiles {
		profiles = append(profiles, profile)
	}
	sort.Strings(profiles)
	profile := terminal.ServiceProfile
	if profile == "" {
		profile = "default"
		if interactive {
			profile, err = choose(reader, terminal.Out, "Service profile", profiles, profile)
			if err != nil {
				return contracts.InstallRequest{}, err
			}
		}
	}
	base := contracts.InstallRequest{PlatformRoot: platformRoot, ProjectRoot: projectRoot, Platform: contracts.VersionSelector{Channel: contracts.Channel(channel)}, ServiceProfile: profile, Policy: contracts.PolicyCompatible, Source: contracts.SourceRegistry}
	session, err := flow.New(definition, nil, nil)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	for id, value := range terminal.Answers {
		if err := session.Apply(id, value, flow.SourceAgent); err != nil {
			return contracts.InstallRequest{}, err
		}
	}
	// Secret values typed (or generated) during the journey stay in memory until
	// the selected request is resolved by the shared installer boundary.
	pending := map[string]string{}
	generatedValues := map[string]bool{}
	store := secrets.Store{PlatformRoot: platformRoot}
	for !session.State.Done {
		requests := session.Inspect()
		for _, request := range requests {
			field := request.Field
			if _, answered := terminal.Answers[field.ID]; answered {
				if field.Secret {
					var value string
					if err := json.Unmarshal(terminal.Answers[field.ID], &value); err != nil {
						return contracts.InstallRequest{}, err
					}
					pending[field.Requirement] = value
				}
				continue
			}
			if !interactive {
				if field.Secret && field.Generate {
					if value, present, err := store.Get(field.Requirement); err != nil {
						return contracts.InstallRequest{}, fmt.Errorf("read stored secret %s: %w", field.Requirement, err)
					} else if present {
						raw, err := json.Marshal(value)
						if err != nil {
							return contracts.InstallRequest{}, err
						}
						if err := session.Apply(field.ID, raw, flow.SourceDefault); err != nil {
							return contracts.InstallRequest{}, err
						}
						continue
					}
					value, err := generateSecret()
					if err != nil {
						return contracts.InstallRequest{}, err
					}
					raw, err := json.Marshal(value)
					if err != nil {
						return contracts.InstallRequest{}, err
					}
					if err := session.Apply(field.ID, raw, flow.SourceDefault); err != nil {
						return contracts.InstallRequest{}, err
					}
					pending[field.Requirement] = value
					generatedValues[field.Requirement] = true
				}
				continue
			}
			label := field.Label
			if label == "" {
				label = field.ID
			}
			if field.Description != "" {
				fmt.Fprintf(terminal.Out, "%s: %s\n", label, field.Description)
			}
			if field.Secret {
				if value, present, readErr := store.Get(field.Requirement); readErr != nil {
					return contracts.InstallRequest{}, fmt.Errorf("read stored secret %s: %w", field.Requirement, readErr)
				} else if present {
					raw, marshalErr := json.Marshal(value)
					if marshalErr != nil {
						return contracts.InstallRequest{}, marshalErr
					}
					if err := session.Apply(field.ID, raw, flow.SourceDefault); err != nil {
						return contracts.InstallRequest{}, err
					}
					continue
				}
				value, skipped, generated, secretErr := askSecret(reader, terminal, &session, field, label)
				if secretErr != nil {
					return contracts.InstallRequest{}, secretErr
				}
				if !skipped {
					pending[field.Requirement] = value
					if generated {
						generatedValues[field.Requirement] = true
					}
				}
				continue
			}
			if field.ProviderFor != "" {
				if len(field.Default) == 0 {
					return contracts.InstallRequest{}, fmt.Errorf("scenario provider %q has no declared default", field.ProviderFor)
				}
				if err := session.Apply(field.ID, field.Default, flow.SourceDefault); err != nil {
					return contracts.InstallRequest{}, err
				}
				continue
			}
			var raw string
			if len(field.Options) > 0 {
				options := make([]string, 0, len(field.Options))
				for _, option := range field.Options {
					options = append(options, option.Value)
				}
				value, chooseErr := choose(reader, terminal.Out, label, options, defaultString(field.Default))
				if chooseErr != nil {
					return contracts.InstallRequest{}, chooseErr
				}
				raw = fmt.Sprintf("%q", value)
			} else {
				if err := renderPrompt(terminal.Out, "%s: ", label); err != nil {
					return contracts.InstallRequest{}, err
				}
				value, readErr := reader.ReadString('\n')
				if readErr != nil && readErr != io.EOF {
					return contracts.InstallRequest{}, readErr
				}
				raw = fmt.Sprintf("%q", strings.TrimSpace(value))
			}
			if err := session.Apply(field.ID, []byte(raw), flow.SourceHuman); err != nil {
				return contracts.InstallRequest{}, err
			}
		}
		if err := session.Next(); err != nil {
			return contracts.InstallRequest{}, err
		}
	}
	request, err := scenario.Compile(definition, session.State, base)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	for _, id := range request.SecretInputs {
		value, ok := pending[id]
		if !ok {
			continue // named by the request but not entered here (supplied another way)
		}
		origin := secrets.BootstrapPasswordOrigin("")
		if id == secrets.BootstrapPassword {
			origin = secrets.BootstrapOriginSupplied
			if generatedValues[id] {
				origin = secrets.BootstrapOriginGenerated
			}
		}
		if terminal.PendingSecrets == nil {
			return contracts.InstallRequest{}, fmt.Errorf("pending secret destination is required")
		}
		terminal.PendingSecrets[id] = secrets.PendingSecret{Value: value, Origin: origin}
	}
	return request, nil
}

func withoutRequirements(definition scenario.Scenario, requirements []string) scenario.Scenario {
	skipped := make(map[string]struct{}, len(requirements))
	for _, requirement := range requirements {
		skipped[requirement] = struct{}{}
	}
	filter := func(fields []scenario.Field) []scenario.Field {
		result := fields[:0]
		for _, field := range fields {
			if _, skip := skipped[field.Requirement]; !skip {
				result = append(result, field)
			}
		}
		return result
	}
	definition.Fields = filter(definition.Fields)
	for pageIndex := range definition.Pages {
		for sectionIndex := range definition.Pages[pageIndex].Sections {
			section := &definition.Pages[pageIndex].Sections[sectionIndex]
			section.Fields = filter(section.Fields)
		}
	}
	return definition
}

// askSecret collects one secret field. Input is hidden on a terminal. A blank
// answer generates a value for fields that allow it, is an error for required
// fields, and otherwise skips the field (nothing is recorded for it). A value a
// human chose (not generated) is asked twice, since hidden input cannot be
// proofread. Format errors and mismatches re-ask instead of aborting the journey.
func askSecret(reader *bufio.Reader, terminal IO, session *flow.Session, field scenario.Field, label string) (string, bool, bool, error) {
	for attempt := 1; ; attempt++ {
		if err := renderPrompt(terminal.Out, "%s: ", label); err != nil {
			return "", false, false, err
		}
		value, err := readSecret(reader, terminal)
		if err != nil {
			return "", false, false, err
		}
		problem := ""
		generated := false
		switch {
		case value == "" && field.Generate:
			secretValue, genErr := generateSecret()
			if genErr != nil {
				return "", false, false, genErr
			}
			value = secretValue
			generated = true
			fmt.Fprintf(terminal.Out, "%s: generated a random value (not shown)\n", label)
		case value == "" && field.Required:
			problem = "a value is required"
		case value == "":
			fmt.Fprintf(terminal.Out, "%s: skipped\n", label)
			return "", true, false, nil
		default:
			if err := renderPrompt(terminal.Out, "Confirm %s: ", strings.ToLower(label)); err != nil {
				return "", false, false, err
			}
			again, confirmErr := readSecret(reader, terminal)
			if confirmErr != nil {
				return "", false, false, confirmErr
			}
			if again != value {
				problem = "the two entries do not match"
			}
		}
		if problem == "" {
			raw, marshalErr := json.Marshal(value)
			if marshalErr != nil {
				return "", false, false, marshalErr
			}
			if applyErr := session.Apply(field.ID, raw, flow.SourceHuman); applyErr != nil {
				// The message names the field and the rule, never the value.
				problem = strings.TrimPrefix(applyErr.Error(), fmt.Sprintf("field %q: ", field.ID))
			} else {
				return value, false, generated, nil
			}
		}
		if attempt >= secretAttempts {
			return "", false, false, fmt.Errorf("%s: %s", label, problem)
		}
		fmt.Fprintf(terminal.Out, "%s: %s; try again\n", label, problem)
	}
}

// readSecret reads one secret line: hidden on a real terminal, plain otherwise.
func readSecret(reader *bufio.Reader, terminal IO) (string, error) {
	if terminal.ReadSecret != nil {
		return terminal.ReadSecret()
	}
	if file, ok := terminal.In.(*os.File); ok && term.IsTerminal(file.Fd()) {
		value, err := term.ReadPassword(file.Fd())
		fmt.Fprintln(terminal.Out) // the newline the user typed was not echoed
		return string(value), err
	}
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// generateSecret returns 256 bits of cryptographic randomness, hex-encoded.
func generateSecret() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate secret: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

func defaultString(raw []byte) string {
	var value string
	if len(raw) > 0 && json.Unmarshal(raw, &value) == nil {
		return value
	}
	return ""
}

func choose(reader *bufio.Reader, output io.Writer, label string, options []string, fallback string) (string, error) {
	if err := renderPrompt(output, "%s [%s] (default %s): ", label, strings.Join(options, ", "), fallback); err != nil {
		return "", err
	}
	value, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	if err == io.EOF {
		value = ""
	}
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	for _, option := range options {
		if value == option {
			return value, nil
		}
	}
	return "", fmt.Errorf("%s %q is not available", strings.ToLower(label), value)
}

func chooseMany(reader *bufio.Reader, output io.Writer, label string, options []string) ([]string, error) {
	if err := renderPrompt(output, "%s [%s]: ", label, strings.Join(options, ", ")); err != nil {
		return nil, err
	}
	value, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return nil, err
	}
	if err == io.EOF {
		value = ""
	}
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	available := map[string]bool{}
	for _, option := range options {
		available[option] = true
	}
	seen, result := map[string]bool{}, []string{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if !available[item] {
			return nil, fmt.Errorf("component %q is not available", item)
		}
		if !seen[item] {
			seen[item] = true
			result = append(result, item)
		}
	}
	sort.Strings(result)
	return result, nil
}

func availableChannels(source catalog.Catalog) []string {
	result := make([]string, 0, len(source.Channels))
	for channel := range source.Channels {
		result = append(result, string(channel))
	}
	sort.Strings(result)
	return result
}
func componentIDs(values []catalog.Component) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, value.ID)
	}
	sort.Strings(result)
	return result
}
func adapterIDs(values []catalog.Adapter) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, value.ID)
	}
	sort.Strings(result)
	return result
}
func components(ids []string) []contracts.ComponentRequest {
	result := make([]contracts.ComponentRequest, 0, len(ids))
	for _, id := range ids {
		result = append(result, contracts.ComponentRequest{ID: id})
	}
	return result
}
func findPlatform(values []catalog.PlatformBundle, version string) (catalog.PlatformBundle, bool) {
	for _, value := range values {
		if value.Version == version {
			return value, true
		}
	}
	return catalog.PlatformBundle{}, false
}
