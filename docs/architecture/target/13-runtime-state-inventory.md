# 13. Per-project runtime state inventory (task 1.3)

Goal: the project's `git status` shows no runtime files. Runtime state moves from `<repo>/.kb/` to
`<KB_HOME or ~/.kb>/state/<projectId>/`; the declaration (`kb.config.*`, `marketplace.lock`, plugins list,
workflows, overlays) stays in `.kb/`. See ADR-0044 and `03-domain-model.md` (three kinds of state).

## Resolver

`resolveProjectStateDir(projectRoot, { root?, env? })` in `@kb-labs/core-project-registry`
(`core/project-registry/src/state-dir.ts`).

- The id is `deriveProjectId(canonical path)`. A registered project's id is by definition the same value
  (ADR-0044, the entry id must match its path), so registered and unregistered projects share one directory and
  registering later does not orphan state. The registry file is not read.
- Symlinks and trailing separators are canonicalized; a folder that does not exist yet is canonicalized through its
  nearest existing ancestor.
- `KB_HOME` is respected. Nothing is created by the resolver.
- `resolveRuntimeStatePath(root, segments)` gives `{ path, legacyPath }`. Writers use `path`. Readers use
  `resolveRuntimeReadPath`: new file if it exists, else the legacy `<root>/.kb/<segments>` file if it exists.
- Legacy fallback lasts one release. After it is removed, old in-repo files are ignored (no migration, no deletion).

## Inventory

Class `state` = runtime state, `declaration` = stays in `.kb/`. Decision: **moved** (this change), **deferred**
(state, but not moved here, reason given), **stays**, **out of scope**.

| Path | Writer | Reader | Class | Decision |
| --- | --- | --- | --- | --- |
| `.kb/cache/cli-manifests.json` | `cli/commands/src/registry/discover.ts` (`saveCache`) | `discover.ts` (`loadCache`), `commands/system/diag.ts`, `marketplace plugins refresh` (delete) | state | **moved**; read fallback to legacy; `refresh` deletes both |
| `.kb/cache/registry.json`, `registry.prev.json` | `core/registry/src/snapshot/snapshot-manager.ts` | same | state | **moved**; read fallback to legacy |
| `plugins/*/.kb/cache/*`, `sdk/sdk/.kb/cache/*`, `services/*/.kb/cache/*`, `tools/*/.kb/cache/*` | the two writers above, run with a package as cwd | same | state | files were tracked by mistake; **untracked** (`git rm --cached`); they are ignored via `plugins/**/.kb/` etc. |
| `plugins/host-agent/entry` build script unlinks `../../../.kb/cache/cli-manifests.json` | build hook | none | state | **deferred**: only clears the legacy file. The cache self-invalidates by manifest integrity, so a stale entry is not served. Replace with `kb marketplace plugins refresh` in a follow-up |
| `.kb/logs/tmp/*`, `.kb/tmp/*` (kb-dev `logs_dir`, `pid_dir`, net-offset cache) | `tools/kb-dev` (Go, `config/defaults.go`) | kb-dev, `shared/testing-e2e` | state | **deferred**: pid files must not be split across an upgrade while services run, and kb-dev is a separately versioned Go binary. Needs its own change with a stop-old/start-new step. `kb logs` does not read these files (it queries `platform.logs`) |
| `.kb/logs/*` install transcript | `tools/kb-create/v2/logs/transcript.go` (platform root) | humans | state | **deferred**: platform-level install log, not project state |
| logs database `.kb/database/kb.sqlite` (`documentDatabase`, `kvStore`, `logs`) | sqlite adapter, path from `kb.config` adapter options | `kb logs *` via `platform.logs` | state (config-declared) | **deferred**: the path is adapter configuration (declaration), and the same file backs non-log data; moving it needs a config-level decision (task 1.x config layers) |
| `.kb/analytics/*` | analytics-file/sqlite/duckdb adapters (config default) | `plugins/agents` quality-report | state (config-declared) | **deferred**: same as above; already git-ignored |
| `.kb/runtime/workspaces`, `.kb/runtime/workspace-registry`, `.kb/runtime/snapshots` | workspace-*/snapshot-localfs adapters, `plugin-execution-factory/target-resolver.ts` | same | state (config-declared) | **deferred**: adapter defaults; now git-ignored (`.kb/runtime/`) |
| `.kb/traces/incremental/*` | `plugins/agents` (`incremental-trace-writer`, run/spec handlers) | `trace-loader` | state | **deferred**: plugin-owned; now git-ignored (`.kb/traces/`) |
| `.kb/run-artifacts/`, `.kb/agents/sessions/`, `.kb/memory/sessions/`, `.kb/commit/`, `.kb/mind/`, `.kb/devkit/`, `.kb/bundle/`, `.kb/verdaccio/*` | plugins / kb-dev services | plugins | state | **deferred**: plugin-owned, already git-ignored |
| `.kb/output` | `plugin-execution-factory` (outdir default) | plugins | state | **deferred** (plugin output default) |
| `.kb/kb.config.*`, `.kb/overlays/`, `.kb/marketplace.lock`, `.kb/marketplace.manifests.json`, `.kb/plugins.json`, `.kb/workflows/`, `.kb/deploy*`, `.kb/devservices*.yaml` | config, marketplace, kb-create | config loader, discovery | declaration | **stays** |
| `.kb/lock.json` (`core/config/src/lockfile`, `core/bundle`) | `upsertLockfile` | config | declaration | **stays** (its own ignore rule is managed by `kb init`) |
| `.kb/release/*` (plans, candidates, history, staging) | release plugin | release plugin | release tooling state | **out of scope** (separate concern) |
| Dev monorepo | `KB_PLATFORM_ROOT` semantics (ADR-0012) are unchanged; the moved caches are keyed by the `cwd` the CLI is run from |

## Follow-ups

1. kb-dev `logs_dir` / `pid_dir` defaults into the state directory (Go), with a safe cut-over.
2. Adapter-default paths (`.kb/database`, `.kb/analytics`, `.kb/runtime`): decide where such defaults are computed
   (state directory unless the user sets an explicit path).
3. Agents traces and `.kb/output`.
4. Remove the legacy read fallback one release after this change.
