# 13. Per-project runtime state inventory (task 1.3)

Goal: the project's `git status` shows no runtime files. Runtime state lives in
`<KB_HOME or ~/.kb>/state/<projectId>/`; the declaration (`kb.config.*`, `marketplace.lock`, plugins list,
workflows, overlays) stays in `.kb/`. See ADR-0044 and `03-domain-model.md` (three kinds of state).

## Resolver

`resolveProjectStateDir(projectRoot, { root?, env? })` and `resolveRuntimeStatePath(projectRoot, segments)` in
`@kb-labs/core-project-registry` (`core/project-registry/src/state-dir.ts`).

- The id is `deriveProjectId(canonical path)`. A registered project's id is by definition the same value
  (ADR-0044, the entry id must match its path), so registered and unregistered projects share one directory and
  registering later does not orphan state. The registry file is not read.
- Symlinks and trailing separators are canonicalized; a folder that does not exist yet is canonicalized through its
  nearest existing ancestor.
- `KB_HOME` is respected. Nothing is created by the resolver; writers create the directories they need.
- There is no fallback to the old in-repo location: files an earlier version left in `<project>/.kb/` are never
  read and never deleted.
- Adapter defaults use it only when the user configured no path. An explicit path (absolute, or relative to the
  project) is used exactly as before.

## Inventory

Class `state` = runtime state, `declaration` = stays in `.kb/`.

| Path (now under `<state dir>/`) | Writer | Reader | Class | Status |
| --- | --- | --- | --- | --- |
| `cache/cli-manifests.json` | `cli/commands` `discover.ts`, via `manifest-cache-path.ts` | `discover.ts`, `diag.ts`; `marketplace plugins refresh` deletes it | state | moved |
| `cache/registry.json`, `registry.prev.json` | `core/registry` `snapshot-manager.ts` | same | state | moved |
| `analytics/analytics.sqlite` | `adapters/analytics-sqlite` (default) | same; `plugins/agents` `quality-report` | state | moved |
| `analytics/analytics.duckdb` | `adapters/analytics-duckdb` (default) | same | state | moved |
| `analytics/buffer/` | `adapters/analytics-file` (default `baseDir`) | same; `quality-report` | state | moved |
| `runtime/workspaces`, `runtime/workspace-registry` | `adapters/workspace-localfs`, `adapters/workspace-agent` (defaults) | same, `snapshot-localfs`, `core/plugin-execution-factory` `target-resolver.ts` | state | moved |
| `runtime/snapshots` | `adapters/snapshot-localfs` (default) | same | state | moved |
| `traces/incremental/*` | `plugins/agents` `IncrementalTraceWriter`, run and generate-spec handlers | `loadTrace` and the trace commands | state | moved |
| `plugins/*/.kb/cache/*`, `sdk/sdk/.kb/cache/*`, `services/*/.kb/cache/*`, `tools/*/.kb/cache/*` | old versions of the two cache writers | none | state | files were tracked by mistake; untracked |
| `plugins/host-agent/entry` build script that unlinked `../../../.kb/cache/cli-manifests.json` | build hook | none | state | hook removed: it only cleared the old file, and the cache self-invalidates by manifest integrity |
| `.kb/logs/tmp/*`, `.kb/tmp/*` (kb-dev `logs_dir`, `pid_dir`, net-offset cache) | `tools/kb-dev` (Go) | kb-dev, `shared/testing-e2e` | state | **remains**, see below |
| `.kb/logs/*` install transcript | `tools/kb-create/v2/logs/transcript.go` (platform root) | humans | state | **remains**: install log of the platform, not of a project |
| `.kb/database/kb.sqlite` (`documentDatabase`, `kvStore`, `logs`) | sqlite adapters, path from the adapter options in `kb.config` | `kb logs *` via `platform.logs` | config-declared | **remains**: the adapters have no default, the path is written in the user's config (declaration). Changing it is a config change, not an adapter default |
| `.kb/run-artifacts/`, `.kb/agents/sessions/`, `.kb/memory/sessions/`, `.kb/commit/`, `.kb/mind/`, `.kb/devkit/`, `.kb/bundle/`, `.kb/verdaccio/*`, `.kb/output` | plugins and kb-dev services | plugins | state | **remains**: plugin-owned paths; already git-ignored |
| `.kb/kb.config.*`, `.kb/overlays/`, `.kb/marketplace.lock`, `.kb/marketplace.manifests.json`, `.kb/plugins.json`, `.kb/workflows/`, `.kb/deploy*`, `.kb/devservices*.yaml`, `.kb/lock.json` | config, marketplace, kb-create | config loader, discovery | declaration | stays |
| `.kb/release/*` | release plugin | release plugin | release tooling state | out of scope (separate concern) |

Dev monorepo: `KB_PLATFORM_ROOT` semantics (ADR-0012) are unchanged; state is keyed by the `cwd` or workspace `cwd`
the process runs with.

## What remains and why

- **kb-dev logs and pids** (`tools/kb-dev`, Go): pid files decide which running services kb-dev can stop or
  reconcile. Moving them without a fallback would orphan services that are running while the binary is upgraded,
  and the location is also read by `shared/testing-e2e` and the devservices templates. Needs its own change with a
  stop-before-upgrade step.
- **kb-create transcript**: platform-level install log.
- **Config-declared and plugin-owned paths** (table above): not adapter defaults, so the resolver is not applied.

## Follow-ups

1. kb-dev `logs_dir` / `pid_dir` into the state directory.
2. Templates written by kb-create should stop declaring `.kb/database/...` and rely on a state-directory default
   for the sqlite adapters.
