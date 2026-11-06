# CLI Namespace & Naming Audit

> Working document. Goal: establish consistent naming rules and a concrete refactoring list
> before external plugin authors appear.

---

## Current Command Surface

### System commands (built into CLI, always present)

| Namespace  | Subcommands                                                    | What it actually does              |
|------------|----------------------------------------------------------------|------------------------------------|
| `auth`     | login, logout, status, register                  | Gateway authentication             |
| `platform` | sync                                                           | Platform lifecycle / provisioning  |
| `info`     | hello, version, health, diag                                   | Platform health & version info     |
| `logs`     | diagnose, context, summarize, query, search, get, stats        | Platform log access & analysis     |
| `marketplace` | install, uninstall, update, sync, plugins:add/remove/list/enable/disable/doctor | Built-in plugin and adapter management |
| `docs`     | generate-cli-reference                                         | Generate CLI reference docs        |
| `registry` | diagnostics                                                    | Entity registry diagnostics (1 cmd)|
| `completion`| install, bash, zsh, fish                                      | Shell tab completion setup         |

### Plugin commands (optional, discovered at startup)

| Namespace         | Package                           | Subcommands (flat list)                                                                                        | Domain |
|-------------------|-----------------------------------|----------------------------------------------------------------------------------------------------------------|--------|
| `agent`           | @kb-labs/agents              | run · history · diff · rollback · trace:stats/filter/iteration/context/diagnose · quality:report              | AI agents |
| `clickup`         | @kb-labs/clickup            | workspace · task:search/get/create/update/delete/comment-list/comment-add · space:create/update/delete · folder:create/update/delete · list:create/update/delete/tasks/statuses | External integration |
| `commit`          | @kb-labs/commit             | generate · apply · push · open · reset                                                                         | AI-powered commits |
| `devlink`         | @kb-labs/devlink            | switch · status · plan · freeze · undo · backups                                                               | Cross-repo dep linking |
| `workspace`       | built-in workspace command group         | register · status · list                                                                                       | Remote workspace agents |
| `infra-worker`    | @kb-labs/infra-worker        | prepare · capture-snapshot · restore-snapshot                                                                  | Environment provisioning |
| `hub`             | @kb-labs/marketplace-registry | publish · share · yank · deprecate                                                                             | Plugin publishing (author tools) |
| `mind`            | @kb-labs/mind               | init · verify · rag-index · rag-query · sync:add/update/delete/list/status                                    | RAG / semantic code search |
| `qa`              | @kb-labs/qa                 | run · check · stats · gate · history · trends · regressions · baseline:update/status/diff                     | Build/test quality metrics |
| `quality`         | @kb-labs/quality            | stats · health · snapshot · history · context · gate · check-layers · coupling · build-order · cycles · dead-code · check-types · check-builds · check-tests · fix-deps · visualize | Architecture analysis |
| `release`         | @kb-labs/release      | plan · run · publish · rollback · report · changelog · verify · checks · build · pack · version · git         | Release pipeline |
| `review`          | @kb-labs/review             | run                                                                                                            | AI code review |
| `scaffold`        | @kb-labs/scaffold                 | run · doctor                                                                                                   | Entity scaffolding |
| `workflow`        | @kb-labs/workflow-entry           | health · metrics · job status/logs/run · run · runs:list/view/watch/rerun                                      | Workflow engine |

---

## Problems Found

### P1 — Resolved: Marketplace management is a built-in command group

Plugin installation and management are registered by the platform's built-in
CLI command groups. Publisher commands remain under the `hub` group supplied by
`@kb-labs/marketplace-registry`.

The separate command groups serve different audiences:
- `marketplace install/plugins/*` → **user** managing their plugin environment
- `hub publish/share/yank/deprecate` → **plugin author** publishing to KB Labs Hub

### P2 — `quality` vs `qa`: two plugins, blurry boundary

`qa` measures build/test health via devkit metrics (run results, baselines, gates, regressions).
`quality` does deep architecture analysis (coupling, cycles, dead-code, layer violations).

They share concepts (`gate`, `stats`, `history`) but are genuinely different domains.
Without explicit naming, users can't tell which to reach for.

### P3 — `registry` (system) occupies a confusing name

One command (`registry diagnostics`) sits under a name that every developer reads as
"plugin registry". The actual content is entity registry diagnostics — platform internals.
This is a bad tradeoff: one rarely-used internal command takes a prime namespace.

### P4 — `infra-worker`: architecture leaks into the CLI

`infra-worker` exposes the internal "worker" concept. Users care about what it does
(provision environments, capture snapshots), not how it's built. The name also
uses kebab-case at top level, inconsistent with everything else.

### P5 — kebab-case in subcommand paths

Several commands break word-boundary convention inside paths:
- `quality check-layers`, `quality fix-deps`, `quality dead-code`, `quality check-types`, `quality check-builds`, `quality check-tests`
- `infra-worker capture-snapshot`, `infra-worker restore-snapshot`
- `workflow job run`, `workflow runs list`, `workflow runs view`, `workflow runs watch`, `workflow runs rerun`
- `clickup task comment-list`, `clickup task comment-add`
- `mind rag-index`, `mind rag-query`, `mind sync-add`, `mind sync-update`, `mind sync-delete`, `mind sync-list`, `mind sync-status`

All of these should be proper subgroups (`quality check layers run`).

### P6 — Mixed noun/verb pattern at top level

Top-level namespaces inconsistently use nouns and verbs:

| Pattern | Examples |
|---------|---------|
| Noun (domain/resource) | `marketplace`, `workflow`, `agent`, `quality`, `mind` |
| Verb (action) | `commit`, `review`, `release`, `scaffold` |

