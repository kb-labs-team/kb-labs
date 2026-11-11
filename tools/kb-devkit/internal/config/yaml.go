package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// yamlOrderedCategories parses the categories map preserving YAML key order.
// yaml.v3 represents maps as sequences of key-value pairs in *yaml.Node,
// so we can walk Content[0] (MappingNode) to extract keys in document order.
type yamlOrderedCategories []NamedCategory

func (o *yamlOrderedCategories) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind != yaml.MappingNode {
		return fmt.Errorf("categories must be a mapping")
	}
	// MappingNode.Content = [key, value, key, value, ...]
	for i := 0; i+1 < len(value.Content); i += 2 {
		keyNode := value.Content[i]
		valNode := value.Content[i+1]
		var cat yamlCategory
		if err := valNode.Decode(&cat); err != nil {
			return fmt.Errorf("category %q: %w", keyNode.Value, err)
		}
		*o = append(*o, NamedCategory{
			Name: keyNode.Value,
			Category: CategoryConfig{
				Match:       cat.Match,
				Language:    cat.Language,
				Preset:      cat.Preset,
				ReleaseLane: cat.ReleaseLane,
			},
		})
	}
	return nil
}

func loadYAML(path string) (*DevkitConfig, error) {
	visited := make(map[string]bool)
	cfg, err := loadYAMLResolved(path, visited)
	if err != nil {
		return nil, err
	}
	if cfg.Checks.TimeoutMS == 0 {
		cfg.Checks.TimeoutMS = DefaultCheckTimeoutMS
	}
	return cfg, nil
}

// yamlConfig mirrors DevkitConfig for YAML tag parsing.
// Keeping it separate from the domain struct avoids leaking yaml tags.
type yamlConfig struct {
	SchemaVersion int                   `yaml:"schemaVersion"`
	Version       int                   `yaml:"version"`
	Extends       []string              `yaml:"extends"`
	Workspace     yamlWorkspace         `yaml:"workspace"`
	Categories    yamlOrderedCategories `yaml:"categories"`
	Sync          yamlSync              `yaml:"sync"`
	Scaffolding   yamlScaffolding       `yaml:"scaffolding"`
	Run           yamlRun               `yaml:"run"`
	Tasks         map[string]yamlTask   `yaml:"tasks"`
	Affected      yamlAffected          `yaml:"affected"`
	Presets       map[string]yamlPreset `yaml:"presets"`
	Checks        yamlChecks            `yaml:"checks"`
	Fix           yamlFix               `yaml:"fix"`
	Reporting     yamlReporting         `yaml:"reporting"`
	Custom        []yamlCustomCheck     `yaml:"custom_checks"`
}

// yamlTaskVariant is one variant of a task (single object in YAML).
type yamlTaskVariant struct {
	Categories []string `yaml:"categories"`
	Command    string   `yaml:"command"`
	Inputs     []string `yaml:"inputs"`
	Outputs    []string `yaml:"outputs"`
	Deps       []string `yaml:"deps"`
	Cache      *bool    `yaml:"cache"`
}

// yamlTask accepts both a single object and a list of variants:
//
//	tasks:
//	  build:                         # single variant (no categories)
//	    command: tsup
//	    inputs: [...]
//
//	  build:                         # multiple variants
//	    - categories: [ts-lib]
//	      command: tsup
//	    - categories: [go-binary]
//	      command: make build
type yamlTask []yamlTaskVariant

func (t *yamlTask) UnmarshalYAML(unmarshal func(interface{}) error) error {
	// Try list first.
	var list []yamlTaskVariant
	if err := unmarshal(&list); err == nil {
		*t = list
		return nil
	}
	// Fall back to single object (no categories = catch-all).
	var single yamlTaskVariant
	if err := unmarshal(&single); err != nil {
		return err
	}
	*t = []yamlTaskVariant{single}
	return nil
}

type yamlAffected struct {
	Strategy   string   `yaml:"strategy"`
	Command    string   `yaml:"command"`
	FullInputs []string `yaml:"fullInputs"`
}

type yamlWorkspace struct {
	PackageManager string                `yaml:"packageManager"`
	Discovery      []string              `yaml:"discovery"`
	Categories     yamlOrderedCategories `yaml:"categories"`
	MaxDepth       int                   `yaml:"maxDepth"`
	Include        []string              `yaml:"include"`
	Exclude        []string              `yaml:"exclude"`
}

type yamlCategory struct {
	Match       []string `yaml:"match"`
	Language    string   `yaml:"language"`
	Preset      string   `yaml:"preset"`
	ReleaseLane string   `yaml:"releaseLane"`
}

