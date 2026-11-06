package checks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kb-labs/devkit/internal/config"
	"github.com/kb-labs/devkit/internal/workspace"
)

func newBoundaryPreset() config.Preset {
	return config.Preset{
		Deps: config.DepsRules{
			AllowedKbDeps: []string{
				"@kb-labs/sdk",
				"@kb-labs/sdk/*",
				"@kb-labs/devkit",
			},
			ForbiddenKbDeps: []string{
				"@kb-labs/core-*",
				"@kb-labs/adapters-*",
			},
		},
	}
}

func TestDepsRuleBoundary_ForbidsCorePlatformDependency(t *testing.T) {
	pkg := tempPackage(t, `{
	  "name": "@kb-labs/adapters-foo",
	  "devDependencies": {"@kb-labs/core-platform": "workspace:*"}
	}`)
	issues := (&DepsRule{}).Check(pkg, newBoundaryPreset())
	if len(issues) != 1 {
		t.Fatalf("issues = %d, want 1; got %#v", len(issues), issues)
	}
	if !strings.Contains(issues[0].Message, "@kb-labs/core-platform") {
		t.Fatalf("issue message = %q, want core-platform mention", issues[0].Message)
	}
}

func TestDepsRuleBoundary_AllowsSdkDependency(t *testing.T) {
	pkg := tempPackage(t, `{
	  "name": "@kb-labs/adapters-foo",
	  "devDependencies": {"@kb-labs/sdk": "workspace:*", "@kb-labs/devkit": "workspace:*"}
	}`)
	issues := (&DepsRule{}).Check(pkg, newBoundaryPreset())
	if len(issues) != 0 {
		t.Fatalf("issues = %#v, want none", issues)
	}
}

func TestDepsRuleBoundary_ForbidsSourceImport(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
	  "name": "@kb-labs/adapters-foo",
	  "devDependencies": {"@kb-labs/sdk": "workspace:*", "@kb-labs/core-platform": "workspace:*"}
	}`), 0o644); err != nil {
		t.Fatalf("write pkg: %v", err)
	}
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	srcContent := `import { ILogger } from '@kb-labs/core-platform';
import { defineAdapterManifest } from '@kb-labs/sdk/adapters';
export const x = 1;
`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(srcContent), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	pkg := workspace.Package{Name: "@kb-labs/adapters-foo", Dir: dir}
	issues := (&DepsRule{}).Check(pkg, newBoundaryPreset())
	if len(issues) != 2 {
		t.Fatalf("issues = %d, want dependency and import boundary findings; got %#v", len(issues), issues)
	}
	if !strings.Contains(issues[0].Message, "@kb-labs/core-platform") {
		t.Fatalf("issue = %q, want core-platform mention", issues[0].Message)
	}
}

func TestDepsRuleBoundary_IgnoresImportsInCommentsAndStrings(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
  "name": "@kb-labs/adapters-foo",
  "devDependencies": {"@kb-labs/sdk": "workspace:*"}
}`), 0o644); err != nil {
		t.Fatalf("write pkg: %v", err)
	}
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	srcContent := `/**
 * import { createAdapter } from '@kb-labs/adapters-blob-storage';
 */
const example = "import { createAdapter } from '@kb-labs/adapters-fs';";
import { defineAdapterManifest } from '@kb-labs/sdk/adapters';
export const x = 1;
`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(srcContent), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	pkg := workspace.Package{Name: "@kb-labs/adapters-foo", Dir: dir}
	issues := (&DepsRule{}).Check(pkg, newBoundaryPreset())
	if len(issues) != 0 {
		t.Fatalf("issues = %#v, want none", issues)
	}
}

func TestDepsRuleBoundary_AllowlistFlagsUnknownKbDep(t *testing.T) {
	pkg := tempPackage(t, `{
	  "name": "@kb-labs/adapters-foo",
	  "devDependencies": {"@kb-labs/shared-cli-ui": "workspace:*"}
	}`)
	issues := (&DepsRule{}).Check(pkg, newBoundaryPreset())
	if len(issues) != 1 {
		t.Fatalf("issues = %d, want 1; got %#v", len(issues), issues)
	}
	if !strings.Contains(issues[0].Message, "shared-cli-ui") {
		t.Fatalf("issue = %q, want shared-cli-ui mention", issues[0].Message)
	}
}

