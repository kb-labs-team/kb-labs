# ADR-0048: Extension Model: Shared Version Store, Per-Project Pin, SDK Contract Version

**Date:** 2026-09-26
**Status:** Proposed (design decided after the code spike of task 7.1; awaiting author acceptance)
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** architecture, plugin-system, marketplace, platform

> **Risk note:** this is the riskiest area of the target architecture. It touches
> discovery, marketplace and module resolution (ADR-0012, ADR-0030). The first
> version of this ADR was a hypothesis from the notes. This version is the result of
> reading the real code (spike 7.1); every claim below carries a `file:line`
> reference, and what could not be verified is listed explicitly in
> "Not verified". Recommendation: **GO with the narrowed scope in this ADR**
> (see "Go / no-go").

## Context

Plugins and adapters are installed either globally (platform scope) or in a
project (project scope, ADR-0012), and the platform can end up as a transitive
dependency of a plugin. State is of three kinds: global (`~/.kb/`), project
declaration (`<repo>/.kb/`, in git) and project runtime state
(`~/.kb/state/<projectId>/`, ADR-0044). Three variants were considered for where
extensions live (A global, B local per project, C shared store plus per-project
pin). Source: `docs/architecture/target/03-domain-model.md` (variant C) and
`07-migration.md` stage 7.

### What the code does today (spike findings)

**F1. Two independent discovery pipelines exist, and they disagree.**

- The lock-based pipeline (`core-discovery`) reads `.kb/marketplace.lock` and
  loads only what is in it: "There is no filesystem scanning"
  (`core/discovery/src/discovery-manager.ts:43-48`). It merges the platform lock
  and the project lock, project wins by package id (`:99-126`). It is used by
  `EntityRegistry` (`core/registry/src/registry.ts:53-59`), REST
  (`services/rest-api/app/src/bootstrap.ts:94-100`) and adapters
  (`core/runtime/src/discover-adapters.ts:121-141`).
- The CLI pipeline (`cli/commands/src/registry/discover.ts`, 1565 lines) does not
  use the lock to find plugins. `discoverManifests` scans the platform workspace
  (`:1448`), `<platformRoot>/node_modules` (`:1466`, function `:817`),
  `<projectRoot>/.kb/plugins/*/packages/*-entry` (`:1478`, function `:676`) and,
  in prod mode, the project workspace. The lock is used only to compute cache
  invalidation hashes (`:235`, `:1154-1163`). A third-party package in
  `node_modules` is skipped unless it is in `plugins.allow` or `linked`
  (`:866`, `:903`), a gate that lives in `.kb/plugins.json` /
  `kb.config` (`cli/commands/src/registry/plugins-state.ts:26-43`) and is not the
  lock.
- Consequence: a project-scope `kb marketplace install` runs `pnpm add` in
  `<projectRoot>` (`plugins/marketplace/npm/src/npm-source.ts:48-57`), so the
  package lands in `<projectRoot>/node_modules/<id>` (`:66`). REST sees it through
  the lock; the CLI scans only `<platformRoot>/node_modules`, so by code reading
  it does not. (Read from code; not exercised end to end.)
- Enable/disable state is spread over three places: `enabled` in
  `marketplace.lock` (`core/discovery/src/marketplace-lock.ts:198-208`),
  `.kb/plugins.json` (`enabled/disabled/linked`), and `plugins.allow/block` in
  the config.

