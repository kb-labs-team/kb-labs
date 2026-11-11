# kb-devkit

Go binary for workspace orchestration: quality checks, config sync, and task execution with content-addressable caching.

`kb-devkit` is config-first. The binary owns schema, merge semantics, execution, checks, fixes, and sync. Policy lives in `devkit.yaml` and reusable YAML packs loaded via `extends`.

## Build

```bash
make build
```

## Quick start

```bash
# Create starter config
kb-devkit init

# Build all packages (cached)
kb-devkit run build

# Second run — everything cached, <1s
kb-devkit run build

# Only changed packages + downstream dependents
kb-devkit run build lint test --affected
```

---

## Commands

### `init` — create devkit.yaml

```bash
kb-devkit init           # creates a minimal starter config
kb-devkit init --force   # overwrite existing
```

Generates a short `devkit.yaml` that you can extend with packs, tasks, checks, and sync targets.

### Packs and `extends`

`devkit.yaml` can compose built-in, local, and package-provided packs:

```yaml
schemaVersion: 2
extends:
  - builtin:generic
  - ./devkit/packs/frontend.yaml
  - package:@acme/devkit-pack#devkit.pack.yaml
```

Supported references:
- `builtin:<name>`: embedded pack shipped with the binary
- relative or absolute file path: local YAML pack
- `package:<pkg>#<path>`: pack loaded from `node_modules/<pkg>/<path>`

Packs can contribute:
- `presets`
- `tasks`
- `sync`
- `checks.packages`
- `custom_checks`

---

### `run` — task execution engine

Runs named tasks across all packages in dependency order with content-addressable caching.
Tasks are defined in `devkit.yaml`. Each task can have multiple **variants** — one per package category.

```bash
kb-devkit run build
kb-devkit run build lint
kb-devkit run build lint test --affected
kb-devkit run build --packages @acme/core-types,@acme/core-runtime
kb-devkit run build --no-cache
kb-devkit run build --live          # stream stdout/stderr in real time
kb-devkit run build --json
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--affected` | Run only changed packages + all downstream dependents |
| `--packages` | Comma-separated list of package names |
| `--no-cache` | Bypass cache lookup (still stores result) |
| `--live` | Stream output in real time (forces `concurrency=1`) |
| `--concurrency N` | Max parallel tasks (default: `run.concurrency` in yaml, then `NumCPU-1`) |

**How caching works:**

1. Hash all input files matching `inputs:` glob patterns → SHA256 key
2. Cache hit → restore output files in ~1ms, mark `cached`
3. Cache miss → run command → store outputs → write manifest

Cache lives in `.kb/devkit/`. Objects are content-addressable — the same file content in two packages is stored once.

Each task has its own independent cache keyed by `(taskName, package, inputHash)`. Running `build` does not populate the `lint` cache — they track different inputs and are stored separately. The only connection between tasks is `deps:` — if `lint` declares `deps: ["build"]`, build runs first (from cache if available), then lint runs fresh.

**`--affected` detection:**

Controlled by `affected.strategy` in `devkit.yaml`:

| Strategy | Behaviour |
|----------|-----------|
| `git` | Single `git diff --name-only HEAD` from workspace root (default) |
| `submodules` | Walks `.gitmodules`, runs `git diff` inside each submodule |
| `command` | Runs `affected.command`, reads one file path per line from stdout |

CI may pass a generated JSON path manifest with `affected --changed-files-file <path>`; kb-devkit resolves the paths against its discovered workspace and uses the same dependency graph as the configured strategies.

After finding directly changed packages, BFS expands through the reverse dependency graph to include all downstream dependents.

---

### `check` — quality checks

```bash
kb-devkit check                           # check gating packages and workspace rules
kb-devkit check --package @acme/core     # check single package
kb-devkit check --internal-tool-package github.com/kb-labs/kb-runner # package-scoped internal-tool checks
kb-devkit check --json
```

Package checks follow the declared release lane: the default check runs package rules for gating packages and workspace rules against the full workspace. `--package <name>` selects one package while retaining workspace rules. `--internal-tool-package <name>` requires the selected package's category to declare `releaseLane: internal-tool` and runs package rules only; workspace checks remain in the candidate full check. Rules validate the matched preset: naming, tsconfig, eslint, required scripts, deps, and files.

`check --json` returns:
- `summary`
- `groups`
- `capabilities`
- `results`

External command-based checks declared in `custom_checks` are included in the same pipeline.
For each invocation, kb-devkit sets `KB_DEVKIT_CHECK_RESULT_FILE` to a private
temporary result path. The check must synchronously write its JSON
`{ "issues": [...] }` result there before exiting. stdout and stderr are kept
for human diagnostics; kb-devkit does not decode results from either stream.
Missing or invalid result files are reported as execution failures naming the
check and the file problem.