func TestDepsRuleBoundary_AllowsSelfAndNestedSdkPaths(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
	  "name": "@kb-labs/adapters-foo",
	  "devDependencies": {"@kb-labs/sdk": "workspace:*"}
	}`), 0o644); err != nil {
		t.Fatalf("write pkg: %v", err)
	}
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	srcContent := `import { IPCTransport } from '@kb-labs/sdk/adapters/infra';
import { defineAdapterManifest } from '@kb-labs/sdk/adapters';
import { local } from '@kb-labs/adapters-foo/internal';
`
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(srcContent), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	pkg := workspace.Package{Name: "@kb-labs/adapters-foo", Dir: dir}
	issues := (&DepsRule{}).Check(pkg, newBoundaryPreset())
	if len(issues) != 0 {
		t.Fatalf("issues = %#v, want none", issues)
	}
}

func TestDepsRuleRequiresWorkspaceImportsToBeDeclaredOutsideSrc(t *testing.T) {
	pkg := tempPackage(t, `{"name":"@kb-labs/e2e-platform"}`)
	pkg.PnpmMember = true
	writePkgFile(t, pkg.Dir, "scripts/check.mjs", `await import('@kb-labs/core-platform');`)

	rule := &DepsRule{}
	issues := rule.Check(pkg, config.Preset{})
	if len(issues) != 1 || !strings.Contains(issues[0].Message, `@kb-labs/core-platform`) {
		t.Fatalf("issues = %#v, want undeclared import from scripts/check.mjs", issues)
	}
	if issues[0].File != filepath.Join(pkg.Dir, "scripts/check.mjs") {
		t.Fatalf("issue file = %q, want the importing file", issues[0].File)
	}
}

func TestDepsRuleAcceptsOptionalWorkspaceDependency(t *testing.T) {
	pkg := tempPackage(t, `{"name":"@kb-labs/core-runtime","optionalDependencies":{"@kb-labs/gateway-core":"workspace:*"}}`)
	pkg.PnpmMember = true
	writePkgFile(t, pkg.Dir, "src/loader.ts", `await import('@kb-labs/gateway-core');`)

	rule := &DepsRule{}
	rule.SetWorkspace(&workspace.Workspace{Packages: []workspace.Package{
		{Name: pkg.Name, Dir: pkg.Dir, PnpmMember: true},
		{Name: "@kb-labs/gateway-core", PnpmMember: true},
	}})
	issues := rule.Check(pkg, config.Preset{})
	if len(issues) != 0 {
		t.Fatalf("issues = %#v, optional workspace dependency is declared", issues)
	}
}

func TestDepsRuleRejectsWorkspaceDependencyWithoutPnpmMember(t *testing.T) {
	root := t.TempDir()
	writePkgFile(t, root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n")
	writePkgFile(t, root, "packages/consumer/package.json", `{"name":"@kb-labs/consumer","dependencies":{"@kb-labs/absent":"workspace:*"}}`)
	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{
		Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}},
	}}}}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	var pkg workspace.Package
	for _, candidate := range ws.Packages {
		if candidate.Name == "@kb-labs/consumer" {
			pkg = candidate
		}
	}
	rule := &DepsRule{}
	rule.SetWorkspace(ws)
	issues := rule.Check(pkg, config.Preset{})
	if len(issues) != 1 || !strings.Contains(issues[0].Message, `@kb-labs/absent`) {
		t.Fatalf("issues = %#v, want missing pnpm member @kb-labs/absent", issues)
	}
	if issues[0].File != filepath.Join(pkg.Dir, "package.json") {
		t.Fatalf("issue file = %q, want the declaring manifest", issues[0].File)
	}
}

func TestDepsRuleRejectsRelativeImportIntoWorkspacePackage(t *testing.T) {
	root := t.TempDir()
	writePkgFile(t, root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n")
	writePkgFile(t, root, "packages/e2e/package.json", `{"name":"@kb-labs/e2e"}`)
	writePkgFile(t, root, "packages/core/package.json", `{"name":"@kb-labs/core"}`)
	writePkgFile(t, root, "packages/core/src/index.js", `export const value = true;`)
	writePkgFile(t, root, "packages/e2e/test/case.test.mjs", `import { value } from '../../core/src/index.js';`)

	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{
		Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}},
	}}}}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	var pkg workspace.Package
	for _, candidate := range ws.Packages {
		if candidate.Name == "@kb-labs/e2e" {
			pkg = candidate
		}
	}
	rule := &DepsRule{}
	rule.SetWorkspace(ws)
	issues := rule.Check(pkg, config.Preset{})
	if len(issues) != 1 || !strings.Contains(issues[0].Message, "@kb-labs/core") {
		t.Fatalf("issues = %#v, want cross-package relative import", issues)
	}
}

func TestDepsRuleIgnoresRelativeImportIntoNonPnpmFixturePackage(t *testing.T) {
	root := t.TempDir()
	writePkgFile(t, root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n")
	writePkgFile(t, root, "packages/e2e/package.json", `{"name":"@kb-labs/e2e"}`)
	writePkgFile(t, root, "fixtures/update-adapter/package.json", `{"name":"@kb-labs/fixture-adapter"}`)
	writePkgFile(t, root, "fixtures/update-adapter/manifest.js", `export const manifest = {};`)
	writePkgFile(t, root, "packages/e2e/test/case.test.mjs", `import { manifest } from '../../../fixtures/update-adapter/manifest.js';`)
	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{
		Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}},
	}, {
		Name: "fixture", Category: config.CategoryConfig{Match: []string{"fixtures/*"}},
	}}}}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	rule := &DepsRule{}
	rule.SetWorkspace(ws)
	var pkg workspace.Package
	for _, candidate := range ws.Packages {
		if candidate.Name == "@kb-labs/e2e" {
			pkg = candidate
		}
	}
	if pkg.Name == "" {
		t.Fatal("workspace package @kb-labs/e2e was not discovered")
	}
	issues := rule.Check(pkg, config.Preset{})
	if len(issues) != 0 {
		t.Fatalf("issues = %#v, non-pnpm packed fixture paths are data, not workspace package imports", issues)
	}
}

func TestDepsRuleDoesNotAttributeNestedNonWorkspacePackageImports(t *testing.T) {
	root := t.TempDir()
	writePkgFile(t, root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n")
	writePkgFile(t, root, "packages/e2e/package.json", `{"name":"@kb-labs/e2e"}`)
	writePkgFile(t, root, "packages/e2e/fixtures/plugin/package.json", `{"name":"@kb-labs/e2e-plugin-fixture"}`)
	writePkgFile(t, root, "packages/e2e/fixtures/plugin/src/index.js", `import '@kb-labs/core-platform';`)
	cfg := &config.DevkitConfig{Workspace: config.WorkspaceConfig{Categories: []config.NamedCategory{{
		Name: "packages", Category: config.CategoryConfig{Match: []string{"packages/*"}},
	}}}}
	ws, err := workspace.New(root, cfg)
	if err != nil {
		t.Fatalf("discover workspace: %v", err)
	}
	var pkg workspace.Package
	for _, candidate := range ws.Packages {
		if candidate.Name == "@kb-labs/e2e" {
			pkg = candidate
		}
	}
	rule := &DepsRule{}
	rule.SetWorkspace(ws)
	if issues := rule.Check(pkg, config.Preset{}); len(issues) != 0 {
		t.Fatalf("issues = %#v, nested non-workspace fixture must not be attributed to parent", issues)
	}
}

func TestDepsRuleBoundary_RestrictsFactoryConstructionSubpathToAllowedPreset(t *testing.T) {
	base := newBoundaryPreset()
	base.Deps.ForbiddenKbImports = []string{"@kb-labs/plugin-execution-factory/construct"}
	allowed := base
	allowed.Deps.AllowedKbImports = []string{"@kb-labs/plugin-execution-factory/construct"}

	for _, test := range []struct {
		name          string
		preset        config.Preset
		want          int
		wantForbidden bool
	}{
		{name: "plane denied", preset: base, want: 2, wantForbidden: true},
		{name: "runtime allowed", preset: allowed, want: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"@kb-labs/sample","devDependencies":{"@kb-labs/plugin-execution-factory":"workspace:*"}}`), 0o644); err != nil {
				t.Fatalf("write package: %v", err)
			}
			srcDir := filepath.Join(dir, "src")
			if err := os.MkdirAll(srcDir, 0o755); err != nil {
				t.Fatalf("mkdir src: %v", err)
			}
			if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte(`import { createExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';`), 0o644); err != nil {
				t.Fatalf("write src: %v", err)
			}
			pkg := workspace.Package{Name: "@kb-labs/sample", Dir: dir}
			issues := (&DepsRule{}).Check(pkg, test.preset)
			if len(issues) != test.want {
				t.Fatalf("issues = %#v, want %d", issues, test.want)
			}
			if test.wantForbidden {
				found := false
				for _, issue := range issues {
					if issue.Message == `forbidden import "@kb-labs/plugin-execution-factory/construct"` {
						found = true
					}
				}
				if !found {
					t.Fatalf("issues = %#v, want the constructor-boundary refusal", issues)
				}
			}
		})
	}
}

func TestMatchPatternHandlesGlobAndPrefix(t *testing.T) {
	cases := []struct {
		s, pattern string
		want       bool
	}{
		{"@kb-labs/core-platform", "@kb-labs/core-*", true},
		{"@kb-labs/core-runtime", "@kb-labs/core-*", true},
		{"@kb-labs/sdk", "@kb-labs/sdk", true},
		{"@kb-labs/sdk/adapters", "@kb-labs/sdk", true},
		{"@kb-labs/sdk/adapters/infra", "@kb-labs/sdk/*", true},
		{"@kb-labs/sdk", "@kb-labs/sdk/*", true},
		{"@kb-labs/shared-cli", "@kb-labs/core-*", false},
		{"@kb-labs/adapters-x", "@kb-labs/sdk", false},
	}
	for _, c := range cases {
		got := matchPattern(c.s, c.pattern)
		if got != c.want {
			t.Errorf("matchPattern(%q, %q) = %v, want %v", c.s, c.pattern, got, c.want)
		}
	}
}