**F2. Install writes into the user's repository.** `pnpm add <spec>
--ignore-workspace-root-check` with `cwd = <projectRoot>` rewrites the project's
own `package.json`, lockfile and `node_modules`
(`plugins/marketplace/npm/src/npm-source.ts:48-57`; the comment there says
kb-create projects are flat). This contradicts ADR-0044 §8 ("never modifies a
project silently"). The lock entry also stores `installedAt`
(`marketplace-lock.ts:160`) and an absolute-ish `resolvedPath`, both poor for a
file that is meant to be committed.

**F3. Lock format and its writers.** Schema `kb.marketplace/2`
(`marketplace-lock.ts:13`) with `installed: Record<id, entry>`; the reader
rejects any other schema outright (`:57-63`, `:214-223`). Entry type:
`core/discovery/src/types.ts:55-84`. `integrity` is a hash of `package.json`
only, "not the full tarball" (`core/discovery/src/integrity.ts:5-6,26-31`), and is
skipped for `source: local` (`discovery-manager.ts:165`). The lock has **three
writers/readers outside `core-discovery`**: the Go launcher
(`tools/kb-create/v2/marketplace/lock.go:22-60`, regenerates the whole platform
lock from the applied plan, no integrity), the devkit check
(`scripts/checks/check-marketplace-lock.mjs`) and deployment files (helm
`deploy/helm/kb-labs-platform/templates/*`, `services/*/docker-entrypoint.sh:11`,
`tools/kb-dev/cmd/diagnose.go`). 278 files mention `marketplace.lock` in total
(docs and blog posts included). Note: `.kb/lock.json` is a different file
(core-config lockfile, `core/config/src/api/upsert-lockfile.ts:19`); the new
schema must not reuse that name.

**F4. Manifest detection executes plugin JS inside the host.** At install,
`PluginStrategy.detectKind/extractProvides/resolveId` call `loadManifest`
(`plugins/marketplace/core/src/strategies/plugin-strategy.ts:13-30`), which
`import()`s the plugin's `dist/manifest.js` in the marketplace daemon process
(`core/discovery/src/manifest-loader.ts:133-141`); adapters are `import()`ed the
same way (`adapter-strategy.ts:83-90`). The CLI does it again at registration
(`cli/commands/src/registry/register.ts:~165`, `await import(result.manifestPath)`
plus `init/register` hooks). So arbitrary plugin code, and the plugin's own copy of
`@kb-labs/sdk` (a manifest imports helpers from it, e.g.
`plugins/commit/entry/src/manifest.ts:13-18`), runs in host processes before any
compatibility check. A build-emitted static `dist/manifest.json` already exists
for the naming lint (`scripts/checks/check-manifest-command-naming.mjs:21`);
ADR-0026/0030 already treat static manifests as the safe artifact.

**F5. How a plugin gets the platform at runtime.** Handlers are `import()`ed by
absolute file path inside the worker/subprocess/in-process backend
(`core/plugin-execution-factory/src/backends/worker-pool/worker-script.ts:163`,
`.../subprocess.ts:282`, `.../in-process.ts:169`,
`core/sandbox/src/runner/execution/handler-loader.ts:37`); `pluginRoot` is passed
explicitly (`cli/runtime/src/v3/execute-command.ts:204-205`; the fallback
`resolvePluginRoot` uses `require.resolve(..., {paths:[cwd]})` at `:275-291`).
Nothing injects the host's platform into the plugin: Node resolves `@kb-labs/sdk`
and `@kb-labs/core-*` from the plugin file's own location upward. There are three
cases:
  1. Platform-scope plugin installed next to the platform in one pnpm project
     (`kb-create` installs every artifact as `pnpm add file:<tarball>` into one
     `platformRoot`, `tools/kb-create/v2/artifacts/pnpm.go:206-226`): pnpm resolves
     the peers inside one graph, so there is one copy. This is why platform scope
     works today.
  2. Project-scope plugin: the SDK is a `dependency` of the plugin
     (`plugins/commit/entry/package.json`, `plugins/mind/entry/package.json`), the
     SDK's own `core-*` are `peerDependencies` with range `>=2.0.0`
     (`sdk/sdk/package.json:158-177`), so a project-local install has to satisfy
     them itself; with pnpm auto-install-peers that means a second, private
     `core-*` tree (pnpm behavior, not exercised here; the prototype below shows the
     duplicate when the peer is satisfied locally).
  3. If nothing satisfies the peer, `Cannot find package` (prototype: ERR_MODULE_NOT_FOUND).
- The platform singleton is deliberately tolerant of duplicate copies
  (`Symbol.for('kb.platform')` stored on `process`,
  `core/runtime/src/container.ts:923-976`, ADR-0043 inventory), but class
  identity, `instanceof` and error classes are not shared between copies.
- The lint from stage 0 (`scripts/checks/check-plugin-peer-deps.mjs`) forbids
  platform packages in `dependencies`, but `scripts/checks/boundary-exceptions.json`
  still holds **34** `plugin-platform-dependency` exceptions (plus 2
  `plugin-core-import`), i.e. most first-party plugin entries still violate it.

**F6. Namespace ownership is decided by discovery order, silently.**
`registerManifests` sorts by source priority `builtin > workspace > linked >
node_modules` (`cli/commands/src/registry/register.ts:58-63,137-139`), scope is
not an input although `DiscoveryResult` carries it. The trie gives a top-level
namespace to the first inserted package (`trie-router.ts:127-140`) and later
packages get `shadowed = true` plus a `logger.warn`
(`cli/commands/src/registry/service.ts:101,124-128`). Reserved tiers are checked
only at registration (`service.ts:88-97`, `cli/contracts/src/reserved-namespaces.ts`);
`MarketplaceService.install` has no namespace or reserved check at all
(`marketplace-service.ts:117-212`). ADR-0046 rules 2-3 are therefore not
implemented.

**F7. Adapters are platform-only and run in the host process.**
`assertScopeAllowsKind` rejects project-scope adapters
(`marketplace-service.ts:637-644`, ADR-0012). Adapters are `import()`ed in the
launching process (`core/runtime/src/discover-adapters.ts:78`,
`core/runtime/src/loader.ts:645-…`) and modules of one host share one platform
container (ADR-0043). One inconsistency: `discoverAdapters` still reads the
project lock first and lets it override the platform's adapters
(`discover-adapters.ts:121-141`), even though the marketplace forbids putting
adapters there.

**F8. Versions.** Packages are versioned independently in one release train
(`@kb-labs/sdk` 2.117.0, `@kb-labs/plugin-runtime` 2.120.1,
`@kb-labs/commit-entry` 2.120.1). There is no SDK contract version anywhere: no
`sdkApiVersion`/`engines` in `ManifestV3` (`core/plugin-contracts/src/manifest.ts:677-`),
and the registry's platform version is a hard-coded `'1.0.0'`
(`core/registry/src/registry.ts:37`). `sdk/sdk/scripts/check-api-removals.mjs`
exists and is the natural base for a compatibility gate.

**F9. Multi-project topology.** ADR-0043 keeps rest/workflow/mcp as one process per
project; only the machine-level host (gateway, marketplace, state) is shared. So
"two projects on different versions of one plugin" means two project runtimes plus
the CLI (one project per invocation), never two versions active in one
request-serving process. The marketplace daemon is the exception because of F4
(it imports plugin code to inspect it).

### Prototype (throw-away, not committed)

A temp `HOME`, explicit pnpm store, synthetic packages (`kb-core` = platform
stand-in, `kb-sdk@1.0.0/1.1.0` with `kb-core` as peer, `kb-plugin@1.0.0/2.0.0`
depending on an exact `kb-sdk`, one third-party `util-a`), pnpm 11.4.0, Node
24.18.1, macOS/APFS.

| Question | Result |
|---|---|
| Install two versions into `store/<name>@<version>/` (one small pnpm project each, `autoInstallPeers: false`) | 0.86-1.34 s for the first, 0.14-0.17 s for the second (warm pnpm CAS) |
| Peer not satisfied in a store entry | `ERR_MODULE_NOT_FOUND: Cannot find package 'kb-core'` |
| Wire the peer with a symlink `entry/node_modules/kb-core -> platform copy` | works, both versions see one `kb-core` |
| Wire the peer with a resolve hook (`module.registerHooks`, no links) | works; v1 and v2 loaded in one process, each got its own SDK (`sdkApi` 1 and 2), both got the same platform copy |
| Project-local install that satisfies the peer itself (today's project scope) | plugin resolves a **different** `kb-core` than the platform (duplicate: true) |
| Import through the hook, 10 fresh processes | 1.6-4.9 ms (toy packages; not representative of a real SDK graph) |
| Dedup of third-party files between two store entries | **not shown**: with `file:` tarball dependencies files had link count 1 and each entry was the full 1384 KB even with `package-import-method=hardlink`; APFS clonefile also hides sharing from `du`. Registry dependencies are stored in the pnpm CAS by design, but this was not measured (no network in the spike) |

The dedup row matters: `kb-create` installs release artifacts as `file:<tarball>`
(F5.1), and pnpm does not hardlink those.

## Decision

**Variant C, narrowed.** A shared per-machine store of immutable plugin versions,
a per-project pin in the committed lock, an SDK contract version checked at
install and at load, and exactly one copy of the platform at runtime, enforced by
a resolve hook instead of by installation layout. Details and rationale per open
question follow; each decision names the alternatives that were rejected.

### D1. Scope of the store: plugins in the store, platform-scope stays as is

- The store holds **project-pinned plugin versions**. Platform-scope plugins and
  adapters stay where `kb-create` puts them (`<platformRoot>/node_modules`, one pnpm
  graph, F5.1). The platform copy is the "platform default".
- Rationale: it keeps the Go launcher, release index and helm/docker delivery
  intact except for the lock schema; the risk of moving the whole installed
  platform into a store is far higher and buys nothing for the completion criterion.
- Rejected: everything in the store including platform-scope plugins (rewrites
  `kb-create` artifacts, ADR-0035 cutover, and every container image contract).

### D2. Store layout and data format

Root is `$KB_HOME/store` (`$KB_HOME` or `~/.kb`, ADR-0044 §1). It must be on the
same volume as its own pnpm content store so that hardlinks/clones work.

```
$KB_HOME/store/
  store.lock                       # exclusive lock file, same protocol as projects.json.lock (ADR-0044 §6)
  cas/                             # dedicated pnpm store-dir for all entries (never the user's default store)
  tmp/<uuid>/                      # staging; entries appear by atomic rename
  entries/
    @kb-labs+commit-entry@2.120.1/ # key = name with '/' -> '+', then '@' + exact version
      entry.json                   # kb.store-entry/1, see below
      package.json                 # synthetic pnpm project: dependencies { "<name>": "<exact version>" }
      pnpm-workspace.yaml          # autoInstallPeers: false
      node_modules/…               # pnpm virtual store; plugin root = node_modules/<name> (realpath)
