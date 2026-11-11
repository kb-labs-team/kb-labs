# ADR-0052: Platform-Owned Project Plugin Settings

**Date:** 2026-10-01  
**Status:** Accepted  
**Deciders:** KB Labs Team  
**Tags:** projects, configuration, plugins, cli, studio

## Context

Registered projects are platform entities identified by `projectId`; their
membership does not depend on files in the repository (ADR-0044, S-043,
S-124). Project plugin attachments are scoped to a project, while adapter
bindings and options belong to the platform (ADR-0012, S-048). Plugin settings
still need project-specific values, and storing them in `.kb/kb.config.*`
would make repository files part of platform configuration again.

The current SDK and V3 manifest expose `configSection` and runtime `useConfig`
for reading plugin configuration. The manifest has `SchemaRef` for REST input
and output contracts, but no plugin settings schema declaration or generic
settings editor. `configSchema` exists on adapter manifests and is used for
adapter option validation; it is not a plugin settings contract. There is no
`defineSettings` API in the SDK.

## Decision

1. **Store project configuration on the platform.** Active project plugin
   settings live in the platform state directory at
   `$KB_HOME/state/<projectId>/config.jsonc` (with `$KB_HOME` defaulting to
   `~/.kb`). They are selected by the project registry ID, never by reading a
   file from the repository. Plugin installation/attachment remains project
   scoped; adapters remain platform only.
2. **Resolve settings in this order:** plugin-declared defaults → platform
   plugin defaults → project settings. Objects deep-merge; arrays and scalar
   values at a higher layer replace lower-layer values. The effective value
   and its source are available through the CLI and plugin runtime.
3. **Declare plugin settings schemas in the manifest.** No suitable plugin
   settings API currently exists. Add an optional manifest declaration with a
   JSON Schema or Zod `SchemaRef` (the existing reference type used by REST
   contracts) and optional defaults. Keep `configSection` as the namespace
   used by `useConfig`; do not reuse adapter `configSchema`. Studio forms and
   CLI writes validate against the same resolved plugin declaration.
4. **Keep the existing CLI surface.** `kb config get <key> [--scope
   platform|project]`, `kb config set <key> <value> [--scope
   platform|project]`, and `kb config show` address plugin settings under
   `plugins.<configSection>.*`. The default scope is the project resolved from
   cwd; `--scope platform` edits shared platform defaults. `get` without a
   scope reports the effective value and provenance. Project scope requires a
   registered project; errors use the ADR-0049 envelope.
5. **Edit in Studio through project context.** The user selects a registered
   project, opens an attached plugin's settings, edits a field rendered from
   its manifest schema, and saves into that project's platform-owned config.
   Studio and CLI share the validation and precedence rules.
6. **Reject invalid settings before writing.** Return
   `KB_PLUGIN_SETTINGS_INVALID` with the setting path, schema validation cause,
   and a hint to correct the value using the plugin's declared settings
   schema. Keep the prior effective value on failure.
7. **Do not read `.kb/kb.config.*` in project repositories.** Remove the
   project-config reader and writer paths without compatibility fallback or
   migration from repository files. The repository remains untouched by
   registration, plugin settings edits, and project switching.
8. **Archive configuration on project removal.** `kb project remove` moves the
   active config to `$KB_HOME/state/archive/projects/<projectId>/config.jsonc`
   alongside unregistering the project. It is inactive while unregistered.
   Re-registering the same canonical path restores it because project IDs are
   deterministic (ADR-0044). This retains the existing reversible removal and
   avoids silently losing user choices.

## Migration streams

Each stream owns the listed paths; the streams do not edit one another's
files. They are based on the remaining `.kb` dependents inventory in
`reports/g42-installproject.md`.

1. **Project config store and command contract:**
   `core/config/src/api/read-config.ts`, `core/config/src/api/read-kb-config.ts`,
   `core/config/src/api/init-workspace.ts`, `core/config/src/user-config/`,
   `core/config/src/overlay/`, `core/config/src/api/effective-config.ts`,
   `core/config/src/api/product-config.ts`, `core/config/src/lockfile/`,
   `core/config/src/api/upsert-lockfile.ts`,
   `core/config/src/utils/paths.ts`, `core/config/src/runtime/runtime.ts`,
   `core/runtime/src/config-loader.ts`, `core/runtime/src/config-schemas.ts`,
   `core/runtime/src/index.ts`, `core/plugin-contracts/src/manifest.ts`, and
   `cli/commands/src/commands/system/config/`. Add the platform-owned
   per-project store, manifest settings-schema validation, shared effective
   config resolution, and `KB_PLUGIN_SETTINGS_INVALID` here.
