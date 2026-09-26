# 14. One discovery pipeline (task 7.6)

Status: implemented in `feat/unified-discovery`. Context: ADR-0048 finding F1, ADR-0012 §6.

## 1. Before: two pipelines

### (a) Lock pipeline, `core/discovery` `DiscoveryManager`

| | |
|---|---|
| Consumers | `EntityRegistry` (`core/registry`), REST bootstrap, marketplace tests. Adapters read locks themselves (`core/runtime/src/discover-adapters.ts`) and never used it. |
| Inputs | `<platformRoot>/.kb/marketplace.lock` and `<root>/.kb/marketplace.lock`; project wins per lock key. Nothing is scanned. |
| Finds | Only lock entries (installed, linked, `enabled !== false`). |
| Manifest | `import()` of `dist/manifest.js` (via `package.json` `kb.manifest`), else `kb.plugin.json`, else `dist/index.js`. |
| Checks | Package dir exists; SRI integrity of `package.json` for non-`local` entries; duplicate manifest id is skipped with a warning. |
| Output | `DiscoveryResult { plugins: DiscoveredPlugin[], manifests: Map<id, ManifestV3>, diagnostics }`. No scope, no origin. |

### (b) CLI pipeline, `cli/commands/src/registry/discover.ts` (1565 lines)

| | |
|---|---|
| Consumers | `registerBuiltinCommands` (every `kb` run), `kb diag`. |
| Inputs | `pnpm-workspace.yaml` globs of `platformRoot` (and of `projectRoot` when different); current package when there is no workspace file; `<platformRoot>/node_modules` (scoped and unscoped); `<projectRoot>/.kb/plugins/*/packages/*-entry`; `plugins.allow/block/linked` from `kb.config.json`. The marketplace lock was read only to hash it for cache invalidation. |
| Finds | Any workspace package with `kb.manifest` or `exports["./kb/commands"]`; every `@kb-labs/*` package in `node_modules` that has a manifest; third-party `node_modules` packages only if `kb-cli-plugin` keyword/`kb.plugin` flag and allow-listed or linked. |
| Not found | Anything installed in `<projectRoot>/node_modules` (a project-scope `kb marketplace install` runs `pnpm add` there). Disabled lock entries were still loaded. |
| Manifest | `import()` of the compiled manifest module, again `import()`ed by `registerManifests` to look for `init/register/dispose` hooks. |
| Output | `DiscoveryResult { source: workspace\|linked\|node_modules, scope, packageName, manifestPath, pkgRoot, manifests: CommandManifest[] }`, cached in `.kb/cache/cli-manifests.json` (5 min TTL, hashes of lockfile, config, `plugins.json`, both locks). Load failures became synthetic "unavailable" manifests. |
| Shadowing | By package name: project scope beats platform; inside a scope `workspace > linked > node_modules`. `registerManifests` then applies the same source priority per command path. |

### Differences that mattered

1. Visibility: project-scope install visible to REST, invisible to the CLI.
2. Truth: lock (REST) versus directory listing plus `plugins.allow` (CLI). Lock `enabled: false` was honoured by REST only.
3. Integrity: checked by REST, never by the CLI.
4. Execution: the CLI ran plugin JS twice per plugin inside the host.
5. Cost: the CLI needed a disk cache to stay inside a 150 ms budget.
6. Dev source: only the CLI knew workspace packages.

## 2. After: `core-discovery` is the only pipeline

`DiscoveryManager({ root, platformRoot, workspace? })`:

1. **Candidates.** Lock entries of the platform scope, then the project scope (project overwrites the same lock key). Origin is `linked` for `source: 'local'`, `node_modules` for `source: 'marketplace'`. Plus, unless `workspace: false`, pnpm workspace packages under each scope root that declare `kb.manifest` and are built (`workspace` origin). A root without `pnpm-workspace.yaml` contributes only its own package. With one root the scope is `platform`.
2. **Load, in parallel.** Disabled entries skipped; package dir must exist; integrity for non-`local` locked entries; manifest read from the static sibling `dist/manifest.json` when present (no plugin code runs, `manifestKind: 'static'`), otherwise the compiled module is `import()`ed (`'module'`). A manifest of another schema (`kb.service/1`) is an `info`, not a failure.
3. **Shadow by plugin id.** Project scope beats platform scope; inside a scope `workspace > linked > node_modules`; a tie keeps the first and warns.
4. **Result.** `DiscoveryResult` gains `failures[]` (`manifest | integrity | package-missing`), and `DiscoveredPlugin` gains `packageName, scope, origin, manifestPath, manifestKind`.

`cli/commands/src/registry/discover.ts` is now ~110 lines: `discoverManifests(cwd, { platformRoot, projectRoot })` runs `DiscoveryManager` and maps plugins to `DiscoveryResult` via `manifestToCommands` (`manifest-commands.ts`). A candidate whose manifest file exists but failed to load still becomes a synthetic "unavailable" manifest so `kb <group>` explains itself. `registerManifests` keeps its source-priority shadowing and the ADR-0018/trie namespace behaviour unchanged; scope-based ownership is task 7.5.

## 3. Deliberate removals

- Directory scanning of `node_modules`, `.kb/plugins`, `exports["./kb/commands"]` (unused in the repo).
- The disk cache `.kb/cache/cli-manifests.json`, the in-process cache, `--no-cache`/`KB_PLUGIN_NO_CACHE` for discovery, `discoverManifestsByNamespace`, `resetInProcCache`, `loadConfig`. Static JSON is read directly.
- Manifest lifecycle hooks (`init/register/dispose` exported from the manifest module) and `shutdown.ts`: they were the second `import()` of plugin JS at registration. No in-repo plugin used them.
- Old tests of the removed scanner and cache; replaced by `core/discovery/src/__tests__/unified-sources.spec.ts` and `cli/commands/src/registry/__tests__/unified-discovery.test.ts` (CLI versus `EntityRegistry` parity on a fixture with platform, project, linked and workspace plugins).

## 4. Governance gate (kept)

`plugins.allow` / `plugins.block` / `plugins.linked` from `<scopeRoot>/.kb/kb.config.json` are enforced inside `core-discovery` (`plugin-policy.ts`) for third-party (not `@kb-labs/*`) packages of `node_modules` origin. `block` always wins; `allow` only restricts when it is configured (the old scanner denied every third-party package by default, which would hide every marketplace install now that the lock is the install record); names in `linked` count as allowed. Gated-out packages produce `PLUGIN_BLOCKED` / `PLUGIN_NOT_ALLOWED` diagnostics, surfaced by `kb diag --command` as `PLUGIN_BLOCKLISTED` / `PLUGIN_NOT_ALLOWLISTED`.

## 5. Notes and open points

- The task brief assumed the manifest cache had moved to the project state directory (`resolveRuntimeStatePath`). Master has no such function and the cache was still `<cwd>/.kb/cache/cli-manifests.json`; instead of moving it, the cache is deleted because static reading replaces it. If a state-dir cache is still wanted for plugins without a static manifest, it is a follow-up on top of this API.
- `kb marketplace plugins refresh` and `rehash` still delete the (now never written) legacy cache file; the command and its documentation references should be removed in a follow-up.
- `discoverAdapters` (core/runtime) still reads locks itself and lets the project lock override platform adapters (ADR-0048 F7). Adapters are a different entity kind; not touched here.
- In a monorepo checkout a lock is optional: workspace packages are found without one, so a stale machine-local lock cannot hide them.
