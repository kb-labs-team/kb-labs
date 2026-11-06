# ADR-0026: Scoped Plugin Install and Adapter-Role Validation

**Date:** 2026-07-23
**Status:** Accepted — implemented (scoped install, adapter-role validation,
catalog-driven config rendering, version pinning, reusable CI action)
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-07-23
**Tags:** architecture, cli, plugin-system, tooling, platform

## Context

`kb-create` (the Go installer) originally had one path to install anything:
the interactive wizard (or `--yes` for its full-default preset), which always
pulls in the whole platform shape the manifest catalog defaults to. There was
no way to install a single plugin standalone — e.g. `plugins/release` in CI,
without gateway/workflow/marketplace — without going through the full
onboarding flow.

A non-interactive `kb-create install --plugins=... --services=...` command
was added to close that gap (PR #293/#294, shipped in binaries release
`v2.105.0-binaries`, verified live via a real `curl kblabs.ru/install.sh` in
CI — see `e2e/install-flow/test.sh`'s "Step 1f").

While validating it, a related gap surfaced: a plugin declares the platform
capabilities it needs via its manifest's `platform.requires`/`optional`
fields (e.g. `plugins/release/src/cli/manifest.ts` declares
`requires: ['storage','cache']`), but **capability/role names live in three
places that don't talk to each other**, and nothing lets an install caller
say which real adapter package should back a role:

1. **`core/plugin-runtime/src/platform/adapter-registry.ts`** —
   `ADAPTER_REGISTRY`, a `const satisfies { [K in keyof
   Required<PluginServices>]: AdapterDescriptor<any> }`. TypeScript-enforced
   against `PluginServices`/`PlatformServices` at compile time (see
   `core/plugin-runtime/docs/adr/ADR-0001-adapter-pipeline.md`). 16 real
   keys: `logger, llm, embeddings, vectorStore, cache, storage, analytics,
   eventBus, config, invoke, documentDatabase, kvStore, logs, notifier,
   artifacts, snapshotManager`.
2. **`core/plugin-contracts/src/manifest.ts`** — `PlatformRequirements`, the
   type a plugin's own `platform.requires`/`optional` fields use. A
   **separately hand-maintained literal union** that has already drifted
   from `ADAPTER_REGISTRY`: missing `eventBus`, `config`, `invoke`,
   `documentDatabase`, `kvStore`, `logs`, `artifacts`, `snapshotManager`, and
   `optional` isn't constrained at all (`Array<string>` — any string
   passes).
3. **Go (`tools/kb-create`)** — zero representation of role names anywhere.
   `install_service.go`'s `--adapters "role=pkg@version"` flag (a different
   command, for pinning a versioned service release) parses role names as
   free text with no validation, and discards the role key after parsing —
   only the package spec reaches the install. `scaffold.go`'s generated
   `kb.config.jsonc` adapters block hardcodes packages for `llm, storage,
   logger, logRingBuffer, analytics, serviceTransport` as Go string
   literals — **`cache` isn't rendered at all**, so `release`'s `cache`
   requirement is silently unconfigured by every install today, and nobody
   has noticed.

This is exactly the "N independent hand-maintained lists that drift" failure
mode ADR-0001 already fixed once for the adapter *pipeline* internals — the
same shape of problem, one layer up, at the install/config boundary instead
of the runtime pipeline.

## Decision

### Scoped install (accepted, shipped)

`kb-create install --plugins=<ids> --services=<ids>` installs exactly what
was asked for, validates every ID against the manifest catalog
(`tools/kb-create/internal/manifest/manifest.json`) **before** any network
action, and reuses the existing non-interactive defaulting path
(`wizard.Run(Yes: true)`) rather than re-implementing it. `release` is now a
registered catalog entry (`@kb-labs/release`).

### Install-time flow (as shipped)

