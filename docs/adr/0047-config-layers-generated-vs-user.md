# ADR-0047: Config Layers, Generated vs User, One Writer per File

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** architecture, configuration, installer, cli

## Context

Users are not expected to write config by hand, yet today topology is
hand-written: `adapterOptions.serviceTransport.services` with `127.0.0.1:5050`
sits in `kb.config.jsonc`. Runtime state (`lock.json`, `cli-manifests.json`)
is mixed into `<repo>/.kb/` and shows up in `git status`. Only `config show`
exists; strict schema validation covers only `ExecutionConfig`, while adapters
already have a `configSchema` in their manifests (for example
`adapters/openai/src/manifest.ts`). ADR-0032 defines config assembly by the
installer and ADR-0028 established that humans and agents change state through
the same operation.

Source: `docs/architecture/target/04-topology.md` (decision 9) and
`07-migration.md` stage 5.

## Decision

The config remains a **file** (source of truth: git, review), but nobody edits
it by hand. There are three layers:

1. **Generated** (topology, ports, service URLs, paths): created by the installer/host into `.kb/generated/`; the user does not see or edit it. Service topology and URLs are derived from the install plan and disappear from the hand-written config.
2. **User choices** (adapters and their options, enabled plugins, keys): edited through Studio forms built from manifest `configSchema`, or via `kb config`. Secrets are references to env/secret store, never values in the file.
3. **Project overrides**: the same UI/commands, written into `<repo>/.kb/`.

**One writer per file** (rule 6 of ADR-0045): the installer writes only
generated files; `config patch` writes only user files. UI and agent edit the
file through one operation, `config patch` with schema validation (as in
ADR-0028).

**Commands:** `kb config get | set | show` (naming per ADR-0046), atomic write
with file lock, validated against the schema. Schemas are added for platform
config sections. Runtime state (logs, manifest caches, runtime locks) moves out
of the repository to `~/.kb/state/<projectId>/`.

**Not in the first version:** a universal editor of the entire config. Only
adapters (choice, options, keys) and plugin enabling are editable through the
UI; everything else is generated or stays a file.

## Consequences

### Positive

- New project configured without hand-editing JSON; `git status` no longer shows runtime files.
- Installer and user commands cannot overwrite each other.

### Negative

- Two configuration sources to explain and merge; a merge/precedence rule must be specified.
- Conflicting external edits must be handled (`KB_CONFIG_CONFLICT`, see ADR-0049).
- Requires schemas for platform config sections that have none today.

### Alternatives Considered

- **Universal config editor for everything:** rejected for the first version (see scope above).
- **Keep the single hand-written file:** rejected; topology stays manual and mixes with user choices.

## Implementation

Migration stage 5 (config layers and commands), building on stage 1 (state
directory per project; ADR-0044 owns the registry). Config errors use the envelope
of ADR-0049.

### Precedence and provenance (implemented)

Lowest to highest; a higher layer wins per key (objects deep-merge, arrays concatenate across generated/platform/project, overlays replace arrays):

1. **generated**: `<root>/.kb/generated/*.json|jsonc` (platform root first, then project root, files in lexicographic order). Written only by the installer/host.
2. **platform** user config: `<platformRoot>/.kb/kb.config.jsonc`.
3. **project** user config: `<projectRoot>/.kb/kb.config.jsonc` (project wins over platform, ADR-0012).
4. **overlay**: `<projectRoot>/.kb/overlays/*.jsonc` (scenario overlays).

`loadEffectiveConfig` (`@kb-labs/core-config`) returns `provenance`: for every leaf, the layer and file that supplied it. `kb config get` and `kb config show` print it. `kb config set --scope platform|project` (default `project`) is the only writer of the user files; it never touches `.kb/generated/`. The generated layer is optional: an install without it loads exactly as before.

### Open questions

- ~~Precedence between generated, user and project-override layers is not specified in the notes.~~ Resolved by the stage 5 loader, see "Precedence and provenance" below.
- Location and format of the secret store referenced by config values.
- Whether the file names `.kb/generated/` and `kb.config.jsonc` are final.

## References

- [ADR-0012](./0012-platform-project-scope.md), [ADR-0028](./0028-human-and-agent-frontends-share-the-engine.md), [ADR-0032](./0032-config-assembly-and-artifact-intents.md), [ADR-0035](./0035-breaking-cutover-for-the-new-installer-contract.md), [ADR-0045](./0045-executables-roles-and-launcher-control-channel.md), [ADR-0046](./0046-command-naming-reserved-namespaces-and-shadowing.md), [ADR-0049](./0049-unified-error-envelope-and-catalog.md)

---

**Last Updated:** 2026-09-26
