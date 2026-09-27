# ADR-0012: Platform / Project Scope for Config, Marketplace, and Discovery

**Date:** 2026-04-14
**Status:** Accepted (updated 2026-04-28 — collision policy reversed to project wins)
**Deciders:** KB Labs Team
**Tags:** [architecture, marketplace, discovery]

## Context

KB Labs has two logically distinct workspace roots that matter at runtime:

- **Platform root** — where the platform itself is installed (globally shared
  adapters, global plugins, shared API keys, `node_modules/@kb-labs/*`). In
  dev it's the monorepo root; in installed mode it's `~/kb-platform` (or
  whatever `platform.dir` / `KB_PLATFORM_ROOT` points to).
- **Project root** — the user's project directory, where `.kb/kb.config.*`,
  project-specific plugins, and the project's `marketplace.lock` live.

Before this decision the boundary was blurred:

1. `kb marketplace plugins link ./.kb/plugins/demo/...` from a user project
   **failed** — `MarketplaceService.link()` checked that the path was inside
   `this.root`, which was hard-coded to the platform root at daemon boot.
2. Config loading already read both `<platformRoot>/.kb/kb.config.*` and
   `<projectRoot>/.kb/kb.config.*` and deep-merged them, but there were no
   rules about *which* fields a project was allowed to override. Arrays
   concatenated instead of replacing, which was surprising for allow/block
   lists.
3. `cli/runtime/src/v3/execute-command.ts` resolved plugin modules through
   `require.resolve(pluginId, { paths: [process.cwd()] })`. Project-scope
   plugins whose deps live at `<projectRoot>/.kb/plugins/<name>/node_modules/`
   were invisible to the resolver.
4. The CLI discovery cache (`.kb/cache/cli-manifests.json`) hashed a single
   marketplace lock and couldn't represent a project lock separately
   (removed together with the CLI scanner in task 7.6).

Ad-hoc patches (pass `platformRoot` to one path, `KB_PLATFORM_ROOT` to
another) were already accumulating. We needed a coherent model.

## Decision

Model `platform` and `project` as **first-class scopes** across config,
marketplace, discovery, and runtime. Every code path that touches a lock, a
config field, or a manifest knows which scope it's acting in.

### 1. Scope resolution

- **Platform root**: `KB_PLATFORM_ROOT` → `platform.dir` in the project
  config → `findPlatformMarkerRoot` walk-up → `findRepoRoot` fallback.
- **Project root**: `KB_PROJECT_ROOT` → walk up from `cwd` looking for
  `.kb/kb.config.{jsonc,json}` (`findProjectConfigRoot`) → fallback to cwd.
- In monorepo dev mode both typically resolve to the same directory
  (`sameLocation: true`). Code paths that care about scope treat this case
  as platform (the single config file plays both roles).

Helpers live in `@kb-labs/core-workspace`:
- `findPlatformMarkerRoot(startDir)` and `findProjectConfigRoot(startDir)`
  are exported as low-level walk-up functions. They are the single source
  of truth for "is this a project / a platform install?" — CLI, discovery,
  marketplace CLI helpers, and the config loader all use them.

### 2. Config (`kb.config.jsonc`) — field-policy merge

Config fields are typed by scope policy. `core/runtime/src/config.ts`
declares `CONFIG_FIELD_SCOPE`:

```
platform         → project-only   (project declares the platform dir)
adapters         → mergeable      (deep-merge, project wins)
adapterOptions   → mergeable      (deep-merge, project wins)
core             → platform-only  (project cannot override)
execution        → platform-only  (project cannot override)
```

Unlisted fields default to `mergeable` (deep-merge, project overrides).

`mergeWithFieldPolicy<T>()` in `@kb-labs/core-config` performs the merge and
returns provenance:

```ts
{
  value: T,
  ignoredProjectFields: string[],   // e.g. ['adapters'] when project tried
  sources: Record<string, 'platform' | 'project' | 'both'>,
}
```

`loadPlatformConfig` uses this and exposes `sources.fields`,
`sources.ignoredProjectFields`, and `sources.platformDirOverride` on its
result.

**`platform.dir` re-resolve:** when the project config sets
`platform.dir`, the loader re-resolves `platformRoot` and re-reads the
platform config from that location. Self-reference (project pointing at
itself) is ignored.

### 3. Marketplace — two locks, explicit scope

Each scope has an independent `.kb/marketplace.lock` (schema
`kb.marketplace/2`, unchanged). `resolvedPath` remains relative to the
scope root — locks stay portable.

- **`MarketplaceServiceOptions`** takes `platformRoot` (required) +
  `projectRoot?` (optional at construction — a daemon serving many projects
  passes `ctx.projectRoot` per call).
- **All mutating methods require `ScopeContext` explicitly.** No default —
  an unbound call fails at the type level. This prevents the class of bug
  where a project-scope operation silently lands in the platform lock.
- **Queries accept `QueryScopeContext`** (`scope: 'platform' | 'project' | 'all'`).
  `list` always returns `ScopedMarketplaceEntry[]` — every entry carries
  the scope it came from.