```

`entry.json` (written last inside `tmp/`; its presence means the entry is complete):

```json
{
  "schema": "kb.store-entry/1",
  "name": "@kb-labs/commit-entry",
  "version": "2.120.1",
  "kind": "plugin",
  "integrity": "sha512-<tarball integrity from the registry or release index>",
  "sdkApiVersion": "^1.0.0",
  "manifest": { "...": "static dist/manifest.json projection (immutable per version)" },
  "signature": { "...": "optional platform signature, verified at install" },
  "installedAt": "2026-09-26T10:00:00.000Z"
}
```

- One directory per exact version, never modified after the rename. Two projects
  pinning one version share it; different versions coexist (prototype: two
  versions loaded in one process, distinct module URLs).
- Third-party dependency dedup is delegated to pnpm's content-addressed store
  (`cas/`); the store installs the plugin by registry spec with `--store-dir
  cas`, so dependency files are shared across entries. The plugin tarball itself
  may come from the release index (`file:` tarball). Because `file:` deps do not
  dedup (measured), third-party deps must resolve from the registry.
  **Gate:** measure real dedup on a registry plugin before 7.2 is accepted.
- Because the manifest of a version is immutable, the manifest cache becomes
  content-addressed: it lives in `entry.json`. The per-root
  `.kb/marketplace.manifests.json` (`plugins/marketplace/core/src/manifest-cache.ts:11`)
  and the lock-hash based invalidation of the CLI cache (`discover.ts:1154-1163`)
  are deleted for store entries; the merged-registry cache moves to
  `~/.kb/state/<projectId>/` (ADR-0044 §7).
- Rejected: (a) one shared pnpm project for all versions with aliased dependencies
  (one failure poisons all installs, ids get aliased); (b) a symlink farm into a
  global flat tree (Windows privileges, version conflicts of third-party
  deps); (c) per-project installs (variant B, duplication, and F2); (d) a
  package-manager-free store that only extracts self-contained bundled tarballs
  (fastest cold start, but breaks native and peer-heavy packages such as
  `better-sqlite3` and the React/antd studio peers). (d) stays a possible later
  optimisation, not a stage 7 goal.
- Garbage collection: `kb plugin gc` (a system command, tier S) marks entries
  referenced by the platform lock and by the lock of every project in
  `projects.json` (ADR-0044) and removes unreferenced entries older than 30 days
  (mtime of a `.used` marker touched at most once a day by load). It takes
  `store.lock`, supports `--dry-run` and `--json`, and follows ADR-0025. A project
  that is not registered or was moved is invisible to the mark phase; the cost is
  only a re-install (`KB_PLUGIN_STORE_MISSING` is recoverable).
- Integrity: the tarball integrity (sha512) is recorded at install and compared
  with the pin at load (string compare, no hashing on the hot path); `kb plugin doctor`
  re-verifies the tree. Directory tampering is out of scope, same trust level as
  today's `node_modules`.

### D3. Project lock: `.kb/marketplace.lock`, schema `kb.marketplace/3`

Keep the file name and location (278 references, helm, docker, `kb-dev`,
`check-marketplace-lock`), bump the schema, and make the reader strict as today
(no migration code, no v2 support). It is a **declaration**: no timestamps, no
absolute paths, sorted keys, so it is stable in git and mergeable.

```json
{
  "schema": "kb.marketplace/3",
  "plugins": {
    "@kb-labs/commit-entry": { "version": "2.120.1", "integrity": "sha512-...", "enabled": true },
    "acme-deploy":           { "link": "./tools/acme-deploy", "enabled": true },
    "@kb-labs/mind-entry":   { "platform": true, "enabled": false }
  }
}
```

Three entry forms (exactly one discriminator each): a store **pin**
(`version` + `integrity`), a project-relative **link** for local development
(what `source: local` is today; not verified for integrity, exempt from the
`sdkApiVersion` requirement with a warning), and a **platform toggle**
(`platform: true`, enables or disables a platform-provided plugin for this
project). `spec`, `trust`, `signature`, `provides`, `primaryKind`, `installedAt`
leave the lock: they are derived or installer facts and live in `entry.json`
(`provides` is already ignored for routing, `tools/kb-create/v2/marketplace/lock.go:43-49`).

The **platform lock** (`<platformRoot>/.kb/marketplace.lock`, machine-local, written
by the Go launcher) uses the same schema with `resolvedPath` (relative to
`platformRoot`) instead of a pin, and additionally has an `adapters` map:

```json
{
  "schema": "kb.marketplace/3",
  "plugins":  { "@kb-labs/commit-entry": { "version": "2.120.1", "resolvedPath": "node_modules/@kb-labs/commit-entry", "enabled": true } },
  "adapters": { "kblabs-gateway-llm": { "version": "2.120.1", "resolvedPath": "node_modules/@kb-labs/adapters-kblabs-gateway", "enabled": true } }
}
```

An `adapters` key (or `resolvedPath`) in a project lock is a schema error
(`KB_PLUGIN_LOCK_INVALID`): adapter scope becomes a property of the format
instead of a check that a reader may forget (F7). The Go writer in
`tools/kb-create/v2/marketplace/lock.go` changes in the same PR as the TS reader;
it already regenerates the whole file on every apply, so the platform lock
self-heals on the next `kb-create update`.

The other state files are not merged into it in stage 7. `.kb/plugins.json`
(`crashes`, `permissions`, `linked`) stays runtime state; its `enabled/disabled`
and the `plugins.allow` gate are removed because the lock is the only enable
switch (no legacy).

### D4. Resolution algorithm (project pin > platform default)

For project root `P`, platform root `R`, per plugin id, in one place
(`core-discovery`, used by CLI, REST, workflow, marketplace):

1. Read `L_P = P/.kb/marketplace.lock` and `L_R = R/.kb/marketplace.lock`. A missing
   file is empty; an unreadable/unknown-schema file is `KB_PLUGIN_LOCK_INVALID`
   and nothing from that lock is loaded.
2. The candidate set is the union of ids. `L_P[id]` wins over `L_R[id]` (ADR-0012
   §3). A `platform: true` project entry means "use `L_R[id]`" and only carries
   `enabled`. A project pin of version X while the platform provides Y is legal:
   the project loads the store copy of X, other projects and the platform keep Y
   (same package, same namespace, no shadowing).
3. Locate the root: link -> `P/<link>`; pin -> `store/entries/<key>/node_modules/<name>`,
   checking that `entry.json` exists and its `integrity` equals the pin; platform
   -> `R/<resolvedPath>`. A pin whose version equals the platform's installed
   version may use the platform copy (no store copy needed).
4. Missing store entry: `KB_PLUGIN_STORE_MISSING`, recoverable with
   `kb plugin install` (no arguments = install everything in the lock, analogous to
   `pnpm install`; no new verb needed, ADR-0046 vocabulary). The CLI does not
   auto-download on the command hot path.
5. SDK contract check (D6), then namespace ownership (D7), then register.
6. The plugin's manifest comes from `entry.json` (store) or the static
   `dist/manifest.json` (platform/link); plugin JS is imported only when a
   command runs, or by lifecycle hooks in the worker, not during discovery.

This replaces `discoverWorkspace/discoverNodeModules/discoverProjectLocalPlugins`
as sources of truth. Development in the monorepo keeps working through explicit
`link` entries produced by `kb plugin add`/sync from the workspace globs
(`marketplace.sync.include`), not through implicit scanning.

### D5. One copy of the platform: resolve hook, not layout

- Store entries are installed with `autoInstallPeers: false`, so an entry contains
  the plugin and its own third-party dependencies but no platform packages.
- The host installs a synchronous resolve hook (`module.registerHooks`, Node 24 is
  the minimum in `engines`) at the start of every process that imports plugin code:
  worker-pool `worker-script.ts` (before `:151`), the subprocess bootstrap
  (`core/sandbox/src/runner/bootstrap.ts`), `cli/bin`, and the marketplace/REST
  daemons. The hook maps the platform package set (the same regex as
  `check-plugin-peer-deps.mjs`: `@kb-labs/sdk`, `platform-client`,
  `plugin-{contracts,runtime,execution,execution-factory}`,
  `(core|cli|shared|adapters)-*`) to the host's copy, resolved from `platformRoot`.
  Plugins that still list the SDK as a `dependency` (34 exceptions today) are
  therefore not a blocker: their private copy is ignored, and cleaning them up
  is a separate task.
- If a plugin resolves a platform package to a path outside the platform (the hook
  did not apply, or a bundle inlined it), load fails with
  `KB_PLUGIN_PLATFORM_DUPLICATE`; `kb plugin doctor` reports it.
- Rejected: symlinks/junctions from each entry to the platform (ties entries to one
  platform path, needs rewriting on every platform update, Windows needs junctions
  and is fragile); `NODE_PATH` (ignored by ESM); relying on pnpm peer resolution
  across separate projects (not possible).
- Caveat that must be tested before 7.3 starts: hooks registered on the main thread
  do not automatically apply inside `worker_threads`, so the hook is registered
  inside the worker, and subprocess backends get `--import`.

### D6. SDK contract version

- The contract version is **independent of the npm version** (packages already
  drift: sdk 2.117.0 vs runtime 2.120.1, F8). It is a semver string
  `SDK_API_VERSION` exported by `@kb-labs/plugin-contracts` (both host and SDK
  depend on it) and re-exported by `@kb-labs/sdk`. Additive changes bump the
  minor, breaking changes bump the major; `check-api-removals.mjs` becomes the CI
  gate that forces a major bump when public exports are removed.
- A plugin declares a **range**: optional-today, required-after-7.4 field
  `sdkApiVersion` (for example `"^1.0.0"`) in `ManifestV3`, emitted into the static
  `dist/manifest.json`, and mirrored in the package as
  `peerDependencies["@kb-labs/sdk"]` for npm tooling (informational; the contract
  check uses the manifest field, not the npm range).
- Check points: (1) **install/enable time** in `marketplace-core`, reading only the
  static manifest of the packed tarball (no JS import, ADR-0030), before anything
  enters the store or the lock; (2) **load time** in discovery/registry, again
  against the manifest projection in `entry.json`, so a platform upgrade that breaks
  an old pin disables that plugin for that project with a visible diagnostic
  instead of crashing the command.
- Error: `KB_PLUGIN_SDK_INCOMPATIBLE` with `{plugin, required, installed}`.
  `kb plugin update` picks the newest version whose range the installed contract
  satisfies, which requires `sdkApiVersion` in the registry metadata per version
  (marketplace-registry must publish it; not verified where it would come from).
- The host obtains its own value from the constant, never from
  `PLATFORM_VERSION` (hard-coded `'1.0.0'`, `core/registry/src/registry.ts:37`).
- Rejected: using the SDK npm version as the contract (breaks every release, F8);
  a single integer (cannot express "needs a feature added in 1.3").

### D7. Namespace ownership by scope; shadowing is an install-time error

- Ownership is computed in one pure function used by both the installer and the
  registry, from the resolved plugin set (D4): owner of namespace `n` is the
  package that declares `n`; candidates are ordered project scope before platform
  scope, then by explicit priority, and a tie is an error (ADR-0046 rule 3).
  `registerManifests` stops sorting by source priority (`register.ts:137-139`) and
  the trie stops using insertion order (`trie-router.ts:136-140`); the old
  `SOURCE_PRIORITY` is deleted.
- **Install/enable time** (`marketplace-core`, before writing the lock):
  reserved tiers S/V/R and tier F for non-`@kb-labs/*` -> `KB_PLUGIN_NAMESPACE_RESERVED`;
  another package already owns the namespace in the target scope or in the
  platform lock visible from this project -> `KB_PLUGIN_NAMESPACE_TAKEN` (installing a
  different version of the same package is not a collision).
  `marketplace-core` may import `cli-contracts` (plugins depend on cli in the layer
  order); the reserved-namespaces file is not duplicated.
- A machine-level (platform) install cannot know every project's lock; it checks the
  platform lock and, best effort, the locks of registered projects
  (`projects.json`). What still slips through is **drift**: it is resolved by the
  precedence rule at runtime and shown as a hidden-command line in `kb health`
  and `kb plugin doctor` (`KB_PLUGIN_COMMAND_SHADOWED`, already in the catalog), never
  as a debug log (ADR-0046 rule 6).
- Precedence answers the ADR-0012 question "project and platform pin different
  versions": same package id means the project entry replaces the platform entry for
  this project; different packages with one namespace is the collision above.

### D8. Adapters: same installer, no per-project pin

Adapters use the same store layout and installer code path when they are ever
installed from a registry, but stay platform-scope with **one active version per
adapter id** and no project pin. Reasons: they are `import()`ed into the host
process and share one platform container (F7, ADR-0043); a project already selects
its adapter instance and options through config (ADR-0012 §2); a per-project
adapter version would need one process per project, which is model A and out of
scope. Consequence in stage 7: the platform lock's `adapters` map (D3) replaces
`primaryKind: 'adapter'`, and the "project lock first" branch in
`discover-adapters.ts:121-141` is deleted. Adapter contract versions are not part
of this ADR (they are ports, ADR-0021/0039).

### D9. Upgrade, rollback and existing installs (no legacy)

- No compatibility layer. A `kb.marketplace/2` lock is rejected by the new reader
  with `KB_PLUGIN_LOCK_INVALID` and the hint to reinstall; the message is the
  existing behavior class (`marketplace-lock.ts:57-63`, "delete and re-install").
  There is no migrator.
- Platform lock: rewritten by the Go launcher on the next `kb-create update`
  (`lock.go` regenerates it from the plan).
- Project lock: the user (or Studio) runs `kb plugin install <spec>` per plugin; it
  writes a v3 pin and populates the store. Leftovers of the old model
  (`<repo>/node_modules/<plugin>`, entries in the user's `package.json`) are the
  user's files: never deleted automatically; `kb plugin doctor` lists them.
- Upgrading a plugin in a project = `kb plugin update <id>` rewrites one pin; the
  old store entry stays until `gc`. **Rollback is git**: restore the lock and run
  `kb plugin install`; offline it works while the entry is still in the store.
- Platform upgrade that raises the SDK contract major: pins whose range no longer
  matches are disabled for that project at load with `KB_PLUGIN_SDK_INCOMPATIBLE`;
  the fix is `kb plugin update`.

### D10. Multi-tenancy inside one daemon (open question from 03)

Narrowed, not solved: stage 7 does not need it. rest/workflow/mcp stay one process
per project (ADR-0043), so isolation of caches, state and LLM keys is by process.
The only shared process that touches plugin code is the marketplace daemon; D4/D6
remove that by reading static manifests (no JS import at install), leaving it with
no plugin code to run. Isolation inside one process (model A) stays deferred.

## Failure modes and error codes

Existing codes in `core/platform/src/error-envelope/errors.catalog.json`:

| Situation | Code |
|---|---|
| Plugin needs another SDK contract than the host has (install and load) | `KB_PLUGIN_SDK_INCOMPATIBLE` |
| Reserved namespace (tiers S/V/R, F for foreign packages) | `KB_PLUGIN_NAMESPACE_RESERVED` |
| Namespace owned by another package (install/enable) | `KB_PLUGIN_NAMESPACE_TAKEN` |
| Runtime drift: command hidden by ownership rule or a system command | `KB_PLUGIN_COMMAND_SHADOWED` |
| Install failed (network, package manager, not a KB entity) | `KB_PLUGIN_INSTALL_FAILED` |
| Plugin could not be loaded (manifest/dependency problem) | `KB_PLUGIN_LOAD_FAILED` |
| Unknown plugin name in the registry | `KB_PLUGIN_NOT_FOUND` |
| Project `.kb` declaration invalid | `KB_PROJECT_DECLARATION_INVALID` |

**Missing codes to add to the catalog (the task in the "Where" column adds each one):**

| Proposed code | Where | Retryable | Meaning |
|---|---|---|---|
| `KB_PLUGIN_STORE_MISSING` | 7.3 | yes | pinned version is not in the store and could not be restored; run `kb plugin install` |
| `KB_PLUGIN_INTEGRITY_MISMATCH` | 7.2 | no | store entry or downloaded tarball does not match the pinned integrity |
| `KB_PLUGIN_LOCK_INVALID` | 7.3 | no | lock unreadable, wrong schema (including `kb.marketplace/2`), an adapter or `resolvedPath` in a project lock |
| `KB_PLUGIN_PLATFORM_DUPLICATE` | 7.7 (hook, D5) | no | plugin resolved a platform package outside the platform |
| `KB_PLUGIN_MANIFEST_INVALID` | 7.4 | no | the package has no valid static manifest (replaces the free-text `InvalidEntityError`, `marketplace-service.ts:159`) |
| `KB_ADAPTER_PROJECT_SCOPE` | 7.3 | no | adapter placed in a project scope (today the string `MARKETPLACE_ADAPTER_PROJECT_SCOPE`, ADR-0012 §4) |

Other failure modes and their handling: store write interrupted (staging in
`tmp/` plus atomic rename plus `entry.json` written last; leftovers removed by the
next install/gc, ADR-0031 journaling style); two installs racing (`store.lock`,
per-scope mutation queue in `MarketplaceService.withScopeMutation`,
`marketplace-service.ts:371-387`, stays for lock writes); store on another volume
(preflight fails with `KB_INSTALL_*` class error rather than silently copying);
project moved (new projectId, ADR-0044 §3, the lock travels with the repo, the store
does not need to).

## Task breakdown for stage 7

Order: **7.6 -> 7.2 -> 7.7 -> 7.3 -> 7.4 -> 7.5** (7.6 and 7.7 are new; 7.4 can
start in parallel to 7.3 after 7.7). Sizes are engineer-weeks of one person,
assuming stages 0 and 3 are done.

| Task | Size | Content | Depends |
|---|---|---|---|
| 7.6 One discovery on the lock | L | Make CLI discovery use the resolution algorithm D4 in `core-discovery` instead of scanning (`discover.ts`, `register.ts`, `plugins-state.ts` gate); workspace plugins enter as `link` entries; unify enable state; delete duplicated caches. Prerequisite for everything: today two pipelines disagree (F1) | 0.x |
| 7.2 Shared version store | M | Store layout/`entry.json`/`store.lock`/GC (`kb plugin gc`), pnpm installer with dedicated CAS, staging + atomic rename, integrity, static-manifest install path (no JS import), `KB_PLUGIN_INTEGRITY_MISMATCH`; measure dedup on a real registry plugin | 7.6 |
| 7.7 Single platform copy | M | Resolve hook in worker/subprocess/in-process/CLI/daemons, `KB_PLUGIN_PLATFORM_DUPLICATE`, tests with two SDK contracts in one process; verify with a real plugin (for example `commit-entry`) in the worker pool | 7.2 |
| 7.3 Project pin and lock v3 | L | Schema `kb.marketplace/3` reader/writer in `core-discovery`, Go writer (`lock.go`), `check-marketplace-lock.mjs`, helm/docker checks, e2e roots specs, `discover-adapters` cleanup, project install stops running `pnpm add` in the repo, `kb plugin install/update` flows, `KB_PLUGIN_LOCK_INVALID`, `KB_PLUGIN_STORE_MISSING`, `KB_ADAPTER_PROJECT_SCOPE`. Completion: two projects on two versions of one plugin | 7.7 |
| 7.4 SDK contract version | M | `SDK_API_VERSION` in `plugin-contracts` + SDK re-export, `sdkApiVersion` in `ManifestV3` and `dist/manifest.json`, checks at install and load, api-removals gate, registry metadata, template update. Separate follow-up S-M: clear the 34 `plugin-platform-dependency` exceptions | 7.1, 0.3 |
| 7.5 Namespace ownership by scope | M | Pure ownership function, install/enable checks in `marketplace-core`, registry ordering by scope, `kb health`/`kb plugin doctor` lines, retire `SOURCE_PRIORITY` | 7.3 |

Total: about 2 L + 4 M, roughly 8-12 engineer-weeks; 7.6 and 7.3 carry the risk.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | 7.6 changes the discovery every command depends on (1565-line `discover.ts`, 150 ms budget at `discover.ts` end) | do it first, behind the existing e2e roots specs; no new features in the same PR |
| R2 | Lock schema change touches TS, Go, `.mjs` check, helm, docker entrypoints, docs (278 files) | one schema bump, strict reader, Go writer in the same PR, grep-checked list in the task |
| R3 | Resolve hook does not cover all loaders (worker threads, CJS `require`, bundles that inline the SDK) | test matrix per backend in 7.7; `KB_PLUGIN_PLATFORM_DUPLICATE` detection; fallback is the symlink variant (rejected but available) |
| R4 | No real dedup if plugin dependencies come from `file:` tarballs (measured) | require registry resolution for third-party deps; gate on a real measurement |
| R5 | SDK contract becomes a public obligation | api-removals gate, contract bump rules in docs, one owner |
| R6 | Static manifest is not emitted for every plugin/adapter | verify in 7.4 kickoff; failing packages are rejected at install with `KB_PLUGIN_MANIFEST_INVALID` |
| R7 | Windows: pnpm virtual store depth versus MAX_PATH, junction behavior | short `$KB_HOME` on Windows, CI job on Windows before 7.2 is accepted |
| R8 | Registry metadata lacks `sdkApiVersion` per version, so "newest compatible" cannot be computed | marketplace-registry change in 7.4; until then `update` fails safe |
| R9 | First-party plugins still declare the SDK as `dependency` (34 exceptions) | hook makes it non-blocking; clean-up task tracked |

## Not verified in the spike

- Real dedup of a registry plugin's third-party files in the store (no network; the
  prototype used `file:` tarballs).
- The hook inside `worker_threads`, in the subprocess backend and for CommonJS
  plugin bundles; a real plugin (not toy packages) through the hook; real cold-start
  cost of the SDK graph (toy imports took 1.6-4.9 ms).
- Windows behavior (junctions, path length, atomic rename with open handles); only
  macOS/APFS was available.
- That a project-scope install is invisible to CLI discovery (read from code, not
  run end to end); pnpm auto-install-peers producing a second `core-*` tree for a
  project-local plugin (pnpm behavior; only the "peer satisfied locally" duplicate
  was demonstrated).
- That every plugin entry and adapter emits `dist/manifest.json` (the naming lint
  says "build-emitted", but was not run on an unbuilt worktree).
- Where the registry (`marketplace-registry`) would get per-version
  `sdkApiVersion`.

## Go / no-go

**GO, with these conditions.** The idea of variant C survives the code review, but
not as first written. Three things change: (1) the store holds project pins only;
platform scope and adapters stay in the platform pnpm graph (D1, D8); (2) the
single-platform-copy guarantee comes from a resolve hook, not from installation
layout (D5); (3) discovery is unified first (7.6), because today the CLI does not
read the lock the rest of the system reads (F1). **NO-GO** for: per-project adapter
versions, symlink-based peer wiring as the primary mechanism, keeping two discovery
pipelines, any v2-lock compatibility code.

Go/no-go gates inside the stage: before 7.3 starts, 7.7 must show a real plugin
running in the worker pool through the hook with two SDK contract versions; before
7.2 is accepted, real dedup and a Windows run must be measured. If the hook gate
fails, the stage stops and the fallback is variant A (one version per machine)
plus the peer/no-`core-*` lints, which needs none of 7.2-7.7.

## Consequences

### Positive

- No version conflicts between projects and no duplicated plugin installs; nothing
  is written into the user's repository except `.kb/marketplace.lock`.
- The lock becomes a git-friendly declaration; rollback is `git checkout`.
- Incompatible plugins are rejected at install time with a clear error
  (`KB_PLUGIN_SDK_INCOMPATIBLE`, ADR-0049) and disabled, not crashing, after a
  platform upgrade.
- Installing a plugin no longer executes its code in the marketplace daemon.
- One discovery path and deterministic namespace ownership (ADR-0046 rules 2, 3, 6).

### Negative

- Largest change in the migration: discovery, marketplace, module resolution, the Go
  launcher and the lock format all change (about 8-12 engineer-weeks).
- A shared store needs garbage collection and integrity rules; unregistered projects
  are invisible to GC.
- SDK contract versioning is a public compatibility obligation.
- A process-level resolve hook is a new load-bearing mechanism that must be present
  in every process that imports plugin code.

### Alternatives Considered

- **A. Global extensions, enabled per project:** one version per machine; simple, but
  version conflicts between projects. It is the fallback if the hook gate fails.
- **B. Local-only per project:** any versions, but disk duplication, "install
  everywhere" and it writes into the user's repository (F2).
- **Everything, including platform plugins and adapters, in the store:** rejected in
  D1/D8.
- **Store without a package manager (bundled tarballs only):** rejected for now in D2.

## Implementation

Migration stage 7, a separate slice that does not block stages 1-6 and is done
after the project runtime (stage 3). Completion criterion: two projects on
different versions of one plugin work simultaneously; an incompatible plugin is
rejected at install. Stage 0 already covers the lints; boundary lints are PR #480
and the reserved-namespace checks are PR #476. Task breakdown above; tasks
7.6 and 7.7 are new and are recorded in `07-migration.md` and
`10-clickup-tasks.md`.

## References

- [ADR-0012](./0012-platform-project-scope.md), [ADR-0018](./0018-cli-namespace-ownership.md), [ADR-0021](./0021-plugin-services-platform-boundary.md), [ADR-0026](./0026-scoped-plugin-install-and-adapter-role-validation.md), [ADR-0029](./0029-package-manifests-are-the-technical-source-of-truth.md), [ADR-0030](./0030-manifest-cache-and-safe-artifact-resolution.md), [ADR-0031](./0031-deterministic-install-plans-and-recovery.md), [ADR-0032](./0032-config-assembly-and-artifact-intents.md), [ADR-0043](./0043-host-and-project-runtime-topology.md), [ADR-0044](./0044-project-registry-and-project-id.md), [ADR-0046](./0046-command-naming-reserved-namespaces-and-shadowing.md), [ADR-0049](./0049-unified-error-envelope-and-catalog.md)
- PR #479, #480, #476

---

**Last Updated:** 2026-09-26
