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
)

type IO struct {
	In  io.Reader
	Out io.Writer
	// ReadSecret reads one line of secret input without echoing it. When nil, a
	// real terminal is read with echo disabled and any other input (a pipe, a
	// test) is read as a plain line.
	ReadSecret func() (string, error)
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
func RequestScenario(source catalog.Catalog, platformRoot, scenarioID string, terminal IO) (contracts.InstallRequest, error) {
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
	if scenarioID == "" {
		ids, err := scenario.IDs()
		if err != nil {
			return contracts.InstallRequest{}, err
		}
		scenarioID, err = choose(reader, terminal.Out, "Scenario", ids, "explore")
		if err != nil {
			return contracts.InstallRequest{}, err
		}
	}
	definition, err := scenario.Load(scenarioID)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
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
	base := contracts.InstallRequest{PlatformRoot: platformRoot, Platform: contracts.VersionSelector{Channel: contracts.Channel(channel)}, ServiceProfile: profile, Policy: contracts.PolicyCompatible, Source: contracts.SourceRegistry}
	session, err := flow.New(definition, nil, nil)
	if err != nil {
		return contracts.InstallRequest{}, err
	}
	// Secret values typed (or generated) during the journey. They stay in memory
	// until the request compiled, then only those the request actually names are
	// written to the private secret store; they never reach the answers, the
	// request, the terminal output or the resume state.
	pending := map[string]string{}
	for !session.State.Done {
		requests := session.Inspect()
		for _, request := range requests {
			field := request.Field
			label := field.Label
			if label == "" {
				label = field.ID
			}
			if field.Description != "" {
				fmt.Fprintf(terminal.Out, "%s: %s\n", label, field.Description)
			}
			if field.Secret {
				value, skipped, secretErr := askSecret(reader, terminal, &session, field, label)
				if secretErr != nil {
					return contracts.InstallRequest{}, secretErr
				}
				if !skipped {
					pending[field.Requirement] = value
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
				fmt.Fprintf(terminal.Out, "%s: ", label)
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
	store := secrets.Store{PlatformRoot: platformRoot}
	for _, id := range request.SecretInputs {
		value, ok := pending[id]
		if !ok {
			continue // named by the request but not entered here (supplied another way)
		}
		if err := store.Put(id, value); err != nil {
			return contracts.InstallRequest{}, fmt.Errorf("store secret %s: %w", id, err)
		}
	}
	return request, nil
}

// askSecret collects one secret field. Input is hidden on a terminal. A blank
// answer generates a value for fields that allow it, is an error for required
// fields, and otherwise skips the field (nothing is recorded for it). A value a
// human chose (not generated) is asked twice, since hidden input cannot be
// proofread. Format errors and mismatches re-ask instead of aborting the journey.
func askSecret(reader *bufio.Reader, terminal IO, session *flow.Session, field scenario.Field, label string) (string, bool, error) {
	for attempt := 1; ; attempt++ {
		fmt.Fprintf(terminal.Out, "%s: ", label)
		value, err := readSecret(reader, terminal)
		if err != nil {
			return "", false, err
		}
		problem := ""
		switch {
		case value == "" && field.Generate:
			generated, genErr := generateSecret()
			if genErr != nil {
				return "", false, genErr
			}
			value = generated
			fmt.Fprintf(terminal.Out, "%s: generated a random value (stored, not shown)\n", label)
		case value == "" && field.Required:
			problem = "a value is required"
		case value == "":
			fmt.Fprintf(terminal.Out, "%s: skipped\n", label)
			return "", true, nil
		default:
			fmt.Fprintf(terminal.Out, "Confirm %s: ", strings.ToLower(label))
			again, confirmErr := readSecret(reader, terminal)
			if confirmErr != nil {
				return "", false, confirmErr
			}
			if again != value {
				problem = "the two entries do not match"
			}
		}
		if problem == "" {
			raw, marshalErr := json.Marshal(value)
			if marshalErr != nil {
				return "", false, marshalErr
			}
			if applyErr := session.Apply(field.ID, raw, flow.SourceHuman); applyErr != nil {
				// The message names the field and the rule, never the value.
				problem = strings.TrimPrefix(applyErr.Error(), fmt.Sprintf("field %q: ", field.ID))
			} else {
				return value, false, nil
			}
		}
		if attempt >= secretAttempts {
			return "", false, fmt.Errorf("%s: %s", label, problem)
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
	fmt.Fprintf(output, "%s [%s] (default %s): ", label, strings.Join(options, ", "), fallback)
	value, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
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
	fmt.Fprintf(output, "%s [%s]: ", label, strings.Join(options, ", "))
	value, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return nil, err
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