type yamlPreset struct {
	Extends     string          `yaml:"extends"`
	Language    string          `yaml:"language"`
	PackageJSON yamlPackageJSON `yaml:"package_json"`
	TSConfig    yamlTSConfig    `yaml:"tsconfig"`
	TSup        yamlTSup        `yaml:"tsup"`
	ESLint      yamlESLint      `yaml:"eslint"`
	Structure   yamlStructure   `yaml:"structure"`
	Deps        yamlDeps        `yaml:"dependencies"`
	Go          yamlGo          `yaml:"go"`
}

type yamlPackageJSON struct {
	RequiredScripts []string          `yaml:"required_scripts"`
	RequiredDevDeps map[string]string `yaml:"required_dev_deps"`
	RequiredFields  []string          `yaml:"required_fields"`
	Type            string            `yaml:"type"`
	Engines         map[string]string `yaml:"engines"`
}

type yamlTSConfig struct {
	MustExtendPattern string `yaml:"must_extend_pattern"`
	ForbidPaths       bool   `yaml:"forbid_paths"`
}

type yamlTSup struct {
	MustUsePreset       bool   `yaml:"must_use_preset"`
	DTSRequired         bool   `yaml:"dts_required"`
	TSConfigMustBeBuild bool   `yaml:"tsconfig_must_be_build"`
	PresetPattern       string `yaml:"preset_pattern"`
	MustImportPattern   string `yaml:"must_import_pattern"`
}

type yamlESLint struct {
	MustUsePreset     bool   `yaml:"must_use_preset"`
	MustImportPattern string `yaml:"must_import_pattern"`
}

type yamlStructure struct {
	RequiredFiles []string `yaml:"required_files"`
}

type yamlDeps struct {
	CheckLinks              bool     `yaml:"check_links"`
	CheckUnused             bool     `yaml:"check_unused"`
	CheckCircular           bool     `yaml:"check_circular"`
	CheckVersionConsistency bool     `yaml:"check_version_consistency"`
	AllowedKbDeps           []string `yaml:"allowed_kb_deps"`
	ForbiddenKbDeps         []string `yaml:"forbidden_kb_deps"`
	AllowedKbImports        []string `yaml:"allowed_kb_imports"`
	ForbiddenKbImports      []string `yaml:"forbidden_kb_imports"`
}

type yamlGo struct {
	MinVersion string `yaml:"min_version"`
}

type yamlScaffolding struct {
	Templates map[string]yamlScaffoldTemplate `yaml:"templates"`
}

type yamlScaffoldTemplate struct {
	Source  string `yaml:"source"`
	Path    string `yaml:"path"`
	Package string `yaml:"package"`
	URL     string `yaml:"url"`
	Ref     string `yaml:"ref"`
}

type yamlSync struct {
	Sources map[string]yamlSyncSource `yaml:"sources"`
	Targets []yamlSyncTarget          `yaml:"targets"`
	Exclude []string                  `yaml:"exclude"`
}

type yamlSyncSource struct {
	Type    string `yaml:"type"`
	Package string `yaml:"package"`
	Path    string `yaml:"path"`
	URL     string `yaml:"url"`
	Ref     string `yaml:"ref"`
}

type yamlSyncTarget struct {
	Source string `yaml:"source"`
	From   string `yaml:"from"`
	To     string `yaml:"to"`
	Mode   string `yaml:"mode"`
	Signal string `yaml:"signal"`
}

type yamlRun struct {
	Concurrency  int `yaml:"concurrency"`
	TaskMemoryMB int `yaml:"task_memory_mb"`
}

type yamlCustomCheck struct {
	Name           string   `yaml:"name"`
	Run            string   `yaml:"run"`
	Fix            string   `yaml:"fix"`
	On             []string `yaml:"on"`
	Language       string   `yaml:"language"`
	Categories     []string `yaml:"categories"`
	AnchorPackages []string `yaml:"anchor_packages"`
	RequiresBuild  []string `yaml:"requires_build"`
	Scope          string   `yaml:"scope"`
}

type yamlChecks struct {
	TimeoutMS *int                     `yaml:"timeout_ms"`
	Packages  map[string]yamlCheckPack `yaml:"packages"`
}

type yamlCheckPack struct {
	Enabled bool           `yaml:"enabled"`
	Config  map[string]any `yaml:"config"`
}

type yamlFix struct {
	DefaultMode string `yaml:"defaultMode"`
}

type yamlReporting struct {
	Verbose bool `yaml:"verbose"`
}