Node checks under `scripts/checks/` use the shared synchronous writer:

```js
import { writeCheckResult } from './lib/check-result.mjs';

writeCheckResult(issues);
```

The helper writes to `KB_DEVKIT_CHECK_RESULT_FILE` when kb-devkit sets it.
The workspace `checks.timeout_ms` value bounds each external check. It defaults
to 900000 milliseconds (15 minutes); the KB Labs workspace declares 2400000
milliseconds (40 minutes) to cover its two-pass Go suite. While checks run,
`kb-devkit check` writes their package, check name, and elapsed time to stderr;
an expired external check returns `KB_DEVKIT_CHECK_EXECUTION_FAILED` with its
check name.

### `fix` — auto-fix violations

```bash
kb-devkit fix
kb-devkit fix --dry-run
kb-devkit fix --safe
kb-devkit fix --scaffold
kb-devkit fix --all
kb-devkit fix --package @acme/core
```

Fix modes:
- `--safe`: deterministic in-place fixes
- `--scaffold`: create missing deterministic files
- `--sync`: apply issues marked as sync-managed
- `--all`: all supported fix capabilities

### `stats` — workspace health

```bash
kb-devkit stats           # health score A–F, issue counts by category
kb-devkit stats --json
```

### `status` — package table

```bash
kb-devkit status          # table: name, category, preset, issues
kb-devkit status --json
```

### `sync` — config sync

```bash
kb-devkit sync --check    # report drift without applying
kb-devkit sync --dry-run  # preview changes
kb-devkit sync            # apply
```

### `watch` — file watcher

```bash
kb-devkit watch --json    # stream violations as JSONL on file save
```

### `gate` — pre-commit gate

```bash
kb-devkit gate            # check staged files only; exits 1 on violations
```

### `doctor` — environment diagnostics

```bash
kb-devkit doctor --json
```

---

## Configuration (`devkit.yaml`)

Minimal starter config:

```yaml
schemaVersion: 2
extends: [builtin:generic]

workspace:
  discovery:
    - "packages/**"
  categories:
    libs:
      match: ["packages/**"]
      preset: node-lib
```

### Categories

Categories classify packages and control which task variant runs for them. They are declared as an **ordered list** — the first matching category wins.

```yaml
workspace:
  categories:
    # More specific entries first — literal paths match before globs.
    spa:
      match:
        - "apps/studio"   # literal path, no wildcards
      preset: node-app

    ts-app:
      match:
        - "platform/*/apps/**"   # glob — would also match studio, but spa is declared first
      preset: node-app

    ts-lib:
      match:
        - "platform/*/packages/**"
      preset: node-lib

    go-binary:
      match:
        - "tools/devkit"   # literal path — Go package without package.json
      preset: go-binary

    private-tool:
      match:
        - "tools/private-tool"
      preset: go-binary
      releaseLane: internal-tool
```

**Matching rules:**
- Categories are evaluated top-to-bottom; first match wins — declaration order matters.
- `releaseLane: internal-tool` marks a private developer tool. Categories without this declaration keep their existing gating membership.
- Candidate verification removes only selected internal tools from its gating package set. Internal tools retain build, test, and package check tasks, and their candidate results are reported separately from the candidate verdict.
- Literal paths (no `*` or `**`) and glob patterns can be mixed freely in any order.
- Go packages or other non-JS directories don't need `package.json` — use a literal path in `match`.
- Packages that don't match any category are silently ignored by all commands.

### Task variants

Each task can have multiple variants — selected by package category. The scheduler picks the first variant whose `categories` list includes the package's category. Packages with no matching variant are silently skipped for that task.

```yaml
tasks:
  build:
    # TypeScript libraries and apps
    - categories: [ts-lib, ts-app]
      command: tsup
      inputs:
        - "src/**"
        - "tsup.config.ts"
        - "tsconfig*.json"
      outputs:
        - "dist/**"
      deps:
        - "^build"      # run 'build' for all workspace deps first

    # Go binaries
    - categories: [go-binary]
      command: make build
      inputs:
        - "**/*.go"
        - "go.mod"
        - "go.sum"
        - "Makefile"

    # Next.js sites
    - categories: [site]
      command: pnpm build
      inputs:
        - "app/**"
        - "components/**"
        - "next.config.*"
      outputs:
        - ".next/**"
      deps:
        - "^build"      # wait for ts-lib deps (e.g. @kb-labs/sdk)

  lint:
    - categories: [ts-lib, ts-app]
      command: eslint src/
      inputs: ["src/**", "eslint.config.*"]

    - categories: [site]
      command: eslint app/ components/
      inputs: ["app/**", "components/**", "eslint.config.*"]

  type-check:
    - categories: [ts-lib, ts-app, site]
      command: tsc --noEmit
      inputs: ["src/**", "tsconfig*.json"]
      deps: ["^build"]

  test:
    - categories: [ts-lib, ts-app]
      command: vitest run --passWithNoTests
      inputs: ["src/**", "test/**", "vitest.config.*"]
      outputs: ["coverage/**"]
      deps: ["build"]

  deploy:
    - command: ./scripts/deploy.sh   # no categories = applies to all
      inputs: ["dist/**"]
      cache: false                   # always runs, never cached
```

