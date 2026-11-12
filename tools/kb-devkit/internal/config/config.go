// Package config loads and resolves devkit.yaml configuration.
package config

// DevkitConfig is the top-level structure for devkit.yaml.
type DevkitConfig struct {
	SchemaVersion int                   `yaml:"schemaVersion"`
	Version       int                   `yaml:"version"`
	Extends       []string              `yaml:"extends"`
	Workspace     WorkspaceConfig       `yaml:"workspace"`
	Categories    []NamedCategory       `yaml:"categories"`
	Sync          SyncConfig            `yaml:"sync"`
	Scaffolding   ScaffoldingConfig     `yaml:"scaffolding"`
	Run           RunConfig             `yaml:"run"`
	Tasks         map[string]TaskConfig `yaml:"tasks"`
	Affected      AffectedConfig        `yaml:"affected"`
	Presets       map[string]Preset     `yaml:"presets"`
	Checks        ChecksConfig          `yaml:"checks"`
	Fix           FixConfig             `yaml:"fix"`
	Reporting     ReportingConfig       `yaml:"reporting"`
	Custom        []CustomCheck         `yaml:"custom_checks"`
}

// AffectedConfig controls how changed packages are detected.
type AffectedConfig struct {
	// Strategy: "git" (default) | "submodules" | "command"
	//   git        — single `git diff --name-only HEAD` from ws root; works for monorepos without submodules
	//   submodules — walks .gitmodules, runs `git diff` inside each submodule repo
	//   command    — executes Command, expects one file path per line on stdout
	Strategy string `yaml:"strategy"`

	// Command is used when Strategy == "command".
	// Executed in workspace root. Output: one absolute or workspace-relative path per line.
	// Example: "./scripts/changed-files.sh"
	Command string `yaml:"command"`

	// FullInputs are tracked paths whose change invalidates package-level selection.
	FullInputs []string `yaml:"fullInputs"`
}

// TaskVariant is one implementation of a named task.
// Multiple variants can exist under the same task name — the scheduler picks
// the one whose Categories matches the package's category.
// If Categories is empty, the variant applies to all packages (catch-all).
type TaskVariant struct {
	Categories []string `yaml:"categories"` // e.g. ["ts-lib", "ts-app"]; empty = all
	Command    string   `yaml:"command"`
	Inputs     []string `yaml:"inputs"`  // glob patterns relative to package dir
	Outputs    []string `yaml:"outputs"` // glob patterns; empty = cache exit code only
	Deps       []string `yaml:"deps"`    // "^build" = deps' task first; "build" = self's task first
	Cache      *bool    `yaml:"cache"`   // nil = true; false = always run (e.g. deploy)
	// Env names the environment variables the task may read. Their values are
	// part of the task key and the command runs with exactly these plus the
	// toolchain's own (see engine.alwaysPassedEnv); empty = none.
	Env []string `yaml:"env"`
}

// TaskConfig is a list of variants for a named task.
// Variants are evaluated in order; the first matching category wins.
type TaskConfig []TaskVariant

// ResolveVariant returns the first variant whose categories include pkgCategory,
// or the first catch-all variant (empty categories), or nil if none match.
func (tc TaskConfig) ResolveVariant(pkgCategory string) *TaskVariant {
	var catchAll *TaskVariant
	for i := range tc {
		v := &tc[i]
		if len(v.Categories) == 0 {
			if catchAll == nil {
				catchAll = v
			}
			continue
		}
		for _, c := range v.Categories {
			if c == pkgCategory {
				return v
			}
		}
	}
	return catchAll
}

// WorkspaceConfig describes package categories and the package manager.
type WorkspaceConfig struct {
	PackageManager string          `yaml:"packageManager"`
	Discovery      []string        `yaml:"discovery"`
	Categories     []NamedCategory `yaml:"categories"`
	// MaxDepth controls how deep to recurse when expanding ** globs.
	// Default: 3. Increase if your monorepo has deeply nested packages.
	MaxDepth int `yaml:"maxDepth"`
	// Include limits discovery to only these glob patterns (relative to workspace root).
	// If empty, all directories matching category patterns are included.
	Include []string `yaml:"include"`
	// Exclude skips directories matching these glob patterns (relative to workspace root).
	// Evaluated after Include. Supports the same glob syntax as category match patterns.
	Exclude []string `yaml:"exclude"`
}