func loadYAMLResolved(path string, visited map[string]bool) (*DevkitConfig, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", path, err)
	}
	key := "file:" + abs
	if visited[key] {
		return nil, fmt.Errorf("config extends cycle detected at %q", path)
	}
	visited[key] = true

	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	cfg, err := parseYAMLBytes(data)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	baseDir := filepath.Dir(abs)
	if len(cfg.Extends) == 0 {
		return cfg, nil
	}

	merged := &DevkitConfig{}
	for _, ref := range cfg.Extends {
		extCfg, err := loadExtendedConfig(baseDir, ref, visited)
		if err != nil {
			return nil, err
		}
		merged = mergeConfigs(merged, extCfg)
	}
	cfg.Extends = nil
	merged = mergeConfigs(merged, cfg)
	return merged, nil
}

func loadExtendedConfig(baseDir, ref string, visited map[string]bool) (*DevkitConfig, error) {
	switch {
	case strings.HasPrefix(ref, "builtin:"):
		name := strings.TrimPrefix(ref, "builtin:")
		key := "builtin:" + name
		if visited[key] {
			return nil, fmt.Errorf("config extends cycle detected at %q", ref)
		}
		visited[key] = true
		cfg, err := loadBuiltInPack(name)
		if err != nil {
			return nil, err
		}
		if len(cfg.Extends) == 0 {
			return cfg, nil
		}
		merged := &DevkitConfig{}
		for _, nested := range cfg.Extends {
			nestedCfg, err := loadExtendedConfig(baseDir, nested, visited)
			if err != nil {
				return nil, err
			}
			merged = mergeConfigs(merged, nestedCfg)
		}
		cfg.Extends = nil
		return mergeConfigs(merged, cfg), nil
	case strings.HasPrefix(ref, "package:"):
		return loadPackagePack(baseDir, ref)
	default:
		target := ref
		if !filepath.IsAbs(target) {
			target = filepath.Join(baseDir, ref)
		}
		return loadYAMLResolved(target, visited)
	}
}

func parseYAMLBytes(data []byte) (*DevkitConfig, error) {
	var raw yamlConfig
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	cfg := mapYAML(raw)
	if raw.Checks.TimeoutMS != nil && *raw.Checks.TimeoutMS <= 0 {
		return nil, fmt.Errorf("checks.timeout_ms must be a positive integer, got %d", *raw.Checks.TimeoutMS)
	}
	for _, check := range cfg.Custom {
		if check.Scope != "" && check.Scope != "package" && check.Scope != "workspace" {
			return nil, fmt.Errorf("custom check %q has unsupported scope %q (expected package or workspace)", check.Name, check.Scope)
		}
		if check.Scope == "workspace" && (check.Language != "" || len(check.Categories) > 0) {
			return nil, fmt.Errorf("custom check %q uses workspace scope and cannot set package language or categories", check.Name)
		}
	}
	for _, category := range cfg.Workspace.Categories {
		if category.Category.ReleaseLane != "" {
			if category.Category.ReleaseLane != "internal-tool" {
				return nil, fmt.Errorf("workspace category %q has unsupported releaseLane %q", category.Name, category.Category.ReleaseLane)
			}
		}
	}
	return cfg, nil
}