### External command checks and fixers

You can extend `kb-devkit` without Go plugins by declaring command-based checks in YAML packs or directly in `devkit.yaml`.

```yaml
checks:
  packages:
    external-readme:
      enabled: true
      config:
        requiredFile: README.md

custom_checks:
  - name: external-readme
    run: "./node_modules/@acme/devkit-pack/bin/external-readme.sh"
    fix: "./node_modules/@acme/devkit-pack/bin/external-readme.sh"
    on: ["check"]
    language: typescript
    scope: package
```

Runtime contract:
- command runs from workspace root
- package-scope checks run once per matching package; stdin receives JSON with `package`, `preset`, `workspaceRoot`, `check`, `phase`, `config`
- workspace-scope checks run once per invocation and receive `workspace: { root, packages }`; every package includes its resolved `name`, `dir`, `relPath`, `category`, `preset`, and `language`
- fix commands also receive `issues` and `dryRun`
- env includes `KB_DEVKIT_MODE`, `KB_DEVKIT_PACKAGE_*`, `KB_DEVKIT_WORKSPACE_ROOT`

Set `scope: workspace` when the check must compare packages or enforce a workspace-wide invariant. It runs once and gets the same resolved package categories that kb-devkit uses for its tasks and package checks.

Expected JSON output:

```json
{
  "issues": [
    {
      "check": "external-readme",
      "severity": "error",
      "message": "README missing",
      "file": "/repo/packages/demo/README.md",
      "fix": "create README.md",
      "capability": "scaffoldable"
    }
  ]
}
```

For fix commands, returning `{"actions":["..."]}` is allowed but optional.

**Single variant (shorthand)** — if a task applies to all packages and needs no category filter, write it as a plain object:

```yaml
tasks:
  deploy:
    command: ./scripts/deploy.sh
    inputs: ["dist/**"]
    cache: false
```

### Dep syntax

| Value | Meaning |
|-------|---------|
| `^build` | Run `build` for every workspace dependency first (like Turbo `^`) |
| `build` | Run `build` for this same package first |

### `cache: false`

Set on tasks that must always run (e.g. deploy, publish). Result is not stored or restored from cache.

### Concurrency

```yaml
run:
  concurrency: 8   # max parallel (pkg, task) pairs; default: NumCPU-1
```

Override per-run with `--concurrency N`.

### Affected detection

```yaml
affected:
  strategy: submodules   # git | submodules | command
  # command: ./scripts/changed-files.sh
```

---

## Cache layout

```
.kb/devkit/
  objects/
    ab/
      cdef1234...    ← raw file content, keyed by SHA256
  tasks/
    @kb-labs__core-types/
      build/
        abc123.json  ← manifest: input hash → output file refs + stdout
  tmp/
    staging-*        ← atomic write staging area
```

Same file content in two packages → one object. Rename-only change → new manifest, same objects.

---

## Architecture

```
cmd/
  init.go         ← kb-devkit init (generate starter devkit.yaml)
  run.go          ← kb-devkit run (task engine entry)
  check.go        ← kb-devkit check
  …

internal/
  cache/
    hash.go       ← InputHasher: globs → SHA256
    store.go      ← ObjectStore (LocalStore + interface for S3/R2)
    manifest.go   ← Manifest: inputHash → output refs + stdout
  engine/
    task.go       ← TaskDef, TaskResult, ResolveTaskDef(cfg, taskName, category)
    executor.go   ← hash → lookup → run → store
    scheduler.go  ← DAG builder (Kahn's), layer parallelism, AffectedPackages
  config/
    config.go     ← DevkitConfig, TaskConfig ([]TaskVariant), AffectedConfig, …
    yaml.go       ← YAML parsing — TaskVariant accepts single object or list
  workspace/
    workspace.go  ← Package (with Category field), Workspace, PackageByPath
    discover.go   ← glob-based package discovery
  checks/         ← individual quality check implementations
```