- **Collision policy (cross-scope):** **project wins + diagnostic.**
  The project is the user's override layer — workspace packages and
  project-local plugins take precedence over the installed platform.
  Diagnostics surface back to CLI/API so the override is observable.
- **Adapters are platform-only.** `link`/`install` in project scope with
  `primaryKind === 'adapter'` throws `AdapterScopeError`. Enforced once,
  centrally, in `MarketplaceService.assertScopeAllowsKind` — not duplicated
  across strategies.
- **`sync` is scope-bound.** Globs resolve against the scope root; adapter
  entries are silently skipped in project scope.
- **Daemon stays single & stateless per project:** one daemon lives in the
  platform. `projectRoot` is passed in every request body/query. Locks are
  always re-read (small files; no per-project caching).

### 4. API shape

Every mutating route takes `{ scope, projectRoot? }` in its body;
`GET /packages` and `GET /diagnostics` accept the same pair in query.
Server-side default is `platform` (back-compat for scripted callers).
A single `ScopeRequestError` hierarchy maps scope errors to `400` with a
stable `code`:

- `SCOPE_INVALID`
- `SCOPE_PROJECT_ROOT_REQUIRED`
- `SCOPE_PROJECT_ROOT_NOT_ABSOLUTE`
- `SCOPE_PROJECT_ROOT_TRAVERSAL`
- `SCOPE_PROJECT_ROOT_NOT_FOUND`
- `SCOPE_PROJECT_ROOT_NO_KB_DIR`
- `SCOPE_PROJECT_EQUALS_PLATFORM`
- `MARKETPLACE_ADAPTER_PROJECT_SCOPE`

### 5. CLI UX

Every marketplace command accepts `--scope <platform|project>` (`list` also
allows `all`). Without the flag, the scope is **auto-detected**: if cwd or
any ancestor contains `.kb/kb.config.*` that isn't the platform config,
default is `project`; otherwise `platform`.

`list --scope all` merges both locks and adds a `[platform]` / `[project]`
tag to each row.

### 6. Discovery

> Amended by task 7.6 (ADR-0048, `docs/architecture/target/14-discovery-unification.md`):
> the CLI-only scanner (`discoverWorkspace`, `discoverNodeModules`,
> `discoverProjectLocalPlugins`, `discoverCurrentPackage`, `deduplicateManifests`)
> and its cache are gone. There is one pipeline, `core-discovery`
> (`DiscoveryManager`); the CLI only adapts its result.

Every discovered plugin carries `scope: 'platform' | 'project'` and an
`origin` (`workspace` | `linked` | `node_modules`):

- Lock entries of `<platformRoot>/.kb/marketplace.lock` → `scope: 'platform'`;
  of `<projectRoot>/.kb/marketplace.lock` → `scope: 'project'`. A lock entry
  with `source: 'local'` is `linked`, one with `source: 'marketplace'` is
  `node_modules`.
- pnpm workspace packages under a scope root that declare `kb.manifest` are
  `workspace` (monorepo development). A root without `pnpm-workspace.yaml`
  contributes only its own package.
- With a single root (`platformRoot` unset or equal to the project root) every
  entry is reported as `platform`.

**Shadowing** is by plugin id: a project-scope plugin beats a platform-scope one;
inside one scope `workspace` > `linked` > `node_modules`. The CLI registry then
applies the same source priority per command path when two different plugins
claim one path.

### 7. Runtime — module resolution

`ExecuteCommandV3Options` gained `pluginRoot?: string`. When the caller
knows where the plugin lives (the CLI always does — discovery returns
`pkgRoot`), it passes the absolute path. The execution backend searches
the plugin's own `node_modules` from that root. All existing backends
(in-process, worker-pool, subprocess, remote) already honored
`request.pluginRoot`; the fix was strictly on the CLI path.

Fallback resolver (`resolvePluginRoot`) is narrowed to
`require.resolve(pluginId, { paths: [searchFrom] })` — used only when
`pluginRoot` is absent.

### 8. State & cache — explicitly NOT split

- The CLI discovery cache `.kb/cache/cli-manifests.json` no longer exists
  (task 7.6): discovery reads the build-emitted static `dist/manifest.json`,
  which is as cheap as the cache was.
- `.kb/plugins.json` (enable/disable state) remains per-project as before.
- `.kb/lock.json`, `database/`, `logs/`, `analytics/` unchanged.

Adding a new state file? Default is "one file, scope field on each record."
Split only when concurrent writers in both scopes are a real concern.

## Consequences

### Positive

- **No silent cross-scope pollution.** Mandatory `ScopeContext` + stable
  error codes mean a project-scope operation can never accidentally land
  in platform (or vice versa). The type system enforces it.
- **Project plugins work in installed mode.** The original task's end-to-end
  flow (`kb scaffold plugin demo` → `kb marketplace plugins link` → `kb demo
  hello`) works because (a) link accepts project paths, (b) discovery picks
  up `.kb/plugins/` independently, (c) module resolution honors pkgRoot.