func mapYAML(raw yamlConfig) *DevkitConfig {
	cfg := &DevkitConfig{
		SchemaVersion: raw.SchemaVersion,
		Version:       raw.Version,
		Extends:       raw.Extends,
		Workspace: WorkspaceConfig{
			PackageManager: raw.Workspace.PackageManager,
			Discovery:      raw.Workspace.Discovery,
			MaxDepth:       raw.Workspace.MaxDepth,
			Include:        raw.Workspace.Include,
			Exclude:        raw.Workspace.Exclude,
		},
		Run: RunConfig{
			Concurrency:  raw.Run.Concurrency,
			TaskMemoryMB: raw.Run.TaskMemoryMB,
		},
		Affected: AffectedConfig{
			Strategy:   raw.Affected.Strategy,
			Command:    raw.Affected.Command,
			FullInputs: raw.Affected.FullInputs,
		},
		Fix: FixConfig{
			DefaultMode: raw.Fix.DefaultMode,
		},
		Reporting: ReportingConfig{
			Verbose: raw.Reporting.Verbose,
		},
	}

	// Categories — already fully decoded by yamlOrderedCategories.UnmarshalYAML
	cfg.Workspace.Categories = raw.Workspace.Categories
	if len(cfg.Workspace.Categories) == 0 {
		cfg.Workspace.Categories = raw.Categories
	}
	cfg.Categories = cfg.Workspace.Categories

	// Presets
	if raw.Presets != nil {
		cfg.Presets = make(map[string]Preset, len(raw.Presets))
		for k, v := range raw.Presets {
			cfg.Presets[k] = mapPreset(v)
		}
	}

	// Sync
	cfg.Sync.Exclude = raw.Sync.Exclude
	if raw.Sync.Sources != nil {
		cfg.Sync.Sources = make(map[string]SyncSource, len(raw.Sync.Sources))
		for k, v := range raw.Sync.Sources {
			cfg.Sync.Sources[k] = SyncSource{
				Type:    v.Type,
				Package: v.Package,
				Path:    v.Path,
				URL:     v.URL,
				Ref:     v.Ref,
			}
		}
	}
	for _, t := range raw.Sync.Targets {
		cfg.Sync.Targets = append(cfg.Sync.Targets, SyncTarget{
			Source: t.Source,
			From:   t.From,
			To:     t.To,
			Mode:   t.Mode,
			Signal: t.Signal,
		})
	}

	// Scaffolding
	if raw.Scaffolding.Templates != nil {
		cfg.Scaffolding.Templates = make(map[string]ScaffoldTemplate, len(raw.Scaffolding.Templates))
		for k, v := range raw.Scaffolding.Templates {
			cfg.Scaffolding.Templates[k] = ScaffoldTemplate{
				Source:  v.Source,
				Path:    v.Path,
				Package: v.Package,
				URL:     v.URL,
				Ref:     v.Ref,
			}
		}
	}

	// Tasks
	if raw.Tasks != nil {
		cfg.Tasks = make(map[string]TaskConfig, len(raw.Tasks))
		for k, variants := range raw.Tasks {
			tc := make(TaskConfig, len(variants))
			for i, v := range variants {
				tc[i] = TaskVariant{
					Categories: v.Categories,
					Command:    v.Command,
					Inputs:     v.Inputs,
					Outputs:    v.Outputs,
					Deps:       v.Deps,
					Cache:      v.Cache,
				}
			}
			cfg.Tasks[k] = tc
		}
	}

	// Custom checks
	for _, c := range raw.Custom {
		cfg.Custom = append(cfg.Custom, CustomCheck{
			Name:           c.Name,
			Run:            c.Run,
			Fix:            c.Fix,
			On:             c.On,
			Language:       c.Language,
			Categories:     c.Categories,
			AnchorPackages: c.AnchorPackages,
			RequiresBuild:  c.RequiresBuild,
			Scope:          c.Scope,
		})
	}

	if raw.Checks.Packages != nil {
		cfg.Checks.Packages = make(map[string]CheckPackConfig, len(raw.Checks.Packages))
		for k, v := range raw.Checks.Packages {
			cfg.Checks.Packages[k] = CheckPackConfig{Enabled: v.Enabled, Config: v.Config}
		}
	}
	if raw.Checks.TimeoutMS != nil {
		cfg.Checks.TimeoutMS = *raw.Checks.TimeoutMS
	}

	return cfg
}

func mapPreset(v yamlPreset) Preset {
	p := Preset{
		Extends:  v.Extends,
		Language: v.Language,
		PackageJSON: PackageJSONRules{
			RequiredScripts: v.PackageJSON.RequiredScripts,
			RequiredDevDeps: v.PackageJSON.RequiredDevDeps,
			RequiredFields:  v.PackageJSON.RequiredFields,
			Type:            v.PackageJSON.Type,
			Engines:         v.PackageJSON.Engines,
		},
		TSConfig: TSConfigRules{
			MustExtendPattern: v.TSConfig.MustExtendPattern,
			ForbidPaths:       v.TSConfig.ForbidPaths,
		},
		TSup: TSupRules{
			MustUsePreset:       v.TSup.MustUsePreset,
			DTSRequired:         v.TSup.DTSRequired,
			TSConfigMustBeBuild: v.TSup.TSConfigMustBeBuild,
			PresetPattern:       v.TSup.PresetPattern,
			MustImportPattern:   v.TSup.MustImportPattern,
		},
		ESLint: ESLintRules{
			MustUsePreset:     v.ESLint.MustUsePreset,
			MustImportPattern: v.ESLint.MustImportPattern,
		},
		Structure: StructureRules{
			RequiredFiles: v.Structure.RequiredFiles,
		},
		Deps: DepsRules{
			CheckLinks:              v.Deps.CheckLinks,
			CheckUnused:             v.Deps.CheckUnused,
			CheckCircular:           v.Deps.CheckCircular,
			CheckVersionConsistency: v.Deps.CheckVersionConsistency,
			AllowedKbDeps:           v.Deps.AllowedKbDeps,
			ForbiddenKbDeps:         v.Deps.ForbiddenKbDeps,
			AllowedKbImports:        v.Deps.AllowedKbImports,
			ForbiddenKbImports:      v.Deps.ForbiddenKbImports,
		},
		Go: GoRules{
			MinVersion: v.Go.MinVersion,
		},
	}
	return p
}