// NamedCategory is a category entry with its name preserved.
// Categories are evaluated in order — first match wins.
type NamedCategory struct {
	Name     string
	Category CategoryConfig
}

// CategoryConfig matches packages to a preset by glob patterns.
type CategoryConfig struct {
	Match       []string `yaml:"match"`
	Language    string   `yaml:"language"`
	Preset      string   `yaml:"preset"`
	ReleaseLane string   `yaml:"releaseLane"`
	// DefaultBuild false marks the category as a product app (a site, for
	// example): a plain `run` leaves its build task out unless the package is
	// targeted with --packages or selected by --affected. Nil means
	// true.
	DefaultBuild *bool `yaml:"defaultBuild"`
}

// BuiltByDefault reports whether a plain run builds packages of this category.
func (c CategoryConfig) BuiltByDefault() bool {
	return c.DefaultBuild == nil || *c.DefaultBuild
}

// PresetConfig resolves the preset for this category from the given config.
func (c CategoryConfig) PresetConfig(cfg *DevkitConfig) (Preset, error) {
	return ResolvePreset(c.Preset, cfg)
}

// FindCategory returns the CategoryConfig for the given category name, or false if not found.
func (ws *WorkspaceConfig) FindCategory(name string) (CategoryConfig, bool) {
	for _, nc := range ws.Categories {
		if nc.Name == name {
			return nc.Category, true
		}
	}
	return CategoryConfig{}, false
}

// ─── Presets ────────────────────────────────────────────────────────────────

// Preset is a named ruleset for a category of packages.
type Preset struct {
	Extends     string           `yaml:"extends"`
	Language    string           `yaml:"language"`
	PackageJSON PackageJSONRules `yaml:"package_json"`
	TSConfig    TSConfigRules    `yaml:"tsconfig"`
	TSup        TSupRules        `yaml:"tsup"`
	ESLint      ESLintRules      `yaml:"eslint"`
	Structure   StructureRules   `yaml:"structure"`
	Deps        DepsRules        `yaml:"dependencies"`
	Go          GoRules          `yaml:"go"`
}

// PackageJSONRules defines requirements for package.json.
type PackageJSONRules struct {
	RequiredScripts []string          `yaml:"required_scripts"`
	RequiredDevDeps map[string]string `yaml:"required_dev_deps"`
	RequiredFields  []string          `yaml:"required_fields"`
	Type            string            `yaml:"type"`
	Engines         map[string]string `yaml:"engines"`
}

// TSConfigRules defines requirements for tsconfig.json.
type TSConfigRules struct {
	MustExtendPattern string `yaml:"must_extend_pattern"`
	ForbidPaths       bool   `yaml:"forbid_paths"`
}

// TSupRules defines requirements for tsup.config.ts.
type TSupRules struct {
	MustUsePreset       bool   `yaml:"must_use_preset"`
	DTSRequired         bool   `yaml:"dts_required"`
	TSConfigMustBeBuild bool   `yaml:"tsconfig_must_be_build"`
	PresetPattern       string `yaml:"preset_pattern"`
	MustImportPattern   string `yaml:"must_import_pattern"`
}

// ESLintRules defines requirements for eslint.config.js.
type ESLintRules struct {
	MustUsePreset     bool   `yaml:"must_use_preset"`
	MustImportPattern string `yaml:"must_import_pattern"`
}

// StructureRules defines required files that must exist.
type StructureRules struct {
	RequiredFiles []string `yaml:"required_files"`
}

// DepsRules defines dependency analysis rules.
type DepsRules struct {
	CheckLinks              bool `yaml:"check_links"`
	CheckUnused             bool `yaml:"check_unused"`
	CheckCircular           bool `yaml:"check_circular"`
	CheckVersionConsistency bool `yaml:"check_version_consistency"`

	// AllowedKbDeps is an allowlist of @kb-labs/* dependencies the package
	// is permitted to import (both via package.json and source code).
	// Glob patterns are supported (e.g. "@kb-labs/sdk/*"). When non-empty,
	// any @kb-labs/* dep or source import not matching an entry is reported.
	AllowedKbDeps []string `yaml:"allowed_kb_deps"`

	// ForbiddenKbDeps is a denylist of @kb-labs/* dependencies. Reported even
	// if AllowedKbDeps would otherwise permit them — denylist wins.
	ForbiddenKbDeps []string `yaml:"forbidden_kb_deps"`

	// AllowedKbImports and ForbiddenKbImports constrain complete import specifiers.
	// Unlike dependency patterns, these match one exact package subpath.
	AllowedKbImports   []string `yaml:"allowed_kb_imports"`
	ForbiddenKbImports []string `yaml:"forbidden_kb_imports"`
}

