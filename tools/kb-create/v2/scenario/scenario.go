// Package scenario turns declarative user journeys into the same
// InstallRequest used by CI and agents. A scenario can select product axes and
// manifest requirement IDs, but can never contain executable install actions.
package scenario

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/kb-labs/create/v2/contracts"
)

const Schema = "kb.create.scenario/v2"

//go:embed scenarios/*.json
var builtins embed.FS

type Scenario struct {
	Schema   string   `json:"schema"`
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Plugins  []string `json:"plugins,omitempty"`
	Adapters []string `json:"adapters,omitempty"`
	Profiles []string `json:"profiles,omitempty"`
	Fields   []Field  `json:"fields,omitempty"`
	Pages    []Page   `json:"pages,omitempty"`
}

// Page and Section are declarative presentation groups. They contain no
// executable installer behavior; the launcher remains the sole owner of
// resolution and application.
type Page struct {
	ID       string     `json:"id"`
	Title    string     `json:"title,omitempty"`
	Sections []Section  `json:"sections,omitempty"`
	When     *Predicate `json:"when,omitempty"`
}

type Section struct {
	ID          string  `json:"id"`
	Title       string  `json:"title,omitempty"`
	Description string  `json:"description,omitempty"`
	Fields      []Field `json:"fields"`
}

