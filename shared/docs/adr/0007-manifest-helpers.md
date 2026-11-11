# ADR-0007: Manifest Helpers for Plugin Authors

**Date:** 2026-05-19
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-19
**Tags:** [dx, manifest, plugins, cli, typescript]

## Context

Plugin manifests in `plugins/*/src/manifest.ts` are large literal TypeScript objects
(200–500 lines). Two sections account for the majority of the verbosity:

**CLI commands** — each declaration requires 8–10 lines due to:
- `operationType: 'read' as const` — TypeScript requires `as const` to narrow the union type
- `flags: defineCommandFlags(flagsDef)` — wrapper call repeated for every command
- `category: 'Daemon'` — repeated on every command within the same logical group
- `groupMeta` — maintained as a separate array, disconnected from the commands

```ts
// Before: 9 lines per command
{
  path: 'workflow health',
  category: 'Daemon',
  operationType: 'read' as const,
  describe: 'Check workflow daemon health status.',
  longDescription: 'Performs a health check on the workflow daemon...',
  handler: './commands/health.js#default',
  flags: defineCommandFlags(healthFlags),
  examples: ['kb workflow health', 'kb workflow health --json'],
},
```

**REST routes** — each route requires 4–6 lines due to `method: 'GET'` being explicit in the
object, alongside `path`, `handler`, and optional metadata.

Additionally, there is no compile-time validation on the plugin `id` format (`@scope/name`)
or `version` (semver), and handler paths (`./dist/cmd.js`) are plain strings with no type
constraint — typos like `'dist/cmd.js'` (missing `./`) produce runtime errors rather than
compile errors.

## Decision

Add a small set of **optional, additive helper functions** to `@kb-labs/shared-command-kit`
and re-export them from `@kb-labs/sdk`. The plain-literal style remains fully valid; these
helpers exist purely to reduce boilerplate where authors choose to use them.

Four components:

### 1. `cmd()` + `CmdBuilder` (Commander.js-inspired)

```ts
cmd('workflow health', './commands/health.js#default', 'Check daemon health.')
  .read()          // operationType, no as const
  .flags(healthFlags)  // calls defineCommandFlags internally
  .examples(['kb workflow health'])
```

Eliminates: `as const`, wrapper call, and implicit `undefined` for unused fields.

### 2. `group()` + `mergeCliGroups()`

Groups commands under a shared `groupMeta` entry. If `category` is provided, it is applied
to any command inside that does not already have its own category set. Multiple groups are
combined with `mergeCliGroups()`.

```ts
const runsGroup = group({ path: 'workflow runs', describe: 'Run management', category: 'Runs' }, [
  cmd('workflow runs list', './commands/runs-list.js#default', 'List runs.').read().flags(runsListFlags),
  cmd('workflow runs view', './commands/runs-view.js#default', 'View run details.').read().flags(runsViewFlags),
]);

cli: mergeCliGroups(daemonGroup, jobsGroup, runsGroup),
```

### 3. `GET/POST/PUT/PATCH/DELETE()` (Hono-inspired)

Standalone functions that inject the `method` field, reducing a 5-line object to one line:

```ts
GET(ROUTES.STATS, './rest/stats.js#default', { describe: 'Dashboard stats', output: { zod: '...' } }),
```

### 4. `createManifest(id, version, body)` (Vite `defineConfig`-inspired)

Thin wrapper that auto-injects `schema: 'kb.plugin/3'` and provides branded-type validation
on `id` (`@${string}/${string}`) and `version` (`${number}.${number}.${number}${string}`).

```ts
export type PluginId = `@${string}/${string}`;
export type SemVer   = `${number}.${number}.${number}${string}`;
export type HandlerRef = `./${string}.js` | `./${string}.js#${string}`;
```

### Impact on workflow manifest

The workflow plugin manifest (`services/workflow/entry/src/manifest.ts`) shrinks from
~515 lines to ~220 lines (~57% reduction) using these helpers.

## Consequences

### Positive

- `as const` workaround is gone; `.read()/.mutate()/.execute()/.analyze()` narrow the type natively
- `defineCommandFlags()` is no longer called manually at every command site
- `groupMeta` and `category` are colocated with the commands they describe
- Compile-time errors on malformed plugin IDs, versions, and handler paths
- Zero runtime overhead: `build()` returns a plain `CliCommandDecl`; tree-shaking removes
  builder code from plugin bundles

### Negative

- Two styles now coexist (literal objects and builder helpers); plugin authors must learn
  which style to use when
- `CmdBuilder` instances must call `.build()` when used outside of `group()`; forgetting
  `.build()` produces a type error since `CliCommandDecl` ≠ `CmdBuilder`

### Alternatives Considered

**Full fluent ManifestBuilder** (e.g., `createManifest().display().cli().rest().build()`) —
rejected as overengineering. Analysis of tRPC, Vite, Fastify, and Hono showed that wrapping
the _entire_ config structure in a fluent chain is not a recognized pattern in the ecosystem.
Structural sections (WS, Studio, lifecycle) are already readable as plain objects.

**No change** — rejected. The `as const` workaround and per-command `defineCommandFlags` call
are genuine friction points that affect every plugin author.

## Implementation

- New file: `shared/command-kit/src/manifest-builder.ts`
- Export added to `shared/command-kit/src/index.ts`
- Re-exported from `sdk/sdk/src/manifest/index.ts`
- Tests: `shared/command-kit/src/__tests__/manifest-builder.test.ts`

## References

- [Commander.js](https://github.com/tj/commander.js/) — fluent CLI command builder pattern
- [Hono routing](https://hono.dev/docs/api/routing) — HTTP method helper functions
- [Vite `defineConfig`](https://vite.dev/config/) — thin type-safe config wrapper

---

**Last Updated:** 2026-05-19
**Next Review:** —