// GoRules defines rules for Go packages.
type GoRules struct {
	MinVersion string `yaml:"min_version"`
}

// ─── Scaffolding ─────────────────────────────────────────────────────────────

// ScaffoldingConfig holds named templates for `kb-devkit generate`.
type ScaffoldingConfig struct {
	Templates map[string]ScaffoldTemplate `yaml:"templates"`
}

// ScaffoldTemplate describes a single scaffold template source.
type ScaffoldTemplate struct {
	Source  string `yaml:"source"`  // local | npm | git | url
	Path    string `yaml:"path"`    // local: path relative to workspace root
	Package string `yaml:"package"` // npm: package name
	URL     string `yaml:"url"`     // git | url: remote address
	Ref     string `yaml:"ref"`     // git: branch or tag (optional)
}

// ─── Sync ────────────────────────────────────────────────────────────────────

// SyncConfig describes sync sources and targets.
type SyncConfig struct {
	Sources map[string]SyncSource `yaml:"sources"`
	Targets []SyncTarget          `yaml:"targets"`
	Exclude []string              `yaml:"exclude"`
}

// SyncSource describes where assets come from.
type SyncSource struct {
	Type    string `yaml:"type"`    // npm | local | git | url
	Package string `yaml:"package"` // for type: npm
	Path    string `yaml:"path"`    // for type: local
	URL     string `yaml:"url"`     // for type: git | url
	Ref     string `yaml:"ref"`     // for type: git
}

// SyncTarget maps a source asset to a destination in each submodule.
type SyncTarget struct {
	Source string `yaml:"source"` // key from Sources
	From   string `yaml:"from"`   // path within source FS
	To     string `yaml:"to"`     // destination path relative to submodule root
	Mode   string `yaml:"mode"`   // managed | merge-managed | verify-only
	Signal string `yaml:"signal"` // normal | low
}

// ─── Run ─────────────────────────────────────────────────────────────────────

// RunConfig controls execution engine defaults.
type RunConfig struct {
	// Concurrency is the max number of parallel (package, task) pairs.
	// Default: NumCPU-1. Override with --concurrency flag or this field.
	Concurrency int `yaml:"concurrency"`
	// TaskMemoryMB is the expected peak memory of one running task. The
	// scheduler starts a task only while running tasks plus this estimate fit
	// the host memory budget. Zero disables memory admission.
	TaskMemoryMB int `yaml:"task_memory_mb"`
}

// ─── Custom checks ────────────────────────────────────────────────────────────

// CustomCheck is an escape-hatch checker executed as a shell command.
type CustomCheck struct {
	Name           string   `yaml:"name"`
	Run            string   `yaml:"run"`
	Fix            string   `yaml:"fix"`
	On             []string `yaml:"on"`       // check | gate
	Language       string   `yaml:"language"` // any | typescript | go
	Categories     []string `yaml:"categories"`
	AnchorPackages []string `yaml:"anchor_packages"` // package contexts where the check runs
	RequiresBuild  []string `yaml:"requires_build"`  // workspace packages whose dist output the check reads
	Scope          string   `yaml:"scope"`           // package | workspace
}

type ChecksConfig struct {
	TimeoutMS int                        `yaml:"timeout_ms"`
	Packages  map[string]CheckPackConfig `yaml:"packages"`
}

const DefaultCheckTimeoutMS = 900000

type CheckPackConfig struct {
	Enabled bool           `yaml:"enabled"`
	Config  map[string]any `yaml:"config"`
}

type FixConfig struct {
	DefaultMode string `yaml:"defaultMode"`
}

type ReportingConfig struct {
	Verbose bool `yaml:"verbose"`
}
