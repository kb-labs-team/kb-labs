# ADR-0044: Project Registry and Project Id

**Date:** 2026-09-26  
**Status:** Accepted
**Deciders:** KB Labs Team  
**Last Reviewed:** 2026-09-29
**Tags:** project, registry, state, cli, architecture

## Context

The platform manages projects registered on the local machine. A project has a mutable filesystem path, user-facing metadata, a stable machine-local identity, and runtime state stored outside its repository.

Three kinds of state are distinguished:

1. Global (`~/.kb/`): installed platform, project registry, plugin/adapter store.
2. Project declaration (`<repo>/.kb/`, in git): config and enabled plugins/adapters.
3. Project runtime state (outside the repo): `~/.kb/state/<projectId>/`.

The project path can change when a folder is moved or checked out elsewhere. It therefore cannot define project identity.

## Decision

1. **One machine-level registry** at `<root>/projects.json`. The root is `$KB_HOME` when set, otherwise `~/.kb`.
2. **Opaque stable project ID:** create a random `prj_` ID when the registry record is created. Never derive it from the path. Path changes preserve the ID, metadata, and state directory.
3. **Strict registry schema:** records require `id`, `path`, `name`, `title`, `description`, `status`, `addedAt`, and `lastUsedAt`. The schema version is `2`. Version 1 and other formats are unsupported; do not migrate or maintain compatibility with them.
4. **Mutable canonical path:** updates resolve and validate the replacement directory, reject paths already owned by another record, and atomically update the existing record. This also restores a moved project by pointing its existing record at the new location.
5. **Validation is strict and never repairs.** Invalid files and unsupported schema versions are typed errors; the registry is left untouched.
6. **Atomic writes and a file lock.** Mutations take an exclusive lock, re-read the registry inside the lock, and write via temp file + `fsync` + `rename`.
7. **Per-project state path** is `<root>/state/<projectId>/`. Managed runtimes receive the stable ID explicitly. CLI project commands resolve a registered project from `cwd`, including nested directories. Unregistered developer workspaces may use an isolated deterministic fallback ID until registered.
8. **Add and create are explicit.** Connecting an existing folder does not modify it silently. A folder without `.kb/` requires explicit initialization. Creating a new project makes a new directory, initializes it through `initWorkspaceConfig`, and registers it through the shared domain operation.
9. **Remove only unregisters.** It does not delete the folder, `.kb/`, or runtime state.
10. **Host owns machine operations; REST exposes them to Studio.** Gateway may authenticate and proxy requests but does not own project business logic. CLI and Host use the same registry/domain operations.
11. **Project UI:** project records have a title and description; Studio persists an active project selection, shows it in the sidebar, and supplies its ID to project-scoped operations.
12. **Package placement:** contracts in `@kb-labs/core-contracts`; registry and operations in `@kb-labs/core-project-registry`; CLI and Host are callers.

## Consequences

### Positive

- Moving a project preserves its identity and project runtime state.
- The active Studio project and CLI `cwd` resolution refer to the same registry record.
- CLI and REST callers share validation and file-system operations.

### Negative

- The registry is machine-local; a cloned project on another machine is a separately registered project.
- The old schema is deliberately unsupported. Users must create a fresh registry rather than rely on an implicit migration.
- Native folder selection in a browser requires a supported local bridge; a browser directory handle alone does not reveal the host path.

## Alternatives Considered

- **Derive ID from the canonical path:** rejected because moving a folder changes identity and orphans runtime state.
- **Store ID in the project declaration:** rejected because it changes repository files and cloned repositories can duplicate IDs.
- **Database (SQLite):** unnecessary for the current registry size; JSON remains inspectable and is protected by atomic writes and locking.
- **Registry owned only by Host:** rejected because CLI must work before a Host is running.

## Implementation

- Contracts: `core/contracts/src/project-registry.ts`.
- Registry and shared operations: `core/project-registry/`.
- Host REST routes: `services/host/app/src/projects-routes.ts`.
- Runtime routing: `services/host/app/src/project-runtime/` and `services/project-runtime/app/`.
- Studio project UI and data client: `studio/app/` and `studio/data-client/`.

## References

- `docs/architecture/target/03-domain-model.md`
- `docs/architecture/target/13-runtime-state-inventory.md`
- `docs/architecture/target/15-project-management-plan-and-acceptance.md`
- [ADR-0025: Destructive-action protocol](./0025-destructive-action-protocol.md)
