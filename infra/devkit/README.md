# KB Labs DevKit (@kb-labs/devkit)

> **A cohesive set of presets and configurations for the `@kb-labs` ecosystem.** TypeScript `tsconfig`, ESLint, Prettier, Vitest, Tsup, and reusable GitHub Actions. The goal is to maximize automation, enforce consistent standards, and eliminate copy-paste across new projects.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.18.0+-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.0.0+-orange.svg)](https://pnpm.io/)

## 🎯 Vision

KB Labs DevKit provides a cohesive set of presets and configurations for the `@kb-labs` ecosystem: TypeScript `tsconfig`, ESLint, Prettier, Vitest, Tsup, and reusable GitHub Actions. The goal is to maximize automation, enforce consistent standards, and eliminate copy-paste across new projects.

The project solves the problem of inconsistent tooling configurations across KB Labs projects by providing a single source of truth for all development tooling. Instead of copying configs between projects, developers can simply extend DevKit presets, ensuring consistency and reducing maintenance overhead.

This project is the foundation for all KB Labs tooling and is used by every project in the ecosystem. It includes a powerful sync system that automatically keeps projects up-to-date with the latest DevKit assets.

## 🚀 Quick Start

### Installation

```bash
pnpm add -D @kb-labs/devkit
# or
npm i -D @kb-labs/devkit
```

### Basic Setup

#### Node Project (TS + Tsup + Vitest + ESLint + Prettier)

**tsconfig.json:**
```json
{
  "extends": "@kb-labs/devkit/tsconfig/node.json"
}
```

**tsup.config.ts:**
```typescript
import config from '@kb-labs/devkit/tsup/node.js'
export default config
```

**vitest.config.ts:**
```typescript
import config from '@kb-labs/devkit/vitest/node.js'
export default config
```

**eslint.config.js** (ESLint 9 flat config):
```javascript
import config from '@kb-labs/devkit/eslint/node.js'
export default config
```

**.prettierrc.json:**
```json
"@kb-labs/devkit/prettier/index.json"
```

**package.json** (example):
```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "lint": "eslint .",
    "test": "vitest",
    "format": "prettier -w ."
  }
}
```

> **Build Convention**: All KB Labs packages use `"build": "tsup"` as the standard convention. The `tsup` preset handles both JavaScript bundling and TypeScript declaration generation (`dts: true`). TypeScript `tsconfig.json` with `references` is for IDE support and type-checking only, not for build orchestration. See [ADR-0009](./docs/adr/0009-unified-build-convention.md) for details.

### Workspace Aliases

For monorepos, DevKit ships with `kb-devkit-paths` – a generator that scans the pnpm workspace and writes `tsconfig.paths.json` with all `@kb-labs/*` aliases. Recommended setup:

```json
{
  "extends": [
    "@kb-labs/devkit/tsconfig/node.json",
    "./tsconfig.paths.json"
  ],
  "compilerOptions": {
    "baseUrl": "."
  }
}
```

Add scripts to your `package.json` so aliases stay fresh whenever DevKit sync runs:

```json
{
  "scripts": {
    "devkit:paths": "pnpm exec kb-devkit-paths",
    "predevkit:sync": "pnpm devkit:paths",
    "predevkit:sync:ci": "pnpm devkit:paths",
    "predevkit:check": "pnpm devkit:paths",
    "predevkit:force": "pnpm devkit:paths"
  }
}
```

Then generate aliases once:

```bash
pnpm run devkit:paths
```

### Repository Synchronization

Sync DevKit assets into your project:

```bash
# Run sync (creates/updates files)
npx kb-devkit-sync

# Check for drift without making changes
npx kb-devkit-sync --check

# Force overwrite existing files
npx kb-devkit-sync --force
```

### Naming Convention Validation

Validate that all packages follow the **Pyramid Rule** (`@kb-labs/{repo}-{package}`):

```bash
# Validate naming convention
npx kb-devkit-validate-naming

# Run from monorepo root (validates all kb-labs-* repos)
cd /path/to/kb-labs
npx kb-devkit-validate-naming
```

**Output:**
- ✅ Lists all valid packages
- ❌ Reports violations with specific suggestions
- Exits with code 1 if violations found (CI-friendly)

See [docs/naming-convention.md](https://github.com/kb-labs/kb-labs-plugin-template/blob/main/docs/naming-convention.md) for the complete Pyramid Rule guide.

### Import Checker

Check for broken imports, unused dependencies, and circular dependencies across all packages:

```bash
# Check all packages for import issues
npx kb-devkit-check-imports

# Check specific package
npx kb-devkit-check-imports --package core-cli

# Show all packages (including clean ones)
npx kb-devkit-check-imports --verbose

# Auto-fix unused dependencies (coming soon)
npx kb-devkit-check-imports --fix
```

**What it checks:**

1. **Broken imports** (🔴): Files that are imported but don't exist
   - Detects typos in import paths
   - Finds missing files after refactoring
   - Reports exact file and line number

2. **Missing workspace dependencies** (🟡): Packages used in code but not in `package.json`
   - Finds `@kb-labs/*` imports not declared as dependencies
   - Shows which files use the missing package
   - Critical for proper workspace resolution

3. **Unused dependencies** (🟠): Dependencies in `package.json` but never imported
   - Excludes build tools (`typescript`, `tsup`, `vitest`, etc.)
   - Excludes type definitions (`@types/*`)
   - Helps keep dependencies clean

4. **Circular dependencies** (🔄): Packages that depend on each other in a cycle
   - Detects circular dependency chains
   - Shows full cycle path (A → B → C → A)
   - Can cause build and runtime issues

**Output:**
- ✅ Clean packages (only with `--verbose`)
- ❌ Packages with issues
- 📊 Summary with counts by issue type
- Exits with code 1 if issues found (CI-friendly)

**Example output:**
```
🔍 KB Labs Import Checker

Found 188 package(s) to check

❌ @kb-labs/core-cli
   kb-labs-core/packages/core-cli

   🔴 Broken imports (2):
      src/commands/run.ts:15
      └─ Cannot resolve: ../utils/missing-file

   🟡 Missing workspace dependencies (1):
      @kb-labs/core-config
      └─ Used in 3 file(s)

   🟠 Unused dependencies (2):
      lodash
      axios

🔄 Circular Dependencies (1):

1. @kb-labs/cli-core → @kb-labs/cli-commands → @kb-labs/cli-core

📊 Summary:
   🔴 2 broken import(s)
   🟡 1 missing workspace dep(s)
   🟠 2 unused dependency(ies)
   🔄 1 circular dependency cycle(s)
```

### Export Checker

Check for unused exports, dead code in public APIs, and package.json export inconsistencies:

```bash
# Check all packages for export issues
npx kb-devkit-check-exports

# Check specific package
npx kb-devkit-check-exports --package core-cli

# Include internal exports (more thorough)
npx kb-devkit-check-exports --strict

# Show all packages (including clean ones)
npx kb-devkit-check-exports --verbose
```

**What it checks:**

1. **Unused exports** (🟠): Exports that are never imported by other packages
   - Identifies dead code in public APIs
   - Finds exports that can be safely removed
   - Helps reduce API surface area
   - Distinguishes between public (index.ts) and internal exports

2. **Missing barrel exports** (🟡): Files with exports not re-exported from index.ts
   - Only shown in `--strict` mode
   - Finds files that may need to be added to public API
   - Or identifies files that should be marked as internal

3. **Inconsistent package.json exports** (🔴): Exports field pointing to non-existent files
   - Validates package.json `exports` field
   - Finds broken export paths
   - Critical for package consumers

**Output:**
- ✅ Clean packages (only with `--verbose`)
- ❌ Packages with unused exports
- 📊 Summary with counts by issue type
- Exits with code 1 if issues found (CI-friendly)

**Example output:**
```
📤 KB Labs Export Checker

Found 188 package(s) to check

❌ @kb-labs/core-cli
   kb-labs-core/packages/core-cli

   🟠 Unused exports (3):
      src/index.ts
      └─ oldFunction (public API)
      └─ deprecatedUtil (public API)
      src/internal/helpers.ts
      └─ internalHelper (internal)

      💡 These exports are never imported by other packages
      💡 Consider removing them to reduce API surface

   🔴 Inconsistent package.json exports (1):
      "./utils" → ./dist/utils.js
      └─ File does not exist

      💡 Update package.json exports field to match actual files

📊 Summary:
   🟠 3 unused export(s)
   🔴 1 inconsistent package.json export(s)
```

### Duplicate Checker

Check for duplicate dependencies with different versions and code duplication patterns:

```bash
# Check for duplicate dependencies
npx kb-devkit-check-duplicates

# Include code duplication analysis
npx kb-devkit-check-duplicates --code

# Show detailed info (outdated deps, full package lists)
npx kb-devkit-check-duplicates --verbose
```

**What it checks:**
1. **Duplicate dependencies** (🔴): Same package with multiple versions
2. **Outdated common dependencies** (🟡): Packages using older versions (with `--verbose`)
3. **Code duplication** (🟠): Similar file names across packages (with `--code`)

### Structure Checker

Validate package structure, required files, and package.json fields:

```bash
# Check all packages
npx kb-devkit-check-structure

# Include recommendations
npx kb-devkit-check-structure --strict

# Check specific package
npx kb-devkit-check-structure --package core-cli
```

**What it checks:**
1. Missing critical files (package.json, src/, tsconfig.json, README.md)
2. Missing package.json fields (name, version, type, exports, etc.)
3. Structure issues (missing index.ts, tests in src/, missing scripts)
4. Documentation quality (README length, missing sections)
5. Configuration consistency (tsconfig using devkit presets)

### Path Validator

Validate all paths and references in package.json, tsconfig.json, and dependencies:

```bash
# Check all paths
npx kb-devkit-check-paths

# Check specific package
npx kb-devkit-check-paths --package=cli-core

# JSON output for CI
npx kb-devkit-check-paths --json
```

**What it validates:**
1. **Workspace dependencies**: `workspace:*` references to non-existent packages
2. **Link references**: `link:../path` pointing to non-existent directories
3. **Package.json exports**: Export paths pointing to non-existent files
4. **Bin scripts**: Bin entries pointing to non-existent scripts
5. **Entry points**: `main`, `module`, `types` fields pointing to missing files
6. **Files field**: Items in `files` array that don't exist
7. **tsconfig.json**: Broken `extends`, `references`, and `paths` aliases

**Severity levels:**
- 🔴 **Errors**: Critical issues (broken links, missing workspace packages)
- ⚠️ **Warnings**: Build-dependent issues (`./dist/*` files that need `pnpm build`)

**Example output:**
```
🔗 KB Labs Path Validator

📦 Missing Workspace Packages (2):
   kb-labs-plugin/
      @kb-labs/ai-docs-plugin
         Workspace package "@kb-labs/setup-engine-operations" does not exist

🔗 Broken Link References (1):
   kb-labs-ai-docs/
      @kb-labs/ai-docs-plugin
         Link path does not exist: ../../../kb-labs-setup-engine/packages/setup-operations

📊 Summary:
   Packages checked:     91
   ❌ Errors:            107
   ⚠️  Warnings:          185
```

### Visualizer

Generate dependency graphs, statistics, and visualizations:

```bash
# Show all visualizations
npx kb-devkit-visualize

# Show dependency graph only
npx kb-devkit-visualize --graph

# Show package statistics
npx kb-devkit-visualize --stats

# Show dependency tree for package
npx kb-devkit-visualize --tree --package cli-core
```

**What it shows:**
1. **Dependency graph**: Visual representation of dependencies
2. **Package statistics**: By repository, most depended-on, largest packages
3. **Dependency tree**: Hierarchical view with `--tree`

### Quick Statistics

Get comprehensive monorepo statistics and health scores:

```bash
# Show all statistics
npx kb-devkit-stats

# Show health score
npx kb-devkit-stats --health

# Output JSON for parsing
npx kb-devkit-stats --json

# Output Markdown table
npx kb-devkit-stats --md
```

**What it shows:**
1. **Overview**: Total packages, repositories, files, LOC, size
2. **Dependencies**: Workspace vs external, duplicates count
3. **By repository**: Package count, LOC breakdown
4. **Health score**: Grade A-F based on issues
5. **Largest packages**: Top 5 by lines of code

**Example output:**
```
📊 KB Labs Monorepo Statistics

📦 Overview:
   Packages:      90
   Repositories:  18
   Lines of Code: 226,514
   Total Size:    6.22 MB

🔗 Dependencies:
   Total:         1,085
   Workspace:     340
   External:      745
   Duplicates:    30 ⚠️

💚 Health Score:
   Score: 68/100 (Grade D)

   Issues:
   🔴 30 duplicate dependencies (-20)
   🟡 12 packages missing README (-12)
```

### Dependency Auto-Fixer

Automatically fix common dependency issues and analyze dependency usage:

```bash
# Show dependency statistics
npx kb-devkit-fix-deps --stats

# Remove unused dependencies (dry-run first!)
npx kb-devkit-fix-deps --remove-unused --dry-run
npx kb-devkit-fix-deps --remove-unused

# Add missing workspace dependencies
npx kb-devkit-fix-deps --add-missing

# Align duplicate dependency versions
npx kb-devkit-fix-deps --align-versions

# Apply all fixes
npx kb-devkit-fix-deps --all

# Fix specific package only
npx kb-devkit-fix-deps --remove-unused --package=core-cli

# Show why dependencies were kept (debug mode)
npx kb-devkit-fix-deps --remove-unused --dry-run --verbose
```

**What it fixes:**
1. **Removes unused dependencies**: Safely removes deps not found in source code
   - Scans `src/`, `test/`, `tests/`, `__tests__/`, `scripts/` directories
   - Checks config files (`tsup.config.ts`, `vitest.config.ts`, etc.)
   - Respects peer dependencies
2. **Adds missing workspace deps**: Adds `@kb-labs/*` packages imported but not declared
3. **Aligns duplicate versions**: Picks most common version and aligns all packages

**Statistics mode (`--stats`):**
```
📊 Dependency Statistics

📦 Total packages:        91
📚 Total dependencies:    353
🔧 Total devDependencies: 586
🔗 Total peerDependencies: 4

🔝 Top 10 Most Used Dependencies:
    1. tsup (91 packages)
    2. typescript (84 packages)
    3. @types/node (83 packages)
    ...
```

**Safety features:**
- Always use `--dry-run` first to preview changes
- Excludes build tools (typescript, tsup, vitest, esbuild, vite, rimraf, etc.)
- Excludes testing tools (vitest, jest, playwright, @vitest/*, @testing-library/*)
- Excludes type definitions (@types/*)
- Excludes linting tools (eslint-*, @eslint/*, @typescript-eslint/*, prettier-plugin-*)
- Respects peer dependencies (won't remove if listed in peerDependencies)
- Use `--verbose` to see why dependencies were kept
- Sorts dependencies alphabetically after changes

**Orphan packages analysis (`--orphans`):**

Find packages that no other package depends on (potential dead code):

```bash
# Find orphan packages
npx kb-devkit-fix-deps --orphans

# JSON output for CI
npx kb-devkit-fix-deps --orphans --json
```

Output categorizes orphans into:
- ✅ **CLI Entry Points** - Expected orphans (entry points like @kb-labs/cli-bin)
- ✅ **Plugin Packages** - Usually standalone (@kb-labs/plugin-*, *-plugin)
- ✅ **External Libraries** - Consumed externally (@kb-labs/*-core, ui-*, etc.)
- ⚠️ **Internal Packages** - Review needed (might be dead code!)

Example output:
```
👻 Orphan Packages Analysis

📦 Total @kb-labs/* packages:    90
🔗 Packages with dependents:     70
👻 Orphan packages:              25

✅ CLI Entry Points (4) - Expected orphans:
   @kb-labs/cli-bin
   @kb-labs/analytics-cli
   ...

📦 Plugin Packages (6) - Usually standalone:
   @kb-labs/ai-docs-plugin
   ...

📤 External/Library Packages (9) - Consumed externally:
   @kb-labs/devlink/core
   ...

⚠️  Internal Packages Without Dependents (6) - Review needed:
   kb-labs-shared/
      @kb-labs/shared-boundaries
      @kb-labs/shared-repo
      @kb-labs/shared-textops

📊 Summary:
   Expected orphans: 19
   Review needed:    6
```

### CI Combo Tool

Run all DevKit checks in one command for CI/CD pipelines:

```bash
# Run all checks
npx kb-devkit-ci

# Skip specific checks
npx kb-devkit-ci --skip=exports,duplicates

# Run only specific checks
npx kb-devkit-ci --only=naming,imports

# JSON output for CI parsing
npx kb-devkit-ci --json
```

**Checks performed:**
1. ✅ Naming convention validation
2. ✅ Import analysis (broken imports, unused deps, circular deps)
3. ✅ Export analysis (unused exports, dead code)
4. ✅ Duplicate dependencies
5. ✅ Package structure validation
6. ✅ Path validation (workspace deps, exports, bin)
7. ✅ TypeScript types (dts generation, types field)

**CI-friendly features:**
- Exits with code 1 on failures
- JSON output for parsing
- Per-check timing information
- Summary with passed/failed counts

**Example GitHub Actions integration:**
```yaml
name: DevKit Checks
on: [pull_request]
jobs:
  devkit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run DevKit CI
        run: npx kb-devkit-ci --json > devkit-report.json
      - name: Upload Report
        uses: actions/upload-artifact@v4
        with:
          name: devkit-report
          path: devkit-report.json
```

### QA Runner

**⚡ NEW: Comprehensive quality assurance with incremental builds**

Run all quality checks across the entire monorepo (build, lint, type-check, tests):

```bash
# Run all QA checks
npx kb-devkit-qa

# Skip specific checks
npx kb-devkit-qa --skip-build --skip-tests

# JSON mode for AI agents
npx kb-devkit-qa --json
```

**What it checks:**
1. **Build** - All packages in correct layer order (13 layers, 125 packages)
   - ⚡ **Incremental**: Only rebuilds when `src/` is newer than `dist/`
   - 🚀 **Speed**: ~10-20 seconds when up-to-date (vs 5-10 minutes full rebuild)
2. **Lint** - ESLint on all packages
3. **Type Check** - TypeScript type checking on all packages
4. **Tests** - Vitest tests on all packages (with `--passWithNoTests`)

**Key features:**
- ✅ Continues on errors (shows all failures, not just first)
- ✅ Progress indicators: `.` = passed, `F` = failed, `-` = skipped (up-to-date)
- ✅ Comprehensive summary report at the end
- ✅ JSON mode for CI/CD and AI agents
- ⚡ **30x faster** with incremental builds

**Example output:**
```
🚀 KB Labs QA Runner

🔨 Building all packages in correct dependency order...
Found 13 layers to build

🔨 Building Layer 1/13 (21 packages)...
--------------------- (all skipped, up-to-date)

✅ Build complete: 0 passed, 0 failed, 100 skipped (up-to-date)

📊 QA Summary Report
✅ Build:       100 skipped (up-to-date)
❌ Lint:        70/125 passed (56%)
❌ Type Check:  60/125 passed (48%)
❌ Tests:       78/125 passed (62%)

Total: 208 passed, 167 failed, 100 skipped
```

**Root commands (package.json):**
```bash
pnpm qa              # Run all checks
pnpm qa:quick        # Skip tests
pnpm qa:full         # With baseline comparison
```

**How incremental builds work:**
- Compares modification times of `src/` vs `dist/`
- Rebuilds only if source is newer than build output
- Skips packages that are already up-to-date
- First run builds all, subsequent runs ~20 seconds

**JSON mode example:**
```json
{
  "status": "failed",
  "summary": {
    "build": { "passed": 0, "failed": 0, "skipped": 100 },
    "lint": { "passed": 70, "failed": 55, "skipped": 0 }
  },
  "failures": {
    "lint": ["@kb-labs/cli", "@kb-labs/core", ...]
  }
}
```

### Build Order Calculator

Calculate the correct build order for packages based on dependencies:

```bash
# Show sequential build order
npx kb-devkit-build-order

# Show parallel build layers
npx kb-devkit-build-order --layers

# Build order for specific package
npx kb-devkit-build-order --package=workflow-runtime

# Generate build script
npx kb-devkit-build-order --script > build.sh
npx kb-devkit-build-order --layers --script > build-parallel.sh

# JSON output
npx kb-devkit-build-order --json
```

**What it does:**
1. **Builds dependency graph**: Analyzes all workspace dependencies
2. **Topological sort**: Determines correct build order using Kahn's algorithm
3. **Detects circular dependencies**: Shows packages involved in cycles
4. **Parallel build layers**: Groups packages that can build in parallel
5. **Generates build scripts**: Creates executable bash scripts for automation

**Example output:**
```
📦 Build order for @kb-labs/workflow-runtime:

  1. @kb-labs/cli-contracts
  2. @kb-labs/shared-cli-ui
  3. @kb-labs/core-sys
  ...
 16. @kb-labs/workflow-runtime ⬅ target
```

**With --layers:**
```
Layer 1 (15 packages):
   @kb-labs/core-types
   @kb-labs/cli-contracts
   ...

Layer 2 (23 packages):
   @kb-labs/core-sys
   @kb-labs/plugin-manifest
   ...

Total layers: 5
Max parallelism: 23 packages
```

### Command Health Checker

Automatically check all CLI commands in the ecosystem:

```bash
# Check all commands
npx kb-devkit-check-commands

# Quick check (faster)
npx kb-devkit-check-commands --fast

# Verbose output
npx kb-devkit-check-commands --verbose

# Custom timeout
npx kb-devkit-check-commands --timeout=10

# JSON output for CI
npx kb-devkit-check-commands --json
```

**What it checks:**
1. **Command discovery**: Finds all commands from plugin manifests
2. **Help output**: Tests each command with `--help`
3. **Exit codes**: Verifies commands exit with code 0
4. **Timeouts**: Detects slow or hanging commands
5. **Error detection**: Identifies broken commands with detailed errors

**Example output:**
```
🔍 KB Labs Command Health Checker

Found 107 commands to check

✅ Working commands (103):
   kb plugins:list
   kb workflow:run
   ...

❌ Broken commands (4):
   kb ai:analyze --help
   └─ Error: Cannot find module '@kb-labs/ai-core'

📊 Summary:
   ✅ 103 working (96%)
   ❌ 4 broken (4%)
```

### TypeScript Types Checker

Ensure all packages properly generate TypeScript declaration files:

```bash
# Check all packages for types generation
npx kb-devkit-check-types

# Auto-fix dts: false → dts: true
npx kb-devkit-check-types --fix

# Check specific package
npx kb-devkit-check-types --package=mind-engine

# Verbose output
npx kb-devkit-check-types --verbose

# Show types dependency graph
npx kb-devkit-check-types --graph

# JSON output for CI
npx kb-devkit-check-types --json
```

**What it checks:**
1. **Technical debt detection**: Finds `dts: false` in tsup configs (bad practice!)
2. **Missing configuration**: Detects packages without dts settings
3. **package.json types field**: Validates "types" field exists
4. **Actual .d.ts files**: Checks if declaration files exist in dist/
5. **Auto-fix capability**: Can automatically change `dts: false` to `dts: true`

**Example output:**
```
🔍 KB Labs TypeScript Types Checker

Found 90 packages to check

🔴 Technical Debt: 7 package(s) with dts: false

   @kb-labs/cli-core
      /path/to/tsup.config.ts
      └─ Has "dts: false" - types not being generated!
      ✅ Fixed: Changed to "dts: true"

📊 Summary:
   Total packages:       90
   With TypeScript:      90
   ✅ Clean:             21
   🔴 dts: false:        7 (technical debt!)
   ⚠️  Other issues:      62
```

**Why this matters:**

In a monorepo, TypeScript types form a dependency chain:
```
Project A uses type G from Package B
Package B uses type L from Package M
...
```

If any package in the chain has `dts: false` or missing types, TypeScript compilation breaks. This tool helps identify and fix those broken chains automatically.

### TypeScript Types Order

Calculate the correct order for types generation (separate from build order):

```bash
# Show types generation order
npx kb-devkit-types-order

# Show parallel generation layers
npx kb-devkit-types-order --layers

# Types order for specific package
npx kb-devkit-types-order --package=workflow-runtime

# Show only broken type chains
npx kb-devkit-types-order --broken

# JSON output
npx kb-devkit-types-order --json
```

**What it does:**
1. **Types dependency analysis**: Tracks which packages import types from which other packages
2. **Broken chain detection**: Finds packages that import types from packages with `dts: false`
3. **Circular type dependencies**: Detects cycles in type imports
4. **Topological sort**: Determines correct order for .d.ts generation
5. **Parallel layers**: Groups packages whose types can be generated in parallel

**Example output:**
```
📘 Types generation order for @kb-labs/workflow-runtime:

  1. ✅ @kb-labs/plugin-manifest
  2. ✅ @kb-labs/shared-cli-ui
  3. ✅ @kb-labs/core-types
  ...
 18. ✅ @kb-labs/workflow-runtime ⬅ target
```

**Difference from build-order:**
- `build-order`: Tracks **runtime** dependencies (what needs to be built first)
- `types-order`: Tracks **type** dependencies (what types are imported from where)

### TypeScript Types Audit

Centralized type safety audit for entire monorepo using TypeScript Compiler API:

```bash
# Full audit report
npx kb-devkit-types-audit

# Audit specific package
npx kb-devkit-types-audit --package=workflow-runtime

# Show only critical errors
npx kb-devkit-types-audit --errors-only

# Detailed coverage report
npx kb-devkit-types-audit --coverage

# JSON output
npx kb-devkit-types-audit --json
```

**What it does:**
1. **Deep type analysis**: Uses TypeScript Compiler API for semantic analysis
2. **Type errors**: Finds all type errors across monorepo (what `tsc` would show)
3. **Type coverage**: Calculates coverage % for each package
4. **Impact analysis**: Shows which packages are affected by type errors
5. **Safety issues**: Detects `any` usage, `@ts-ignore` comments, missing types

**Example output:**
```
📊 TypeScript Type Safety Audit Report

❌ Critical Issues (12 packages with type errors):
   @kb-labs/workflow-runtime
      45 error(s) - impacts 8 package(s)
      └─ ./src/auth.ts:45:10
         Type 'any' is not assignable to 'string[]'

🔍 Type Safety Issues:
   127 usage(s) of 'any' type
   45 @ts-ignore comment(s)

📈 Type Coverage:
   ✅ Excellent (≥90%): 56 packages
   ⚠️  Good (70-90%):   28 packages
   ❌ Poor (<70%):      6 packages

📊 Summary:
   Total packages:     90
   ❌ Type errors:     234
   📈 Avg coverage:    84.3%
```

**Why this is powerful:**

Instead of running `tsc` in each package separately, you get:
- **Single centralized report** for entire monorepo
- **Impact analysis**: See which packages break if type X has errors
- **Type coverage metrics**: Track type safety over time
- **Dependency chains**: Understand type inheritance relationships

See [USAGE_GUIDE.md](./USAGE_GUIDE.md) for comprehensive usage examples, real-world use cases, and best practices.

**Automatic Build Configuration:**

After sync, DevKit automatically generates `tsconfig.build.json` for all packages with `tsup.config.ts`. This ensures proper bundling configuration without manual setup.

To generate `tsup.external.json` manually (if needed):

```bash
npx kb-devkit-tsup-external --generate
```

### QA History Tracker

Track QA metrics over time and detect regressions:

```bash
npx kb-devkit-qa-history save          # Save current QA results with git context
npx kb-devkit-qa-history show          # Show last 20 runs
npx kb-devkit-qa-history trends        # Show quality trends over time
npx kb-devkit-qa-history regressions   # Detect new failures since last save
```

**Root commands:**
```bash
pnpm qa:save         # Save current QA state
pnpm qa:history      # Show history
pnpm qa:trends       # Show trends
pnpm qa:regressions  # Detect regressions (exits 1 on regression)
```

### Core Gate

Check if the 6 core platform monorepos meet zero-failure quality requirements. Reads from the last `pnpm qa` run — no recompilation:

```bash
npx kb-devkit-core-gate             # Gate check (exits 1 if core is broken)
npx kb-devkit-core-gate --verbose   # Show failing packages
npx kb-devkit-core-gate --json      # JSON output
```

**Core monorepos checked:** `kb-labs-cli`, `kb-labs-core`, `kb-labs-shared`, `kb-labs-sdk`, `kb-labs-rest-api`, `kb-labs-plugin`

**Requirements:** build → zero failures, types → zero errors, lint → zero errors

**Typical flow:**
```bash
pnpm qa          # Run checks
pnpm core:gate   # Inspect core result
```

### Architecture Audit

Analyze monorepo architecture and detect structural issues:

```bash
npx kb-devkit-architecture             # Full audit (JSON + HTML graph + markdown report)
npx kb-devkit-architecture --json      # AI-readable JSON output
npx kb-devkit-architecture --md        # Markdown report only
npx kb-devkit-architecture --trends    # Compare with previous runs
```

**Detects 10 anomaly types** (scored by severity):
- Circular dependencies (100), Layer violations (90), God packages (80)
- Unstable core (75), Bidirectional dependencies (70)
- Large packages >10K LOC (60), Orphan packages (60)
- Many dependencies >10 (50), Deep chains >7 (50), Missing docs (40)

### Freshness Tracker

Detect stale packages — when package A uses an old build of dependency B:

```bash
npx kb-devkit-freshness                     # Default table output
npx kb-devkit-freshness --json              # JSON for AI agents
npx kb-devkit-freshness --only-stale        # Show only stale packages
npx kb-devkit-freshness --suggest-rebuild   # Show rebuild order
npx kb-devkit-freshness --package=cli-core  # Single package analysis
npx kb-devkit-freshness --age-days=30       # Packages not built in 30+ days
npx kb-devkit-freshness --high-impact=5     # Packages affecting 5+ others
```

### Config Checker

Check all packages for configuration drift from standard DevKit templates:

```bash
npx kb-devkit-check-configs                      # Check all packages
npx kb-devkit-check-configs --fix                # Auto-fix with backup
npx kb-devkit-check-configs --package=cli-core   # Check specific package
npx kb-devkit-check-configs --ci                 # CI mode (fail on drift)
```

**What it validates:**
- Missing or modified config files vs standard templates
- `tsup.config.ts` structure (nodePreset usage, `dts: true`, etc.)
- Duplicate external/ignores declarations

### Scripts Checker

Validate that all packages have required scripts and devDependencies:

```bash
npx kb-devkit-check-scripts                      # Check all packages
npx kb-devkit-check-scripts --fix                # Auto-add missing scripts
npx kb-devkit-check-scripts --package=cli-core   # Check specific package
```

**Required scripts validated:** `clean`, `build`, `dev`, `lint`, `lint:fix`, `type-check`, `test`, `test:watch`

### Deprecated Code Checker

Find all `@deprecated` markers in the codebase with context:

```bash
npx kb-devkit-check-deprecated                       # Check all packages
npx kb-devkit-check-deprecated --package cli-core    # Check specific package
npx kb-devkit-check-deprecated --json                # JSON output
npx kb-devkit-check-deprecated --stats               # Statistics only
npx kb-devkit-check-deprecated --verbose             # Full context
```

**Finds:** JSDoc `@deprecated` tags, TypeScript `@deprecated` patterns, inline `// @deprecated` comments.

### Build Readiness Checker

Analyze whether packages can be successfully bundled (useful before creating standalone executables):

```bash
npx kb-devkit-check-build-readiness
npx kb-devkit-check-build-readiness --package @kb-labs/cli-bin
npx kb-devkit-check-build-readiness --fix
```

**Checks:** missing packages in imports, broken import paths, dependency chains that would fail bundling.

### Config Migrator

Mass migration to standardize all package configurations to current DevKit templates:

```bash
npx kb-devkit-migrate-configs                      # Dry run (preview only)
npx kb-devkit-migrate-configs --apply              # Apply changes
npx kb-devkit-migrate-configs --package=cli-core   # Migrate specific package
npx kb-devkit-migrate-configs --force              # Skip confirmation prompts
```

Creates backups before applying changes and generates a migration report.

## ✨ Features

- **TypeScript**: Ready-to-use `tsconfig` for libraries, Node services, and CLIs
- **ESLint**: ESLint 9 flat config with TypeScript support
- **Prettier**: Single opinionated formatting profile
- **Vitest**: Base test/coverage profile with lib/node overlays
- **Tsup**: Standard builds for libraries and Node services
- **GitHub Actions**: Reusable CI/PR/Release workflows
- **AI Agents**: Standardized Cursor agents for common development tasks
- **Fixtures**: Validation fixtures to ensure DevKit changes don't break downstream consumers
- **Repository Sync**: Automated synchronization system to keep projects up-to-date

## 📁 Repository Structure

```
kb-labs-devkit/
├── agents/                  # AI agent definitions
│   ├── devkit-maintainer/   # DevKit maintainer agent
│   ├── test-generator/      # Test generator agent
│   ├── docs-crafter/        # Documentation drafter agent
│   └── release-manager/     # Release manager agent
├── bin/                     # Executable scripts
│   └── devkit-sync.mjs      # Sync tool binary
├── eslint/                  # ESLint presets
├── fixtures/                # Validation fixtures
│   ├── lib/                 # Library fixture
│   ├── cli/                 # CLI fixture
│   ├── web/                 # Web app fixture
│   └── monorepo/            # Monorepo fixture
├── prettier/                # Prettier config
├── scripts/                 # Utility scripts
├── sync/                    # Sync system
├── tsconfig/                # TypeScript configs
├── tsup/                    # Tsup configs
├── vite/                    # Vite configs
├── vitest/                  # Vitest configs
└── docs/                    # Documentation
    └── adr/                  # Architecture Decision Records
```

### Directory Descriptions

- **`agents/`** - Pre-configured AI agent definitions for Cursor and other IDE assistants
- **`bin/`** - Executable scripts (sync tool)
- **`fixtures/`** - Validation fixtures that act as minimal, real-world consumer projects
- **`docs/`** - Documentation including ADRs and guides
- **Preset directories** (`tsconfig/`, `eslint/`, `prettier/`, `vitest/`, `tsup/`) - Tooling presets

## 📦 Presets

### TypeScript (`tsconfig`)

Available configs:
- `base.json`: strict base (ES2022, NodeNext, strict typing, isolatedModules)
- `cli.json`: CLI application preset
- `lib.json`: library preset  
- `node.json`: Node service – declarations, source maps, `include: ["src"]`
- `react-lib.json`: React library preset
- `react-app.json`: React application preset
- `test.json`: Test configuration preset

All configs use `module: "NodeNext"` and `moduleResolution: "NodeNext"` for proper ESM support.

**Usage:**
```json
{
  "extends": "@kb-labs/devkit/tsconfig/node.json"
}
```

### ESLint

- `eslint/node.js`: ESLint 9 flat config with TypeScript support
- `eslint/react.js`: ESLint 9 flat config with React support

Features:
- Uses `typescript-eslint` recommended rules
- Ignores `dist/`, `coverage/`, `node_modules/`, `.yalc/`
- Allows unused variables with `_` prefix
- Consistent type imports

### Prettier

- `prettier/index.json`: shared style (no semicolons, single quotes, width 100)

### Tsup

- `tsup/node.js`: ESM-only build (target ES2022, sourcemap, clean, treeshake)
- `tsup/react-lib.js`: React library build preset

**Automatic Configuration:**

DevKit automatically handles bundling configuration to prevent workspace packages from being bundled:

1. **`tsconfig.build.json`**: Automatically generated by `kb-devkit-sync` for all packages with `tsup.config.ts`. This file extends your base `tsconfig.json` but sets `paths: {}` to prevent tsup from resolving workspace packages to their source files.

2. **`tsup.external.json`**: Automatically generated by `kb-devkit-tsup-external` (runs in `postinstall`). This file lists all workspace packages and dependencies that should be treated as external by tsup.

**Usage:**

Your `tsup.config.ts` should reference `tsconfig.build.json`:

```typescript
import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node.js';

export default defineConfig({
  ...nodePreset,
  entry: { index: "src/index.ts" },
  tsconfig: "tsconfig.build.json", // Use build-specific tsconfig without paths
});
```

The `nodePreset` automatically reads `tsup.external.json` and marks all workspace packages as external, ensuring they are not bundled.

Features:
- ESM format only
- ES2022 target
- Source maps enabled
- Tree shaking enabled
- Clean output directory
- Automatic `external` list generated from `dependencies` + `peerDependencies`

### Vitest

- `vitest/node.js`: Node environment with coverage support
- `vitest/react.js`: React environment with coverage support

Features:
- Node/React environment
- Coverage with V8 provider (disabled by default)
- Excludes `node_modules/`, `dist/`, etc.
- Strict coverage thresholds when enabled

## 🛠️ Available Scripts

| Script | Description |
|--------|-------------|
| `kb-devkit-health` | **⚡ NEW:** Comprehensive monorepo health check - detects missing deps, build failures, type errors |
| `kb-devkit-ci` | Run all critical checks (naming, imports, exports, duplicates, paths, types) |
| `kb-devkit-fix-deps` | Auto-fix dependency issues (unused deps, missing deps, version alignment) |
| `kb-devkit-stats` | Get monorepo health score and statistics |
| `kb-devkit-check-imports` | Check for broken imports, unused deps, circular deps |
| `kb-devkit-check-exports` | Find unused exports and dead code |
| `kb-devkit-types-audit` | Deep TypeScript type safety analysis for entire monorepo |
| `pnpm fixtures:check` | Check all fixtures (recommended for CI) |
| `pnpm fixtures:lint` | Lint all fixtures |
| `pnpm fixtures:test` | Test all fixtures |
| `pnpm fixtures:build` | Build all fixtures |
| `pnpm fixtures:bootstrap` | Bootstrap all fixtures |
| `pnpm fixtures:clean` | Clean all fixtures |
| `pnpm fixtures:ci` | Run fixtures check for CI |

### 🏥 Health Check Tool

The `kb-devkit-health` tool is a comprehensive monorepo health check that catches critical issues early:

```bash
# Full health check (recommended before major changes)
npx kb-devkit-health

# Quick check (skips slow build and type checks)
npx kb-devkit-health --quick

# JSON output for CI/CD or AI agents
npx kb-devkit-health --json

# Check specific package
npx kb-devkit-health --package cli-core
```

**What it checks:**
- ✅ Missing runtime dependencies (imports not in package.json)
- ✅ Cross-repo workspace vs link inconsistencies
- ✅ Build failures across all packages
- ✅ TypeScript type errors
- ✅ Circular dependencies
- ✅ Orphan packages

**Example output:**
```
🏥 KB Labs Monorepo Health Check

Analyzing 208 package(s)...

❌ CRITICAL ISSUES (blocking)
   • 4 package(s) with missing runtime dependencies
     @kb-labs/cli-commands: @kb-labs/plugin-contracts, @kb-labs/devkit

   • 2 cross-repo dep(s) using workspace:* instead of link:
     @kb-labs/core-sys → @kb-labs/shared-cli-ui

Health Score: 50/100 (Grade F)

Recommended Actions:
   1. Fix missing runtime dependencies:
      kb-devkit-fix-deps --add-missing
```

## 📋 Development Policies

- **Code Style**: ESLint + Prettier, TypeScript strict mode
- **Testing**: Vitest with fixtures for integration testing
- **Versioning**: SemVer with automated releases through Changesets
- **Architecture**: Document decisions in ADRs (see `docs/adr/`)
- **Preset Stability**: Presets maintain backward compatibility
- **Sync System**: Automated drift detection and synchronization

## 🔧 Requirements

- **Node.js**: >= 18.18.0
- **pnpm**: >= 9.0.0

## ⚙️ Configuration

### Repository Synchronization

The DevKit includes a powerful sync system that allows you to keep your project up-to-date with the latest DevKit assets. This is especially useful for maintaining consistent tooling across KB Labs projects.

#### Quick Sync

```bash
# Run sync (creates/updates files)
npx kb-devkit-sync

# Check for drift without making changes
npx kb-devkit-sync --check

# Force overwrite existing files
npx kb-devkit-sync --force
```

#### Sync Configuration

Create a `kb-labs.config.json` file in your project root to customize sync behavior:

```json
{
  "sync": {
    "enabled": true,
    "disabled": ["vscode"],
    "only": ["ci", "agents"],
    "scope": "managed-only",
    "force": false,
    "overrides": {
      "cursorrules": { "to": ".config/cursor/rules.json" }
    },
    "targets": {
      "workflows": {
        "from": ".github/workflows", 
        "to": ".github/workflows", 
        "type": "dir"
      }
    }
  }
}
```

#### Configuration Options

- **`enabled`**: Boolean to enable/disable sync entirely (default: true)
- **`disabled`**: Array of target names to skip during sync
- **`only`**: Array of target names to sync (if empty, syncs all enabled targets)
- **`scope`**: Drift detection mode: `"managed-only"` (default), `"strict"`, or `"all"`
- **`force`**: Boolean to force overwrite existing files (can be set in config or via `--force` flag)
- **`overrides`**: Override source paths, destination paths, or types for existing targets
- **`targets`**: Add custom sync targets with `from`, `to`, and `type` properties

#### Available Targets

By default, the sync tool includes these targets:
- **`agents`**: AI agent definitions → `.kb/devkit/agents/`
- **`cursorrules`**: Cursor AI rules → `.cursorrules`
- **`vscode`**: VS Code settings → `.vscode/settings.json`

#### Drift Detection Modes

The sync tool supports three drift detection modes:

- **`managed-only`** (default): Compare only files explicitly synced from DevKit. Safe for repositories with additional project-specific files.
- **`strict`**: Compare entire target directories and flag unmanaged files as drift. Use when you want to ensure no extra files exist.
- **`all`**: Legacy mode that combines strict checking with unmanaged file detection.

### GitHub Actions Integration

Add a drift check to your CI to ensure your project stays in sync:

```yaml
name: CI
on: [push, pull_request]
jobs:
  ci:
    uses: kb-labs/devkit/.github/workflows/ci.yml@main
    with:
      enable-drift-check: true
```

Or use the dedicated drift check workflow:

```yaml
name: Drift Check
on:
  workflow_dispatch: {}
  schedule:
    - cron: '0 3 * * *' # nightly
jobs:
  drift:
    uses: kb-labs/devkit/.github/workflows/drift-check.yml@main
```

## 🤖 AI Agents

This DevKit includes pre-configured AI agents that can be synced into any KB Labs project. These agents are opinionated around KB Labs workflows (pnpm, devkit presets, monorepo). Outside this ecosystem, adapt accordingly.

| Agent | Purpose |
|-------|---------|
| **DevKit Maintainer** | Enforce unified tooling (tsconfig, eslint, prettier, vitest, tsup, CI) |
| **Test Generator** | Generate and maintain pragmatic unit tests |
| **Docs Drafter** | Draft and update README/CONTRIBUTING/ADR docs |
| **Release Manager** | Prepare release plans, changelog, and GitHub releases |

Each agent includes:
- **Prompt**: AI instructions and context
- **Runbook**: step-by-step procedures
- **Context**: file patterns and permissions

To sync agents into your project:
```bash
# Copy agent definitions from this DevKit
npx kb-devkit-sync agents
```

They are designed for Cursor AI agents, but can also be adapted for GitHub Copilot Chat or other IDE assistants.

See [`AGENTS.md`](./AGENTS.md) for detailed agent documentation.

## 🧪 Validation Fixtures

This DevKit includes fixtures (`/fixtures/*`) that act as minimal, real-world consumer projects to validate DevKit changes:

- **`fixtures/lib`**: A simple TypeScript library using DevKit presets
- **`fixtures/cli`**: A CLI application with Commander.js
- **`fixtures/web`**: A web application with DOM API and fetch
- **`fixtures/monorepo`**: A monorepo with shared library and app packages

Each fixture has its own `package.json` and extends DevKit via imports/extends (no relative paths).

### Fixture Management

Use the automated fixture management script:

```bash
# Check all fixtures (recommended for CI)
pnpm fixtures:check

# Check specific fixture
pnpm fixtures lib check
pnpm fixtures cli test
pnpm fixtures web build
pnpm fixtures monorepo lint

# Run specific action on all fixtures
pnpm fixtures:lint   # Lint all fixtures
pnpm fixtures:test   # Test all fixtures
pnpm fixtures:build  # Build all fixtures

# Show help
pnpm fixtures
```

The `fixtures:check` script runs all validation steps and is used in CI to ensure DevKit changes don't break downstream consumers.

See [`scripts/README.md`](./scripts/README.md) for detailed fixture management documentation.

## 📚 Documentation

- [Documentation Standard](./docs/DOCUMENTATION.md) - Full documentation guidelines
- [Contributing Guide](./CONTRIBUTING.md) - How to contribute
- [Architecture Decisions](./docs/adr/) - ADRs for this project

**Guides:**
- [AI Agents](./AGENTS.md) - AI agent documentation
- [Fixture Management](./scripts/README.md) - Fixture management documentation

**Architecture:**
- [ADR 0001: Repository Synchronization via DevKit](./docs/adr/0001-repo-synchronization-via-devkit.md) - Strategy for maintaining consistent tooling
- [ADR 0002: ESM-only and NodeNext](./docs/adr/0002-esm-only-and-nodenext.md) - ESM-only modules with NodeNext resolution
- [ADR 0003: Validation Fixtures Strategy](./docs/adr/0003-validation-fixtures-strategy.md) - Testing DevKit presets with realistic consumer projects
- [ADR 0004: Testing Strategy and Quality Gates](./docs/adr/0004-testing-strategy-and-quality-gates.md) - Comprehensive testing approach
- [ADR 0005: Build & Types Strategy](./docs/adr/0005-build-strategy.md) - Unified approach to build and type generation
- [ADR 0006: Sequential Build & Type Safety](./docs/adr/0006-monorepo-build-and-types.md) - Build order and dependency resolution
- [ADR 0007: Reusable Workflow Strategy](./docs/adr/0007-reusable-workflow-strategy.md) - Centralized CI workflows and drift check
- [ADR 0008: Flexible Sync and Drift Management](./docs/adr/0008-flexible-sync-strategy.md) - Managed-only drift strategy with provenance tracking
- [ADR 0011: Preventing Workspace Package Bundling](./docs/adr/0011-preventing-workspace-package-bundling.md) - Automatic externalization of workspace packages in tsup builds

## Migration Guides

- [Migrating to Workspace External Bundling](./docs/guides/migrating-to-workspace-external-bundling.md) - Step-by-step guide for preventing workspace package bundling

## 🔗 Related Packages

### Dependencies

- None (devkit is a foundation package)

### Used By

- [@kb-labs/core](https://github.com/KirillBaranov/kb-labs-core) - Core utilities
- [@kb-labs/cli](https://github.com/KirillBaranov/kb-labs-cli) - CLI framework
- [@kb-labs/audit](https://github.com/KirillBaranov/kb-labs-audit) - Audit framework
- [@kb-labs/ai-review](https://github.com/KirillBaranov/kb-labs-ai-review) - AI Review
- All other KB Labs projects

### Ecosystem

- [KB Labs](https://github.com/kb-labs-team/kb-labs) - Main ecosystem repository

## 💡 Use Cases

- Bootstrap new packages/services without copying configs
- Enforce consistent style and rules across the ecosystem
- Provide a single minimal CI for PRs and releases
- Migrate existing projects to shared presets with minimal effort
- Validate DevKit changes against real-world usage patterns

## 📖 Migration Guide

### Updating to Latest DevKit

To update your project to the latest DevKit version:

1. **Update the package**:
```bash
pnpm update @kb-labs/devkit
```

2. **Check for drift**:
```bash
npx kb-devkit-sync --check
```

3. **Sync changes** (if drift found):
```bash
npx kb-devkit-sync --force
```

4. **Review and commit changes**:
```bash
git add .
git commit -m "chore: update devkit to latest version"
```

### Migrating from Manual Setup

If you're migrating from manually copied configs to the sync system:

1. **Install DevKit**:
```bash
pnpm add -D @kb-labs/devkit
```

2. **Create sync configuration**:
```json
{
  "sync": {
    "disabled": ["vscode"],
    "overrides": {
      "cursorrules": { "to": ".cursorrules" }
    }
  }
}
```

3. **Run initial sync**:
```bash
npx kb-devkit-sync --force
```

4. **Remove old config files** and update imports to use DevKit presets

5. **Add drift check to CI**:
```yaml
jobs:
  ci:
    uses: kb-labs/devkit/.github/workflows/ci.yml@main
    with:
      enable-drift-check: true
```

## ❓ FAQ

### General

- **Can I override rules?** — Yes. Extend locally and add your overrides on top.
- **How do I update?** — Bump `@kb-labs/devkit` and run `npx kb-devkit-sync --check` to see what changed.
- **ESLint 9 flat config?** — Yes, all ESLint configs use the new flat config format.
- **ESM only?** — Yes, all presets assume ESM. For CJS, add dual builds/transpilation in your project.
- **TypeScript errors with module resolution?** — Ensure you're using `module: "NodeNext"` in your tsconfig.
- **Importing specific files vs folders?** — Both are supported. Use `@kb-labs/devkit/tsconfig/node.json` for specific files or `


## 📦 Complete Tools Summary

DevKit provides **29 tools** for monorepo management and quality assurance:

### Analysis Tools (12)
1. **Import Checker** (`kb-devkit-check-imports`) - Broken imports, unused deps, circular deps
2. **Export Checker** (`kb-devkit-check-exports`) - Unused exports and dead code
3. **Duplicate Checker** (`kb-devkit-check-duplicates`) - Duplicate dependencies
4. **Structure Checker** (`kb-devkit-check-structure`) - Package structure validation
5. **Naming Validator** (`kb-devkit-validate-naming`) - Pyramid Rule naming convention
6. **Path Validator** (`kb-devkit-check-paths`) - Workspace deps, exports, bin paths
7. **TypeScript Types Audit** (`kb-devkit-types-audit`) - Deep type safety across monorepo
8. **Visualizer** (`kb-devkit-visualize`) - Dependency graphs and stats
9. **Architecture Audit** (`kb-devkit-architecture`) - Structural anomalies, layer violations
10. **Deprecated Checker** (`kb-devkit-check-deprecated`) - Find `@deprecated` markers
11. **Build Readiness** (`kb-devkit-check-build-readiness`) - Pre-bundle dependency analysis
12. **Config Checker** (`kb-devkit-check-configs`) - Drift from standard templates

### Automation Tools (11)
1. **QA Runner** (`kb-devkit-qa`) - ⚡ Incremental builds + lint + types + tests
2. **QA History** (`kb-devkit-qa-history`) - Track metrics over time, detect regressions
3. **Core Gate** (`kb-devkit-core-gate`) - Zero-failure gate for 6 core monorepos
4. **Quick Statistics** (`kb-devkit-stats`) - Health scores and metrics
5. **Dependency Auto-Fixer** (`kb-devkit-fix-deps`) - Auto-fix dependency issues
6. **CI Combo Tool** (`kb-devkit-ci`) - All static checks in one command
7. **Build Order Calculator** (`kb-devkit-build-order`) - Correct build order with layers
8. **Types Order Calculator** (`kb-devkit-types-order`) - Types generation order
9. **Command Health Checker** (`kb-devkit-check-commands`) - Verify all CLI commands work
10. **TypeScript Types Checker** (`kb-devkit-check-types`) - Ensure packages generate types
11. **Scripts Checker** (`kb-devkit-check-scripts`) - Validate required package scripts

### Infrastructure Tools (6)
1. **Repository Sync** (`kb-devkit-sync`) - Sync DevKit assets across projects
2. **Path Aliases Generator** (`kb-devkit-paths`) - Generate workspace path aliases
3. **Tsup External Generator** (`kb-devkit-tsup-external`) - Generate external deps list
4. **Freshness Tracker** (`kb-devkit-freshness`) - Detect stale packages in dep chains
5. **Config Migrator** (`kb-devkit-migrate-configs`) - Mass migrate configs to current templates
6. **Health Check** (`kb-devkit-health`) - Comprehensive health check with grade A–F

### Quick Access
```bash
# Quality Assurance (recommended)
npx kb-devkit-qa                      # ⚡ Incremental builds (~20s)
npx kb-devkit-qa-history regressions  # Detect regressions
npx kb-devkit-core-gate               # Zero-failure gate for core
npx kb-devkit-ci                      # All static checks

# Analysis
npx kb-devkit-check-imports           # Imports
npx kb-devkit-check-exports           # Exports
npx kb-devkit-types-audit             # Type safety
npx kb-devkit-architecture --md       # Architecture report
npx kb-devkit-freshness --only-stale  # Stale packages

# Automation
npx kb-devkit-fix-deps --dry-run      # Fix dependencies
npx kb-devkit-build-order --layers    # Build order
npx kb-devkit-stats --health          # Health score
npx kb-devkit-check-configs           # Config drift
```

## License

MIT License - see [LICENSE](LICENSE) for details.