type Field struct {
	ID          string          `json:"id"`
	Requirement string          `json:"requirement,omitempty"`
	ProviderFor string          `json:"providerFor,omitempty"`
	Type        string          `json:"type"`
	Label       string          `json:"label,omitempty"`
	Description string          `json:"description,omitempty"`
	Required    bool            `json:"required,omitempty"`
	Secret      bool            `json:"secret,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	Options     []Option        `json:"options,omitempty"`
	When        *Predicate      `json:"when,omitempty"`
	Validators  []Validator     `json:"validators,omitempty"`
}
type Option struct {
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

type Validator struct {
	Kind string `json:"kind"`
	Arg  string `json:"arg,omitempty"`
}

type Predicate struct {
	Path   string      `json:"path,omitempty"`
	Equals interface{} `json:"equals,omitempty"`
	Exists *bool       `json:"exists,omitempty"`
	AllOf  []Predicate `json:"allOf,omitempty"`
	AnyOf  []Predicate `json:"anyOf,omitempty"`
	Not    *Predicate  `json:"not,omitempty"`
}

type State struct {
	ScenarioID string                     `json:"scenarioId"`
	Answers    map[string]json.RawMessage `json:"answers"`
	PageIndex  int                        `json:"pageIndex,omitempty"`
	Done       bool                       `json:"done,omitempty"`
}

func Load(id string) (Scenario, error) {
	data, err := builtins.ReadFile("scenarios/" + id + ".json")
	if err != nil {
		return Scenario{}, fmt.Errorf("read V2 scenario %q: %w", id, err)
	}
	return Decode(data)
}
func IDs() ([]string, error) {
	entries, err := builtins.ReadDir("scenarios")
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		result = append(result, strings.TrimSuffix(entry.Name(), ".json"))
	}
	sort.Strings(result)
	return result, nil
}
func Decode(data []byte) (Scenario, error) {
	var result Scenario
	if err := json.Unmarshal(data, &result); err != nil {
		return Scenario{}, fmt.Errorf("decode V2 scenario: %w", err)
	}
	if err := Validate(result); err != nil {
		return Scenario{}, err
	}
	return result, nil
}
func Validate(value Scenario) error {
	if value.Schema != Schema || value.ID == "" {
		return fmt.Errorf("scenario requires schema %q and ID", Schema)
	}
	seen := map[string]bool{}
	for _, field := range allFields(value) {
		if field.ID == "" || seen[field.ID] {
			return fmt.Errorf("scenario has missing or duplicate field ID")
		}
		seen[field.ID] = true
		if field.Requirement == "" && field.ProviderFor == "" {
			return fmt.Errorf("scenario field %q needs requirement or providerFor", field.ID)
		}
		if field.Requirement != "" && field.ProviderFor != "" {
			return fmt.Errorf("scenario field %q cannot bind both requirement and provider", field.ID)
		}
		if field.Secret && len(field.Default) > 0 {
			return fmt.Errorf("scenario secret field %q cannot have default", field.ID)
		}
		for _, validator := range field.Validators {
			switch validator.Kind {
			case "nonEmpty":
			case "pattern":
				if _, err := regexp.Compile(validator.Arg); err != nil {
					return fmt.Errorf("scenario field %q has an invalid pattern: %w", field.ID, err)
				}
			default:
				return fmt.Errorf("scenario field %q uses unknown validator %q", field.ID, validator.Kind)
			}
		}
	}
	pageIDs := map[string]bool{}
	for _, page := range value.Pages {
		if page.ID == "" || pageIDs[page.ID] {
			return fmt.Errorf("scenario has duplicate or empty page ID")
		}
		pageIDs[page.ID] = true
		for _, section := range page.Sections {
			if section.ID == "" {
				return fmt.Errorf("page %q has empty section ID", page.ID)
			}
		}
	}
	return nil
}
func New(value Scenario) (State, error) {
	if err := Validate(value); err != nil {
		return State{}, err
	}
	state := State{ScenarioID: value.ID, Answers: map[string]json.RawMessage{}}
	for _, field := range allFields(value) {
		if len(field.Default) > 0 {
			state.Answers[field.ID] = append(json.RawMessage(nil), field.Default...)
		}
	}
	return state, nil
}

// LoadState resumes a prior non-secret scenario state. Missing state starts a
// new journey with defaults; an unrelated/corrupt state is never accepted.
func LoadState(platformRoot string, value Scenario) (State, error) {
	data, err := os.ReadFile(statePath(platformRoot, value.ID))
	if os.IsNotExist(err) {
		return New(value)
	}
	if err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, fmt.Errorf("decode scenario state: %w", err)
	}
	if state.ScenarioID != value.ID {
		return State{}, fmt.Errorf("scenario state belongs to %q", state.ScenarioID)
	}
	return state, nil
}

// SaveState persists only non-secret answers. Secret values must live in the
// selected secret store, never in a receipt, journal, diagnostic, or resume
// file.
func SaveState(platformRoot string, value Scenario, state State) error {
	if state.ScenarioID != value.ID {
		return fmt.Errorf("state does not belong to scenario %q", value.ID)
	}
	copy := State{ScenarioID: state.ScenarioID, Answers: map[string]json.RawMessage{}}
	for _, field := range allFields(value) {
		if field.Secret {
			continue
		}
		if answer, ok := state.Answers[field.ID]; ok {
			copy.Answers[field.ID] = append(json.RawMessage(nil), answer...)
		}
	}
	data, err := json.MarshalIndent(copy, "", "  ")
	if err != nil {
		return err
	}
	path := statePath(platformRoot, value.ID)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func statePath(platformRoot, id string) string {
	return filepath.Join(platformRoot, ".kb", "v2", "scenarios", id+".json")
}
func StateDigest(value Scenario, state State) (string, error) {
	copy := State{ScenarioID: state.ScenarioID, Answers: map[string]json.RawMessage{}}
	for _, field := range allFields(value) {
		if field.Secret {
			continue
		}
		if raw, ok := state.Answers[field.ID]; ok {
			copy.Answers[field.ID] = raw
		}
	}
	data, err := json.Marshal(copy)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
func Answer(value Scenario, state State, id string, raw json.RawMessage) (State, error) {
	if state.ScenarioID != value.ID {
		return state, fmt.Errorf("state does not belong to scenario %q", value.ID)
	}
	field, ok := fieldByID(value, id)
	if !ok {
		return state, fmt.Errorf("field %q is not declared", id)
	}
	if err := validateField(field, raw); err != nil {
		return state, err
	}
	if state.Answers == nil {
		state.Answers = map[string]json.RawMessage{}
	}
	state.Answers[id] = append(json.RawMessage(nil), raw...)
	return state, nil
}

func (p Predicate) Evaluate(values map[string]json.RawMessage) bool {
	for _, child := range p.AllOf {
		if !child.Evaluate(values) {
			return false
		}
	}
	if len(p.AnyOf) > 0 {
		matched := false
		for _, child := range p.AnyOf {
			if child.Evaluate(values) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if p.Not != nil && p.Not.Evaluate(values) {
		return false
	}
	if p.Path == "" {
		return true
	}
	raw, exists := values[p.Path]
	if p.Exists != nil {
		return exists == *p.Exists
	}
	if !exists {
		return false
	}
	if p.Equals == nil {
		return true
	}
	var left any
	if json.Unmarshal(raw, &left) != nil {
		return false
	}
	return fmt.Sprint(left) == fmt.Sprint(p.Equals)
}

func allFields(value Scenario) []Field {
	if len(value.Pages) == 0 {
		return append([]Field(nil), value.Fields...)
	}
	result := make([]Field, 0)
	for _, page := range value.Pages {
		for _, section := range page.Sections {
			result = append(result, section.Fields...)
		}
	}
	return result
}

func VisiblePages(value Scenario, state State) []Page {
	if len(value.Pages) == 0 {
		return []Page{{ID: "setup", Title: value.Title, Sections: []Section{{ID: "setup", Fields: value.Fields}}}}
	}
	result := make([]Page, 0, len(value.Pages))
	for _, page := range value.Pages {
		if page.When == nil || page.When.Evaluate(state.Answers) {
			result = append(result, page)
		}
	}
	return result
}

func VisibleFields(page Page, state State) []Field {
	result := make([]Field, 0)
	for _, section := range page.Sections {
		for _, field := range section.Fields {
			if field.When == nil || field.When.Evaluate(state.Answers) {
				result = append(result, field)
			}
		}
	}
	return result
}
func Compile(value Scenario, state State, base contracts.InstallRequest) (contracts.InstallRequest, error) {
	if state.ScenarioID != value.ID {
		return contracts.InstallRequest{}, fmt.Errorf("state does not belong to scenario %q", value.ID)
	}
	if err := Validate(value); err != nil {
		return contracts.InstallRequest{}, err
	}
	if len(value.Profiles) > 0 {
		found := false
		for _, profile := range value.Profiles {
			if base.ServiceProfile == profile {
				found = true
			}
		}
		if !found {
			return contracts.InstallRequest{}, fmt.Errorf("service profile %q is not allowed by scenario", base.ServiceProfile)
		}
	}
	base.Schema = contracts.RequestSchema
	base.ScenarioID = value.ID
	base.Plugins = append(base.Plugins, components(value.Plugins)...)
	base.Adapters = append(base.Adapters, components(value.Adapters)...)
	if base.Values == nil {
		base.Values = map[string]string{}
	}
	if base.ProviderPreferences == nil {
		base.ProviderPreferences = map[string]string{}
	}
	for _, field := range allFields(value) {
		// A field the journey does not show (its `when` is false) is neither
		// required nor emitted, whatever an earlier answer left in the state.
		if field.When != nil && !field.When.Evaluate(state.Answers) {
			continue
		}
		raw, exists := state.Answers[field.ID]
		if !exists {
			raw = field.Default
		}
		if field.Required && len(raw) == 0 {
			return contracts.InstallRequest{}, fmt.Errorf("required scenario field %q is missing", field.ID)
		}
		if len(raw) == 0 {
			continue
		}
		if err := validateField(field, raw); err != nil {
			return contracts.InstallRequest{}, err
		}
		var text string
		if field.Secret {
			base.SecretInputs = append(base.SecretInputs, field.Requirement)
			continue
		}
		if err := json.Unmarshal(raw, &text); err != nil {
			return contracts.InstallRequest{}, fmt.Errorf("scenario field %q must be a JSON string", field.ID)
		}
		if isBlankOptionalString(field, text) {
			// A blank optional answer means "not provided". Emitting it would
			// write an empty string over the component's own default and can
			// make a strict consumer (e.g. an email-typed setting) reject the
			// generated configuration.
			continue
		}
		if field.ProviderFor != "" {
			base.ProviderPreferences[field.ProviderFor] = text
		} else {
			base.Values[field.Requirement] = string(raw)
		}
	}
	return base.Normalize()
}
func fieldByID(value Scenario, id string) (Field, bool) {
	for _, field := range allFields(value) {
		if field.ID == id {
			return field, true
		}
	}
	return Field{}, false
}
func validateField(field Field, raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return fmt.Errorf("field %q has invalid JSON: %w", field.ID, err)
	}
	if field.Type == "string" || field.Type == "select" || field.Secret {
		if _, ok := decoded.(string); !ok {
			return fmt.Errorf("field %q must be a string", field.ID)
		}
	}
	if len(field.Options) > 0 {
		value, ok := decoded.(string)
		if !ok {
			return fmt.Errorf("field %q option value must be a string", field.ID)
		}
		for _, option := range field.Options {
			if value == option.Value {
				return nil
			}
		}
		return fmt.Errorf("field %q option %q is not declared", field.ID, value)
	}
	if isBlankOptionalString(field, decoded) {
		return nil
	}
	for _, validator := range field.Validators {
		switch validator.Kind {
		case "nonEmpty":
			if value, ok := decoded.(string); !ok || strings.TrimSpace(value) == "" {
				return fmt.Errorf("field %q must not be empty", field.ID)
			}
		case "pattern":
			expression, err := regexp.Compile(validator.Arg)
			if err != nil {
				return fmt.Errorf("field %q has an invalid pattern: %w", field.ID, err)
			}
			if value, ok := decoded.(string); !ok || !expression.MatchString(value) {
				return fmt.Errorf("field %q does not match the required format", field.ID)
			}
		default:
			return fmt.Errorf("field %q uses unknown validator %q", field.ID, validator.Kind)
		}
	}
	return nil
}

// isBlankOptionalString reports an optional, free-text, non-secret field whose
// answer is empty: the user chose not to provide it.
func isBlankOptionalString(field Field, value any) bool {
	text, ok := value.(string)
	return ok && text == "" && field.Type == "string" && !field.Required && !field.Secret && len(field.Options) == 0
}
func components(ids []string) []contracts.ComponentRequest {
	result := make([]contracts.ComponentRequest, 0, len(ids))
	for _, id := range ids {
		result = append(result, contracts.ComponentRequest{ID: id})
	}
	return result
}