Verb-first names like `commit` and `review` are fine as standalone commands,
but they create a naming heuristic mismatch: is `commit` the object being managed,
or the action being taken?

### P7 — `devlink`: opaque name

`devlink` means "development link" (local dependency linking). Not guessable from the name.
The verb ambiguity of the old `devlink switch` is resolved (`devlink mode set`); the
namespace itself is still not guessable: users familiar with `npm link` / `pnpm link` might get it,
but it's not obvious.

### P8 — `mind`: opaque name

"Mind" is the internal product name for the RAG/vector-search subsystem. From a user's
perspective: `kb mind rag-query` is doubly opaque — both the namespace and the subcommand
expose internal terminology. Users want "search my codebase".

### P9 — `workspace` shares top level with host-agent internals

`host-agent` registers both `workspace /*` and `agent /*` (register, status) — the `agent`
subpath overlaps with the `agent` plugin's namespace. Currently works because they're different
subcommands, but fragile.

---

## Proposed Naming Rules

These rules emerged from the audit above. Proposed as a consistent convention for all
current and future CLI namespaces.

### Rule 1 — Top-level is always a noun (domain / resource)

The top level names a **domain** the user is working in, not an action.

```
✓  agent      (the AI agent system)
✓  workflow   (workflows)
✓  marketplace (plugin store)
✗  commit     (is this the object or the verb?)
✗  review     (verb or noun?)
```

Standalone action-heavy commands (`commit`, `review`) are acceptable exceptions
if the domain IS the verb concept — but they should be documented as exceptions,
not a pattern.

### Rule 2 — Second level is a verb from a standard vocabulary

No invented verbs. The closed vocabulary (this audit's draft table won the review in
`docs/architecture/target/06-command-naming.md` section 2 and was amended there — `yank`,
`deprecate`, `share` and friends did not survive) is maintained in that document and enforced
by `scripts/checks/check-manifest-command-naming.mjs` (`VERBS`).

### Rule 3 — No kebab-case in command paths

Use subgroups instead:
```
✗  quality check-layers
✓  quality check layers run     (4-part path: ns → check → layers → run)

✗  workflow runs-list
✓  workflow runs list

✗  mind rag-query
✓  mind search              (rename to something clear)
```

### Rule 4 — No implementation details in names

```
✗  infra-worker    (internal architecture)
✗  mind rag-query  (RAG is internal term)
✓  infra           or  env  or  provision
✓  mind search     or  search
```

### Rule 5 — One package = one top-level namespace (ADR-0018)

Already enforced. Documented here for plugin authors.

### Rule 6 — Reserved platform namespaces are explicit

The following top-level names are reserved by the platform and cannot be used by plugins:

```ts
// cli/commands/src/registry/service.ts
const RESERVED_NAMESPACES = new Set([
  // Platform internals
  '__complete', '__internal',
  // System command groups (registered at startup, always present)
  'auth', 'platform', 'info', 'logs', 'docs', 'registry', 'completion',
]);
```

---

## Refactoring Candidates

Ordered by impact and effort.

### 🔴 Must fix (broken today)

| # | What | Problem | Proposed fix |
|---|------|---------|--------------|
| R1 | `marketplace-registry-entry` blocked | P1: namespace collision | ✅ Fixed — moved to `hub` top-level group |
| R2 | `infra-worker` kebab at top level | P4 + P5 | Rename namespace |

### 🟡 Should fix (confusing for users and future authors)

| # | What | Problem | Proposed fix |
|---|------|---------|--------------|
| R3 | `registry` (system) | P3: prime name for 1 internal cmd | Keep top-level diagnostics at `kb diag`; assess registry command separately |
| R4 | `quality` kebab subcommands | P5 | Restructure as proper subgroups |
| R5 | `workflow` kebab subcommands (`runs-list` etc.) | P5 | `workflow runs list/view/watch/rerun` |
| R6 | `mind` subcommand names (`rag-index`, `rag-query`, `sync-add`) | P5 + P8 | `mind index update`, `mind search`, `mind sync add` |
| R7 | `clickup` kebab (`comment-list`, `comment-add`) | P5 | `clickup task comments list/add` |
| R8 | `quality` vs `qa` boundary | P2 | Document the boundary explicitly (or merge) |

### 🟢 Nice to have (polish)

| # | What | Problem | Proposed fix |
|---|------|---------|--------------|
| R9  | `devlink` opaque name | P7 | Consider `deps` or `link` |
| R10 | `mind` opaque name | P8 | Consider `search` or `rag` |
| R12 | `infra-worker` subcommand names (`capture-snapshot`) | P5 | `infra snapshot create/rollback` |

---

## Open Questions

**Q1: Where do `marketplace-registry` commands go?**
Options discussed:
- `hub publish`, `hub version remove` — "KB Labs Hub" for authors
- `publish plugin`, `publish yank` — verb-first group for publishing actions
- Keep under `marketplace` via explicit namespace sharing (requires Rule 5 exception mechanism)

**Q2: Merge `quality` and `qa`, or keep separate with clear docs?**
`qa` = devkit-based build/test metrics (CI-friendly)
`quality` = architecture analysis (ad-hoc / dev-time)
These could be subgroups of a single `quality` namespace if ownership is resolved.

**Q3: Should `commit`, `review`, `release`, `scaffold` stay verb-first?**
They're natural language commands developers would type. The counter-argument is
consistency with Rule 1. No right answer — needs a decision.

**Q4: `workspace` from host-agent — is this the right name?**
"Workspace" = a connected remote machine running the workspace agent.
`kb workspace register`, `kb workspace list` — fine. But it could conflict with
any future "workspace management" concept (like a monorepo workspace).