2. **Project identity, discovery, and plugin scope:**
   `core/workspace/`, `core/project-registry/src/registry.ts`,
   `cli/commands/src/commands/system/project/show.ts`,
   `services/marketplace/core/src/scope.ts`,
   `cli/commands/src/commands/system/marketplace/scope.ts`, `core/discovery/`,
   `core/runtime/src/platform-sync.ts`,
   `core/runtime/src/discover-adapters.ts`,
   `cli/commands/src/commands/system/platform/sync.ts`. Resolve project roots
   from the registry and keep plugin attachment project scoped. The synthetic `.kb`
   symlink in the platform extension store remains platform-local; it is not a
   consumer repository file.
3. **Marketplace and plugin-install state:**
   `services/marketplace/core/src/manifest-cache.ts`,
   `cli/commands/src/commands/system/marketplace/commands/sync.ts`,
   `cli/scaffold/core/src/doctor/scan.ts`,
   `cli/commands/src/registry/plugins-state.ts`,
   `core/registry/src/snapshot/`, and `core/registry/src/state/`.
   Move project lock and plugin state into platform state keyed by project ID.
4. **Project runtime and adapter data:**
   `core/runtime/src/default-adapters.ts`, `core/platform/src/learning/`,
   `core/plugin-runtime/src/context/context-factory.ts`,
   `core/plugin-runtime/src/runtime/fs-shim.ts`,
   `adapters/analytics-sqlite/scripts/migrate-from-jsonl.mjs`,
   `adapters/analytics-duckdb/scripts/migrate-from-jsonl.mjs`,
   `plugins/devlink/src/core/backup/`, and `plugins/devlink/src/core/state/`.
   Use the platform project state directory for runtime defaults and retain
   explicit user-selected repository output paths.
5. **Workflow and agent state:**
   `services/workflow/entry/src/commands/`,
   `services/workflow/runtime/src/`, `services/workflow/engine/src/`,
   `services/workflow/daemon/src/`, `plugins/agents/src/core/`,
   `plugins/agents/tools/src/`, `plugins/agents/src/cli/commands/diff.ts`,
   and `plugins/agents/store/src/`. Move definitions, caches, sessions and
   plugin state to project-scoped platform storage; leave Git-tracked workflow
   inputs only where the workflow product contract requires repository files.
6. **Plugin-owned data and workspace permissions:**
   `plugins/review/src/core/`, `plugins/review/src/llm/`,
   `plugins/release/src/core/`, `plugins/release/src/cli/`,
   `plugins/agents/src/`,
   `cli/scaffold/core/src/engine.ts`,
   `plugins/agents/src/cli/commands/snapshot.ts`,
   `plugins/commit/src/contracts/env.ts`,
   `plugins/agents/src/lifecycle/setup.ts`,
   `plugins/qa/src/contracts/constants.ts`,
   `plugins/quality/src/contracts/constants.ts`,
   `services/host-agent/fs/`, `plugins/agents/src/manifest.ts`, and
   `plugins/agents/src/manifest.ts`. Give each plugin project-scoped
   state through platform services; revise repository filesystem permissions
   to match each plugin's remaining user-file behavior.
7. **Developer and deployment tools:**
   `tools/kb-dev/internal/config/`, `tools/kb-dev/internal/scenario/`,
   `tools/kb-deploy/internal/config/`, `tools/kb-deploy/cmd/helpers.go`,
   `tools/kb-monitor/internal/config/`,
   `tools/kb-devkit/internal/engine/scheduler.go`,
   `tools/kb-devkit/internal/cache/`. Move tool config, logs, overlays, and
   caches out of consumer repositories where they are platform or machine
   state.
8. **Studio project settings surface:**
   `studio/app/src/modules/projects/`,
   `studio/app/src/modules/project-plugins/`,
   `studio/app/src/modules/settings/`, and
   `plugins/agents/src/studio/`. Add schema-rendered plugin settings for
   the selected project and route saves through the same platform config
   service as the CLI.

## Consequences

- Project settings follow the platform registry and cannot dirty or depend on
  the user's repository.
- The platform must validate settings from plugin manifests and expose the
  same effective config to CLI, Studio, and plugin runtime.
- Removing a project archives its settings; deterministic re-registration
  restores the previous configuration.

## References

- [ADR-0012](./0012-platform-project-scope.md)
- [ADR-0044](./0044-project-registry-and-project-id.md)
- [ADR-0047](./0047-config-layers-generated-vs-user.md)
- [ADR-0049](./0049-unified-error-envelope-and-catalog.md)
- [ADR-0050](./0050-product-cases-are-the-specification.md)
- [S-204](../qa/scenarios/S-204-project-plugin-settings.md)
- [g42 remaining `.kb` dependents inventory](../../reports/g42-installproject.md)