```
kb-create install --plugins=X[@ver] --services=Y[@ver] [--adapters "role=pkg@ver"]
        │
        ▼
[1] Load manifest catalog (manifest.json, embedded)
        │
        ▼
[2] Validate --plugins/--services IDs against catalog        ─┐
    Validate --adapters role names against ADAPTER_REGISTRY   │  fails fast,
    _KEYS                                                      │  no network
        │                                                      │  yet
        ▼                                                     ─┘
[3] Install packages (pnpm add) — scoped to what was requested,
    version-pinned per id@version when given (else @latest)
        │
        ▼
[4] Scan node_modules → discover installed plugins' manifests
    (dist/manifest.json, static — no JS execution; see the
    devkit tsup preset's onSuccess hook)
        │
        ▼
[5] Read each plugin's platform.requires / platform.optional
        │
        ▼
[6] Render kb.config.jsonc adapters block, plus services/plugins
    toggle blocks, generically off the catalog (Options.Catalog):
    scaffold defaults (manifest.json's adapterConfig.adapters,
    overridable by Go literal fallback) ∪ --adapters overrides
        │
        ▼
[7] Reconciliation report:
    required role, no adapter anywhere  → visible warning
    optional role, unconfigured         → informational note
```

All 7 steps are shipped (#293/#294 for 1–5, #296 for the `--adapters` flag,
role validation, and reconciliation report, #299 for the config-driven
adapter defaults in step 6, #298 for the `id@version` pinning in step 3).

### One canonical role-name source, not three (shipped, PR #296)

Add a single derived, serializable export from the existing canonical list
instead of inventing a new one:

- `core/plugin-runtime/src/platform/adapter-registry.ts`: `export const
  ADAPTER_REGISTRY_KEYS: AdapterRegistryKey[] =
  Object.keys(ADAPTER_REGISTRY) as AdapterRegistryKey[];` — plain string
  array, no internals (governance/factory functions) exposed.
- Re-exported through `platform/index.ts` → root `src/index.ts`.
- Snapshotted to `dist/adapter-roles.json` by a small dedicated postbuild
  script (`core/plugin-runtime/scripts/emit-adapter-roles.mjs`), the same
  "static JSON so Go never executes JS" principle already used for plugin
  manifests, but simpler (plain data export, no manifest-schema detection,
  runs as its own fresh `node` process after `tsup` — no staleness concerns
  to work around).
- `tools/kb-create` reads it (`internal/devservices.LoadAdapterRoles`,
  resolved from `<platformDir>/node_modules/@kb-labs/plugin-runtime/dist/
  adapter-roles.json`) to validate `--adapters` role keys before touching
  the network, and to cross-check each installed plugin's declared
  `platform.requires`/`optional` against what's actually configured.

### Two distinct kinds of "source of truth" (both now addressed)

Role **names** (is `"cache"` a real capability?) and role **default
packages** (which npm package backs `cache` when nothing overrides it) are
different questions. `ADAPTER_REGISTRY` answers the first at compile time —
capability existence is a type-level fact, snapshotted to
`ADAPTER_REGISTRY_KEYS`/`adapter-roles.json` as above. The second — which
package to recommend by default — is an editorial/product choice, not
something a type system enforces. That mapping now lives in
`tools/kb-create/internal/manifest/manifest.json`'s `adapterConfig.adapters`
field (shipped, PR #299): a config-editable map, checked as a middle
priority tier between a `--adapters` CLI override (highest) and a Go
hardcoded fallback in `scaffold.go` (lowest, kept only as a defensive
default if `manifest.json` omits an entry). Changing a role's default
package is now a `manifest.json` edit, not a `kb-create` binary release.

No default was picked for `cache` specifically — of all packages in this
repo, only `@kb-labs/adapters-redis` implements `ICache`, and defaulting to
it risks install-time or runtime failures wherever no Redis is actually
running. `cache` stays opt-in via `--adapters cache=<pkg>`; the
reconciliation report (step 7) surfaces its absence as a visible, non-fatal
warning instead of silently rendering nothing.

## Install Flow Map and Invariants

Three entity kinds, ranked by who can ship them and what they can own:

```
service   ⊃ plugin capabilities, OWNS a daemon + port         — KB Labs only
plugin    — CLI commands + optional REST routes (mounted      — anyone
            via the shared gateway, never its own daemon)
adapter   — implements one role (llm/cache/storage/...);      — anyone
            the ROLE is a KB-Labs-controlled contract
            (ADAPTER_REGISTRY), the PACKAGE behind it is not
```

A service can do everything a plugin can (release's manifest proves a
*plugin* can already have `rest.routes` without being a service — the
distinguishing fact is daemon+port ownership, not HTTP presence). A plugin
can never become a service. An adapter is orthogonal to both — plugins and
services *consume* adapters by role name, they don't contain them.

This asymmetry is why services get away with a small hardcoded catalog
entry (`manifest.json`'s 5 `@kb-labs/*` services — closed, trusted set)
while plugins needed a self-describing static manifest (`dist/manifest.json`,
this ADR's shipped half) — the set of plugin publishers is open, so it can't
be hardcoded the way services can.

### Top-down call chain for `kb-create install --plugins=X --services=Y --adapters="role=pkg"`

```
[0] cmd/install.go: runInstall
      │
      ▼
[1] manifest.Load()  ──────────────────────────────────────────  catalog
      reads embedded/dev-override manifest.json                  (services+
      │                                                          plugins IDs,
      ▼                                                          KB-Labs only)
[2] validateComponentIDs(plugins, services)   ── FAILS HARD, ZERO SIDE EFFECTS
      unknown ID → error + list of valid IDs, before any network/fs action
      (adapters: role validated against ADAPTER_REGISTRY_KEYS, loaded from
       adapter-roles.json — NOT against manifest.json; package spec itself
       is never validated here, only pnpm resolving it later can tell you
       it doesn't exist)
      │
      ▼
[3] wizard.Run(Yes: true) → defaultSelection()  ── single defaulting source
      PlatformDir / Consent / Telemetry come from here — shared with the
      interactive `--yes` path, not reimplemented. sel.Services/sel.Plugins
      then OVERWRITTEN with exactly what was requested (not merged with
      catalog defaults).
      │
      ▼
[4] pm.Install(specs) — pnpm add
      specs = CorePackageSpecs() ∪ AdapterPackageSpecs() (5 baseline        ⚠ NOT
              adapters: fs/pino/log-ringbuffer/analytics-file/              scoped —
              service-transport-http — ALWAYS installed)                   see I3
            ∪ selectedPkgSpecs(requested plugins/services only)
      A selected plugin's OWN package.json deps (e.g. release →
      core-state-daemon) ride along transitively — not filtered.           see I4
      FAILURE: pnpm error → hard fail, install aborts.
      │
      ▼
[5] scan.Run() — Node subprocess walks the WHOLE node_modules tree
      classifies anything with a kb.manifest by schema prefix into
      Plugins / Services / Adapters — including transitively-installed
      things nobody explicitly asked for (state-daemon showed up this way
      in the release e2e test — expected, not a bug: release declares
      `cache`, core-state-daemon is what backs it).                        see I4
      FAILURE: soft — warns, sets a user-visible ServicesWarning, does
      NOT block the rest of install.
      │
      ▼
[6] devservices.LoadPluginManifest() per discovered plugin — Go-native,
      no JS execution. Reads Platform.Requires/Optional, Permissions.Env
      .Read, ConfigSection from each plugin's static dist/manifest.json.
      FAILURE: soft, per-plugin — missing/invalid file is silently
      skipped (e.g. an older published version predating this convention).
      │
      ▼
[7] scaffold.generateFull() → kb.config.jsonc
      services/plugins TOGGLE blocks: rendered by looping over
      Options.Catalog.Services/.Plugins directly (Catalog is nil-unsafe —
      a nil Catalog renders empty blocks, no shadow hardcoded fallback) —
      `gateway` is the one explicit exception (has its own richer
      auth/host/upstreams config section elsewhere, so is excluded from
      the generic toggle to avoid a redundant second on/off switch).      fixes I5
      adapters block: role → package resolved per role as CLI --adapters
      override ∪ manifest.json's adapterConfig.adapters ∪ Go fallback
      literal, in that priority order; `cache` renders only when
      explicitly configured (no built-in default — see above).
      │
      ▼
[8] Reconciliation report — cross-check each discovered
      plugin's Platform.Requires/Optional against the FINAL resolved
      adapter set (defaults ∪ --adapters overrides).
      required + unconfigured → visible warning (not a hard fail)
      optional + unconfigured → informational note
```

### Invariants

| # | Statement | Enforced where | On violation |
|---|-----------|----------------|---------------|
| I1 | Requested plugin/service IDs must exist in the manifest catalog | `validateComponentIDs`, step 2 | **Hard fail**, before any network/fs action, lists valid IDs |
| I2 | Non-interactive defaulting (platform dir, consent, telemetry) has exactly one implementation | `wizard.Run(Yes:true)`, step 3 | N/A — shared code path, can't drift between interactive/CI installs |
| I3 | Core packages + the 5 baseline adapters install unconditionally, regardless of `--plugins`/`--services` selection | `CorePackageSpecs()`/`AdapterPackageSpecs()`, step 4 | Not a failure — a deliberate scoping boundary: "scoped install" scopes *plugins/services*, not the platform baseline |
| I4 | A selected plugin's transitive npm dependencies are discovered by the scanner even though they weren't explicitly requested | `scan.Run()`, step 5 | Not a failure — expected when a plugin genuinely depends on a service (e.g. release → core-state-daemon for its `cache` requirement) |
| I5 | A plugin/service in the manifest catalog is automatically *configurable/visible* in generated config — driven by one loop over `Options.Catalog`, not a parallel hardcoded Go list | `writeToggle`/`writePluginBlock`, step 7 | **Fixed (PR #296)** — adding a catalog entry is now sufficient by itself; `gateway` is the one documented exception (has its own dedicated config section) |
| I6 | Adapter *role names* are validated against a KB-Labs-controlled canonical list; adapter *package specs* are not validated until pnpm resolves them | `ADAPTER_REGISTRY_KEYS` check (PR #296), step 2 | Unknown role → hard fail early, before any network action; bad package spec → pnpm failure later, same as any other package |
| I7 | Static-JSON reads (plugin manifests, adapter-roles list) are always best-effort | steps 6, 8 | Missing/invalid file never blocks install — only reduces how much the reconciliation report can say |

I5 was the same "N hand-maintained lists that drift" shape as the
adapter-role problem, one layer further down (catalog ↔ config-template
instead of role-name ↔ role-name). Fixed by driving `writeToggle`/
`writePluginBlock` generically off the catalog's `Component` list
(`Options.Catalog`) instead of a parallel hardcoded Go call per entry
(PR #296).

## Version pinning (shipped, PR #298)

`--plugins`/`--services` accept an optional `@version` suffix per ID:
`kb-create install --plugins=release@0.2.0 --services=rest@1.4.0`, parsed by
`splitVersionedIDs()` into separate `PluginVersions`/`ServiceVersions` maps
on `installer.Selection` (kept separate, not a shared map, because a
component ID like `marketplace` can independently exist in both the plugins
and services catalogs). `selectedPkgSpecs()` uses the pinned version when
given, `@latest` otherwise; version overrides are ignored whenever
`LocalPath` is set (dev mode always wins — a version pin can't fight a local
workspace package).

## Config-driven adapter defaults (shipped, PR #299)

Moved the role → default-package mapping out of pure Go string literals
into `tools/kb-create/internal/manifest/manifest.json`'s `adapterConfig.
adapters` field (`AdapterConfig.Adapters map[string]string` in
`internal/manifest/types.go`). Resolution order in `scaffold.go`'s
`adapterPkg` closure, highest priority first:

1. `--adapters role=pkg` CLI override
2. `manifest.json`'s `adapterConfig.adapters[role]`
3. Go hardcoded literal fallback (kept only so an old/misconfigured
   `manifest.json` missing the section doesn't regress existing behavior)

`cache` was deliberately left out of every tier's default — see "Two
distinct kinds of 'source of truth'" above for why (only one package in the
repo implements `ICache`, and defaulting to it without a running instance
would fail at runtime, not install time).

## Reusable GitHub Action (shipped, PR #300)

`.github/actions/kb-create-install` — a composite action wrapping this
whole flow for CI consumers who just want a scoped platform install without
hand-rolling the binary download + flags themselves. Downloads the released
`kb-create` binary directly from `https://github.com/<repo>/releases/
latest/download/kb-create-<goos>-<goarch>` — the exact naming convention
`internal/selfupdate/selfupdate.go` already uses — then runs
`kb-create install` with the action's `plugins`/`services`/`adapters`/
`platform-dir`/`registry`/`version` inputs, exposing `platform-dir` and
`config-path` as outputs. Verified live via
`.github/workflows/kb-create-install-action-smoke.yml`
(`workflow_dispatch`): confirmed real binary download from the actual
`kb-labs-team/kb-labs` releases page, a scoped install with no leaked
default services, and no marketplace/gateway/workflow pulled in.

## Consequences

### Positive

- One canonical, compile-time-enforced list of valid capability/role names,
  reachable from Go without executing JS — same static-JSON pattern already
  proven for plugin manifests.
- `--adapters` role typos fail fast, before any package is installed,
  instead of silently producing a config with an unrecognized key.
- The previously-silent `cache`-unconfigured-for-`release` gap becomes a
  visible warning instead of invisible NoOp behavior nobody notices.
- Adding a plugin/service to the catalog is now sufficient by itself to get
  it toggled in generated config — no matching Go template edit required.
- Adapter default packages, and plugin/service versions, are now
  config/flag-driven instead of requiring a `kb-create` binary release to
  change.
- CI consumers get a maintained, versioned reusable Action instead of
  re-implementing the binary-download + flags dance themselves.

### Negative

- Introduces a new build artifact (`adapter-roles.json`) and a new Go
  dependency on a specific file path inside a *transitively* installed
  package (`@kb-labs/plugin-runtime` isn't in the manifest's always-installed
  `core` list) — resolution degrades gracefully (skips validation, warns
  softly) if the file isn't found, rather than hard-failing.
- `PlatformRequirements` derives from `AdapterRegistryKey` now (PR #297,
  see below), but a plugin manifest with a genuinely bogus `platform.
  requires` entry still only fails at TypeScript compile time for that
  plugin's own source — nothing prevents publishing a manifest built with an
  older, unchecked contracts version.

### Alternatives Considered

- **Reuse the devkit tsup preset's `emitManifestJson` hook** for the
  adapter-roles snapshot too. Rejected: that hook is specifically keyed off
  `kb.plugin/*`/`kb.service/*` manifest schema detection; overloading it for
  an unrelated arbitrary-export snapshot would complicate its one job. A
  small dedicated postbuild script in `core/plugin-runtime` is simpler and
  fully sufficient — this isn't a manifest, so it doesn't need manifest
  detection logic.
- **Hard-fail installs on an unsatisfied required role.** Rejected: every
  install before this ADR already left `cache` unconfigured for `release`
  with no one having noticed — hard-failing immediately would be a breaking
  change better rolled out separately, after the reconciliation report has
  been observed in practice.
- **Expose the whole `ADAPTER_REGISTRY` object to Go/JSON.** Rejected: its
  values are governance/factory functions, not serializable, and exposing
  them on the public package surface would leak internals never meant to be
  consumed outside `plugin-runtime`. A derived `ADAPTER_REGISTRY_KEYS`
  (names only) is the minimal correct surface.
- **Default `cache` to `@kb-labs/adapters-redis`.** Rejected: it's the only
  `ICache` implementation in the repo, but defaulting to it would install a
  Redis-dependent adapter for every plugin declaring `cache` as optional,
  failing at runtime for anyone without Redis running — worse than the
  current opt-in-with-warning behavior.

## Implementation

All shipped:
- `tools/kb-create/cmd/install.go`, `internal/installer/installer.go`
  (`Result.InstalledPlugins`), `internal/devservices/plugin_manifest.go`,
  `internal/manifest/manifest.json` (`release` catalog entry),
  `infra/devkit/tsup/node.js` (`emitManifestJson` extended to `kb.plugin/*`
  schemas). — PR #293/#294
- `core/plugin-runtime/src/platform/adapter-registry.ts`
  (`ADAPTER_REGISTRY_KEYS` export), `platform/index.ts`/`src/index.ts`
  re-exports, `core/plugin-runtime/scripts/emit-adapter-roles.mjs`
  (postbuild snapshot), `tools/kb-create/internal/devservices/
  adapter_roles.go` (`LoadAdapterRoles`), `cmd/install.go` (`--adapters`
  flag, role validation, reconciliation report),
  `internal/scaffold/scaffold.go` (`Options.Adapters`, `cache` as a
  renderable opt-in role), `internal/scaffold/Options.Catalog` +
  catalog-driven `writeToggle`/`writePluginBlock` loop. — PR #296
- `core/plugin-contracts/src/manifest.ts` — `PlatformRequirements` now
  derives `PlatformCapability = keyof Required<PluginServices>` instead of
  a separately hand-maintained literal union. — PR #297
- `tools/kb-create/internal/installer/installer.go`
  (`PluginVersions`/`ServiceVersions`), `cmd/install.go`
  (`splitVersionedIDs`) — `id@version` pinning. — PR #298
- `tools/kb-create/internal/manifest/types.go` (`AdapterConfig.Adapters`),
  `manifest.json` (`adapterConfig.adapters` defaults),
  `internal/scaffold/scaffold.go` (`adapterPkg` priority chain) — PR #299
- `.github/actions/kb-create-install/action.yml`,
  `.github/workflows/kb-create-install-action-smoke.yml` — PR #300

### Remaining deferred item

- Validating adapter roles when installing a plugin onto an
  already-running platform via the marketplace (`services/marketplace`) — a
  different install mechanism entirely, not `kb-create install`. Not
  addressed by this ADR or any of its follow-up PRs; tracked here so it
  isn't lost.

## References

- [PR #293 — kb-create static plugin manifest JSON + non-interactive install](https://github.com/kb-labs-team/kb-labs/pull/293)
- [PR #294 — changelog + real e2e test for kb-create install --plugins](https://github.com/kb-labs-team/kb-labs/pull/294)
- [PR #296 — adapter-role validation, reconciliation report, catalog-driven config rendering](https://github.com/kb-labs-team/kb-labs/pull/296)
- [PR #297 — PlatformRequirements derives from ADAPTER_REGISTRY](https://github.com/kb-labs-team/kb-labs/pull/297)
- [PR #298 — id@version pinning for --plugins/--services](https://github.com/kb-labs-team/kb-labs/pull/298)
- [PR #299 — config-driven adapter role defaults](https://github.com/kb-labs-team/kb-labs/pull/299)
- [PR #300 — reusable kb-create-install GitHub Action](https://github.com/kb-labs-team/kb-labs/pull/300)
- [ADR-0001 — Slot-Based Adapter Middleware Pipeline](../../core/plugin-runtime/docs/adr/ADR-0001-adapter-pipeline.md) (the original "single source of truth" fix this ADR extends to the install boundary)

---

**Last Updated:** 2026-07-23
