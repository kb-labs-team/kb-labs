# ADR-0044: Project Registry and Project Id

**Date:** 2026-09-26  
**Status:** Proposed  
**Deciders:** KB Labs Team  
**Last Reviewed:** 2026-09-26  
**Tags:** project, registry, state, cli, architecture

## Context

Target architecture (`docs/architecture/target/03-domain-model.md`, `04-topology.md` section 5, items 4 and 7)
makes the project a first-class platform entity: the platform is installed once per machine and knows a set of
projects. Today nothing records which folders are projects, and per-project runtime state (logs, manifest caches,
runtime locks, pids) is mixed into `<repo>/.kb/`, which shows up in the project's `git status`.

Three kinds of state are distinguished:

1. Global (`~/.kb/`): installed platform, project registry, plugin/adapter store.
2. Project declaration (`<repo>/.kb/`, in git): config, enabled plugins and adapters.
3. Project runtime state (outside the repo): `~/.kb/state/<projectId>/`.

There is no host process yet, so the registry must be usable directly from the CLI.

## Decision

1. **One machine-level registry** at `<root>/projects.json`. The root is `$KB_HOME` when set, otherwise `~/.kb`.
   `KB_HOME` exists so tests and development never touch the real home directory.
2. **`projectId` derives deterministically from the canonical absolute path**:
   `prj_` + first 16 hex chars of `sha256(NFC(canonicalPath))`. Canonical means symlinks resolved and the on-disk
   spelling used (`realpath(3)`), no trailing separator; on Windows the path is lower-cased before hashing.
   A symlink, a trailing slash or a different spelling of the same folder therefore yields the same id.
3. **A moved or renamed folder is a new, unknown project by design.** There is no move detection and no id stored
   inside the project. The old entry stays until removed; the new location is registered with `kb project add`.
4. **Entry fields:** `id`, `path`, `name` (unique alias, defaults to the folder name, deduplicated with a numeric
   suffix; an explicit duplicate is an error), `status` (`active` | `disabled`; `disabled` is reserved for the host),
   `addedAt`, `lastUsedAt` (`null` until used). The file carries `schemaVersion` (currently `1`) for future migrations.
5. **Validation is strict and never repairs.** An unreadable or structurally invalid file
   (`KB_PROJECT_REGISTRY_CORRUPT`) and an unknown `schemaVersion` (`KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED`) are typed
   errors; the file is left untouched. Each record's id must match its path.
6. **Atomic writes and a file lock.** Mutations take an exclusive lock file (`projects.json.lock`, created with
   `O_EXCL`, stale locks of dead or long-gone owners are broken), re-read the registry inside the lock, and write via
   temp file + `fsync` + `rename`. Readers take no lock and never see a partial file. A lock that cannot be acquired
   in time fails with `KB_PROJECT_REGISTRY_LOCKED`.
7. **Per-project state path** is `<root>/state/<projectId>/`. This change only adds the path helper; moving existing
   runtime files out of `<repo>/.kb/` is a separate task.
8. **`add` never modifies a project silently.** A folder that already has `.kb/` is picked up as-is. A folder without
   `.kb/` is not registered and gets a typed `initializationRequired` result; `--init` creates the minimal `.kb/`
   through the routine the platform already uses for workspace init (`initWorkspaceConfig`), then registers it.
9. **`remove` only unregisters.** It never deletes the folder, `.kb/` or the runtime state directory, and follows the
   destructive-action protocol (ADR-0025): severity `low`, reversible, confirmed with `--yes`.
10. **Commands** `kb project add | list | show | remove` are system commands (tier S namespace `project`, see
    `06-command-naming.md`), all with `--json`; `add` and `remove` also with `--dry-run`. Errors use the unified error
    envelope and `KB_PROJECT_*` codes from `errors.catalog.json`. They work directly against the registry file; when a
    host exists they become clients of it.
11. **Package placement:** contracts (types, error-code union, `IProjectRegistry`) in `@kb-labs/core-contracts`;
    implementation in the new `@kb-labs/core-project-registry` (depends only on the contracts package); command layer
    in `@kb-labs/cli-commands`.

## Consequences

### Positive

- Projects become addressable by a stable id before any host exists.
- Concurrent CLI, Studio and agent writers cannot corrupt or lose registry entries.
- Runtime state has a defined home outside the repository.

### Negative

- Moving a folder orphans its registry entry and its state directory; the user must re-add and cannot carry state over.
- The registry is machine-local; the same project cloned elsewhere is a different project.
- File locking by lock file is advisory and relies on the same file system semantics for all writers (not for network
  file systems).

### Alternatives Considered

- **Random id stored in `<repo>/.kb/`:** survives moves, but writes into the declaration, breaks for cloned
  repositories (duplicate ids) and needs a conflict policy. Rejected by the author: the path is the identity.
- **Database (SQLite) for the registry:** transactions for free, but a binary dependency for a few dozen rows and
  harder to inspect by hand. Rejected.
- **Registry owned by the host only:** the CLI would have no way to register a project before a host exists.

## Implementation

- `core/contracts/src/project-registry.ts`, `core/project-registry/`, `cli/commands/src/commands/system/project/`.
- New catalog codes: `KB_PROJECT_NAME_TAKEN`, `KB_PROJECT_REGISTRY_CORRUPT`, `KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED`,
  `KB_PROJECT_REGISTRY_LOCKED`.
- Runtime-state move (task 1.3): `resolveProjectStateDir` and `resolveRuntimeStatePath` are in
  `core/project-registry/src/state-dir.ts`. There is no fallback to the old in-repo location; files left there are
  ignored. Adapter defaults under `.kb/` moved to the state directory when the user sets no path. The inventory and
  the paths that remain are in `docs/architecture/target/13-runtime-state-inventory.md`.
- Follow-ups: move kb-dev logs and pids (see the inventory) to `state/<projectId>/`; wire `--init` to the future init flow; host takes over the
  registry; reserve `project` in the namespace list.

## References

- `docs/architecture/target/03-domain-model.md`, `04-topology.md`, `06-command-naming.md`, `08-errors.md`
- [ADR-0025: Destructive-action protocol](./0025-destructive-action-protocol.md)

---

**Last Updated:** 2026-09-26
