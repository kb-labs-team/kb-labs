# KB Labs CLI — Experience Design

> Working document. Covers: namespace audit, naming rules, agent-native interface design,
> systemic enforcement model.
>
> Related: `docs/plans/cli-naming-audit.md`, `docs/adr/0018-cli-namespace-ownership.md`

---

## 1. Namespace Audit

### System namespaces (reserved — plugins cannot register)
`auth`, `platform`, `info`, `logs`, `docs`, `registry`, `marketplace`, `completion`, `__complete`, `__internal`

### Plugin namespaces

| Namespace | Package | Status |
|---|---|---|
| `agent` | agents | ✅ |
| `clickup` | clickup | ✅ subcommands need refactoring |
| `commit` | commit | ✅ accepted exception: verb-first |
| `devlink` | devlink | ⚠️ opaque name |
| `workspace` | host-agents | ✅ |
| `impact` | impact-core | ⚠️ abstract name |
| `infra-worker` | infra-worker | ❌ kebab at top level + internal concept leaked |
| `mind` | mind | ⚠️ internal term + kebab subcommands |
| `policy` | policy-core | ✅ |
| `qa` | qa | ✅ devkit metrics domain |
| `quality` | quality | ⚠️ kebab subcommands |
| `release` | release | ✅ accepted exception: verb-first |
| `review` | review | ✅ accepted exception: verb-first |
| `scaffold` | scaffold | ✅ accepted exception: verb-first |
| `workflow` | workflow-entry | ✅ subcommands need refactoring |

### marketplace collision resolved

Consumer management is the built-in platform command group `kb marketplace`;
its handlers live in `cli/commands`. The separate publisher CLI remains the
`hub` plugin (`@kb-labs/marketplace-registry`), and its backend is an
optional self-hosted service.

---

## 2. Naming Rules

### Rule 1 — Top-level is always a noun (domain / resource)

The top level names a domain the user works in, not an action.

```
✓ agent, workflow, marketplace, quality
✗ install, run-workflow
```