- **Provenance is observable.** `sources.fields`, `sources.ignoredProjectFields`,
  `DISCOVERY_SCOPE_COLLISION` and `MarketplaceDiagnostic` make the model
  debuggable — users can see why a field/plugin took the value it did.
- **One scope helper, one policy.** `findProjectConfigRoot` and
  `findPlatformMarkerRoot` are the single source of truth across config
  loader, CLI scope-resolver, marketplace scope-resolver, and discovery.

### Negative (accepted)

- **Breaking config behavior (original):** projects that used to override
  `adapters` got `ignoredProjectFields: ['adapters']`. Resolved in
  2026-04-28 update: `adapters` and `adapterOptions` changed to
  `mergeable`, so project adapters config now deep-merges and wins.
- **Breaking API surface:** `MarketplaceService.*` signatures changed
  (explicit `ctx`). All in-tree callers updated. External callers must
  migrate — this is on purpose (see "no silent default" above).
- **Strategy hooks gained `ctx`:** `afterInstall` / `beforeUninstall` now
  receive a `ScopeContext`. Built-in strategies updated. External
  strategies (if any) must add the parameter.

### Neutral

- Adapter-in-project-scope is rejected as a hard error. This is a
  deliberate boundary: adapters are infra concerns (credentials, shared
  resources) and do not make sense per-project. If that assumption ever
  changes, introducing project-scope adapters is additive — we add
  `platform+project` policy to the field and relax the guard.

## Implementation

Delivered across 8 steps:

1. `core/runtime/src/config.ts` — `PlatformDirConfig`, `CONFIG_FIELD_SCOPE`.
2. `core/config/src/runtime/runtime.ts` — `mergeWithFieldPolicy<T>()`.
3. `core/runtime/src/config-loader.ts` — policy-merge, `platform.dir`
   re-resolve, per-field provenance.
4. `core/workspace/src/workspace/root-resolver.ts` — export
   `findProjectConfigRoot`, `findPlatformMarkerRoot`; fix walk-up to
   accept both `kb.config.json` and `kb.config.jsonc`.
5. `plugins/marketplace/contracts/src/types.ts` — `MarketplaceScope`,
   `ScopeContext`, `QueryScopeContext`, `ScopedMarketplaceEntry`,
   `MarketplaceDiagnostic`.
6. `plugins/marketplace/core/src/scope.ts` — `resolveScopeRoot`,
   `resolveQueryRoots`, `ScopeResolutionError`.
7. `plugins/marketplace/core/src/marketplace-service.ts` — scope-bound
   API, `assertScopeAllowsKind`, `mergeScopedEntries`.
8. `plugins/marketplace/api/src/scope-parser.ts` + routes — body/query
   parsing, shared `ScopeRequestError`, global Fastify error handler.
9. `plugins/marketplace/entry/src/scope.ts` — CLI `resolveCliScope`,
   `scopeBody()` helper. All commands (`link`, `unlink`, `list`, `install`,
   `uninstall`, `update`, `sync`, `enable`, `disable`, `doctor`) updated.
10. `cli/commands/src/registry/{types,discover}.ts` —
    `DiscoveryResult.scope`, both-lock tracking, dual `platformRoot` /
    `projectRoot` in cache header, `discoverProjectLocalPlugins`, dedup
    policy.
11. `cli/runtime/src/v3/execute-command.ts` + `cli/bin/src/runtime/plugin-executor.ts`
    — honor caller-supplied `pluginRoot`.
12. `cli/bin/src/runtime/bootstrap.ts` + `cli/commands/src/utils/register.ts`
    — thread `projectRoot` end-to-end.

## Verification

End-to-end manual script:

```bash
rm -rf /tmp/plugin-scope-test
mkdir -p /tmp/plugin-scope-test && cd /tmp/plugin-scope-test
git init && git commit --allow-empty -m init
kb-create --yes .
kb scaffold run plugin demo --yes --mode standalone
cd .kb/plugins/demo && pnpm install && pnpm build && cd -

# Link under project scope (default, because cwd has .kb/kb.config.*)
kb marketplace plugins link ./.kb/plugins/demo/packages/demo-entry
# Writes /tmp/plugin-scope-test/.kb/marketplace.lock, NOT platform lock.

kb marketplace plugins list                   # project
kb marketplace plugins list --scope platform  # demo absent
kb marketplace plugins list --scope all       # demo with [project] tag

kb demo hello                                 # executes — pkgRoot honored
kb marketplace plugins unlink demo-entry --scope project  # platform lock intact

# Adapter guard
kb marketplace install some-adapter --scope project
#   → Error: Adapters can only be installed in platform scope.
```

Automated coverage:
- `core/config` runtime tests (mergeWithFieldPolicy paths).
- `core/runtime` config-loader tests (policy enforcement, platform.dir).
- `core/workspace` root-resolver tests (walk-up both filenames).
- `plugins/marketplace/core` — 41 service tests (scope-bound variants).
- `cli/commands` — 99 tests (scope-aware discover/cache/dedup).
- `cli/bin` — 98 tests (bootstrap threading).