Accepted verb-first exceptions (document, don't extend the pattern):
`commit`, `review`, `release`, `scaffold`

### Rule 2 — Second-level is a verb from the standard vocabulary

Do not invent new verbs. The closed vocabulary lives in
`docs/architecture/target/06-command-naming.md` section 2 (this draft table predated it;
`yank`, `deprecate`, `share`, `check`, `verify`, `generate` did not survive the review) and is
enforced by `scripts/checks/check-manifest-command-naming.mjs` (`VERBS`).

### Rule 3 — No kebab-case in path segments

```
✗ quality check-layers   →  ✓ quality check layers run
✗ workflow runs-list     →  ✓ workflow runs list
✗ mind rag-query         →  ✓ mind search
```

### Rule 4 — No implementation details in names

```
✗ infra-worker    →  ✓ infra
✗ mind rag-query  →  ✓ mind search
✗ mind sync-add   →  ✓ mind sync add
```

### Rule 5 — One package owns one top-level namespace (ADR-0018)

First `packageName` to register a top-level group owns it.
Second plugin with a different `packageName` → warn + shadow.

### Rule 6 — Reserved platform namespaces are explicit

Documented in `scripts/checks/check-cli-naming.mjs` and `cli/commands/src/registry/service.ts`.

---

## 3. Refactoring Backlog

### 🔴 Must fix

| # | What | Problem | Fix |
|---|---|---|---|
| R1 | `infra-worker` | kebab top-level + internal concept | Rename namespace to `infra` |
| R2 | `marketplace` was registered as a plugin | Marketplace is part of platform use | ✅ Fixed — register `kb marketplace` as a built-in system group; keep publisher commands in `hub` |

### 🟡 Should fix

| # | What | Fix |
|---|---|---|
| R3 | `quality`: `check-layers`, `fix-deps`, `dead-code`, `check-types`, `check-builds`, `check-tests`, `build-order` | Restructure as subgroups: `quality check layers run`, `quality deps update` |
| R4 | `workflow`: `runs-list`, `runs-view`, `runs-watch`, `runs-rerun`, `job-run` | `workflow runs list`, `workflow runs view`, `workflow job run` |
| R5 | `mind`: `rag-index`, `rag-query`, `sync-add`, `sync-update`, `sync-delete`, `sync-list`, `sync-status` | `mind index update`, `mind search`, `mind sync add`, `mind sync list` |
| R6 | `clickup`: `comment-list`, `comment-add` | `clickup task comments list`, `clickup task comments add` |
| R7 | `registry` system command | Keep `kb diag` top-level; assess registry command separately |

### 🟢 Nice to have

| # | What | Options |
|---|---|---|
| R8 | `devlink` opaque name | `deps`, `link` |
| R9 | `impact` understated | `affected`, `diff` |

---

## 4. Automated Checks (implemented)

### check-cli-naming (devkit custom check)

- File: `scripts/checks/check-cli-naming.mjs`
- Format: TypedCheckOutput v2 — `{ issues: [{ check, severity, message, file, fix }] }`
- Three rules: no top-level hyphen, no reserved namespace, no kebab in sub-segments
- `devkit.yaml` → `custom_checks`, `on: [check]`, `categories: [plugin-entry]`
- Run: `kb-devkit check --only=cli-naming`

### ai-review preset

- Preset: `.kb/ai-review/presets/cli-manifest.json` — targets `**/manifest*.ts`
- Rule: `.kb/ai-review/rules/cli/namespace-conventions.md`
- Run: `kb review run --preset=cli-manifest`

---

## 5. Command Archetypes

Every command belongs to one archetype. The archetype determines the standard flag set.

| Archetype | Description | Standard flags |
|---|---|---|
| **Read** | Reads data, no side effects | `--output`, `--limit`, `--offset` |
| **Mutate** | Changes state | `--dry-run`, `--yes`, `--output` |
| **Execute** | Starts a process / long-running job | `--wait`, `--watch`, `--timeout`, `--yes` |
| **Analyze** | Read-only analysis, may take time | `--output`, `--format`, `--stream` |

Declared in manifest:

```ts
operationType: 'read' | 'mutate' | 'execute' | 'analyze'
```

---

## 6. Standard Flags (shared-command-kit)

These flags are identical across all KB Labs plugins:

```
--output=json|table|csv    // output format
--yes / --no-interactive   // skip confirmation prompts
--dry-run                  // show what would happen (Mutate only)
--wait                     // block until completion (Execute only)
--watch                    // stream events as NDJSON (Execute only)
--timeout=<duration>       // max wait time
--schema                   // JSON Schema of this command (for agents / MCP)
```

**Hard rule:** data → stdout, everything else (progress, status, warnings) → stderr. Never mix.

---

## 7. Human vs Agent Interface

### Same data, two renderers

The command returns structured data. The presentation layer decides how to render it:

- TTY without `--output` → colored table for humans
- `--output=json` → clean JSON for agents / pipes
- `--output=csv` → for import

The handler never decides how to render. It returns typed data. The platform renders.

### Manifest as single source of truth

One manifest → three consumers:

| Consumer | What it gets |
|---|---|
| `--help` | Human-readable output (already exists) |
| `--schema` | JSON Schema — auto-generated from manifest flags |
| MCP tool definitions | Auto-generated from the same manifest |

Additional fields needed in `CliCommandDecl`:

```ts
enum?: string[]           // allowed values for a flag (e.g. ['json', 'table', 'csv'])
operationType?: 'read' | 'mutate' | 'execute' | 'analyze'
examples?: Array<{        // structured examples, not plain strings
  description: string
  flags: Record<string, unknown>
  args?: string[]
}>
```

### What agents specifically need

1. `--output=json` — stable, versioned contract
2. Predictable exit codes — 0=ok, 1=user error, 2=system error, 3=not found, 4=timeout
3. No interactive prompts — `--yes` or auto-detect TTY
4. `--dry-run` → machine-readable plan: `{ "would_do": [...] }`
5. Idempotency + `--if-exists=skip|update|error` on create commands
6. Machine-readable errors: `{ "error": { "code": "DAEMON_UNREACHABLE", "message": "...", "details": {} } }`
7. `--wait` / `--watch` for async operations — no need to implement polling externally
8. `--id` everywhere alongside `--name` — stable references that survive renames
9. `--schema` — so agents can validate calls before executing them

---

## 8. Systemic Enforcement Model

> The system itself must enforce conventions — not humans, not agents remembering rules.

### The problem

Checking that a flag is declared in the manifest: easy.
Checking that the handler actually uses it correctly: hard.

How do you know a `Mutate` command handler didn't forget to implement `--dry-run`?

### Solution: intent / execute split

Instead of one `run()` method, every non-Read command exposes two:

```ts
interface ReadCommand<F extends Flags> {
  run(input: CLIInput<F & CommonReadFlags>): Promise<ReadResult>
}

interface MutateCommand<F extends Flags> {
  // Returns what would happen. Read-only, no side effects.
  intent(input: CLIInput<F>): Promise<MutateIntent>
  // Actually performs the mutation.
  execute(input: CLIInput<F>): Promise<MutateResult>
}

interface ExecuteCommand<F extends Flags> {
  // Returns task description and estimate.
  intent(input: CLIInput<F>): Promise<ExecuteIntent>
  // Starts the job. Platform wraps --wait / --watch.
  execute(input: CLIInput<F>): Promise<ExecutionHandle>
}

// MutateIntent shape:
interface MutateIntent {
  summary: string
  operations: Array<{ type: 'create' | 'update' | 'delete'; resource: string; details?: unknown }>
}
```

**Platform routing (invisible to handler author):**
- `--dry-run` → calls `intent()`, renders the plan, never calls `execute()`
- `--wait` → calls `execute()`, subscribes to `ExecutionHandle`, waits for completion
- `--output=json` → intercepts stdout and formats as JSON
- `--schema` → generated from manifest, handler never involved

**What this gives:**

1. TypeScript won't compile a `MutateCommand` without `intent()` — compile-time enforcement
2. Handler author can't forget dry-run — the interface requires it structurally
3. Platform handles `--dry-run` entirely — author only describes the intent, not the flag
4. `intent()` doubles as pre-flight validation — runs before `execute()` even in normal mode

### Enforcement layers

| Layer | What it checks | When |
|---|---|---|
| **TypeScript** | Interface compliance (intent/execute methods present) | At compile time |
| **devkit check** | Command naming (check-cli-naming) | On `kb-devkit check` |
| **ai-review** | Manifest conventions | On code review |
| **Runtime** | Flag schema validation | On command invocation |
| **Platform middleware** | Automatic flags (--dry-run, --wait, --output) | On command execution |

The handler author writes domain logic only. The system enforces everything else.

---

## Open Questions

1. Final name for `infra-worker` — `infra`, `env`, or `provision`?
2. `quality` kebab subcommands — restructure as subgroups, or rename to single verbs?
3. `devlink` and `impact` — rename or leave?
4. `qa` vs `quality` — document the boundary explicitly, or merge?
5. When to remove `KNOWN_VIOLATIONS` from check-cli-naming and fix violations in manifests?
