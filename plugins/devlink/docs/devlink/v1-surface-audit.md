# DevLink v1 Surface Audit

This document captures the public surfaces of `@kb-labs/devlink` that we keep for the v1 contract migration. It is aligned with the contract definitions in `@kb-labs/devlink/contracts` and the runtime in `packages/core/src` (November 2025).

## CLI Commands

All commands are registered through the manifest derived from `@kb-labs/devlink/contracts`. The table summarises the public flags that must remain stable.

- `devlink:plan` → `./cli/plan#run` — plan workspace linking operations
  - Flags: `cwd`, `json`, `container`, `mode`, `roots`, `strict`
  - Produces: `devlink.plan.latest`
- `devlink:apply` → `./cli/apply#run` — apply the latest plan to manifests
  - Flags: `cwd`, `json`, `yes`, `dry-run`
  - Produces: `devlink.journal.apply`
- `devlink:status` → `./cli/status#run` — report current workspace status
  - Flags: `cwd`, `json`, `verbose`, `sources`, `diff`, `roots`, `consumer`, `warning-level`
- `devlink:freeze` → `./cli/freeze#run` — freeze manifests into the lock file
  - Flags: `cwd`, `json`, `merge`, `dry-run`
  - Produces: `devlink.journal.freeze`
- `devlink:undo` → `./cli/undo#run` — undo the latest apply operation
  - Flags: `cwd`, `json`, `dry-run`
- `devlink:switch` → `./cli/switch#run` — plan and apply in the requested mode (`npm`, `local`, `auto`)
  - Flags: `cwd`, `json`, `mode`, `yes`, `dry-run`
- `devlink:update` → `./cli/update#run` — update dependencies using the selected mode pipeline
  - Flags: `cwd`, `json`, `mode`, `yes`, `dry-run`
- `devlink:watch` → `./cli/watch#run` — watch the workspace and auto-apply plan deltas
  - Flags: `cwd`, `json`, `mode`, `verbose`, `dry-run`
- `devlink:clean` → `./cli/clean#run` — clean DevLink artifacts and caches
  - Flags: `cwd`, `json`, `hard`, `deep`
- `devlink:backups` → `./cli/backups#run` — list and manage structured backups
  - Flags: `cwd`, `json`, `list`, `show`, `protect`, `unprotect`, `cleanup`, `dry-run`

These commands form the minimal v1 CLI surface and must stay in sync between the manifest, contract schemas, and the runtime handlers.

## REST Surface

- `GET /v1/plugins/devlink/plan` handled by `./rest/handlers/plan-handler.ts#handlePlan`
  - Request schema: `PlanRequestSchema` (internally the same instance as `DevlinkPlanRequestSchema`)
  - Response schema: `PlanResponseSchema` (`DevlinkPlanResponseSchema`)
  - Supported `view` values are enumerated by `PlanViewSchema` (`overview`, `overview.actions`, `overview.diagnostics`, `dependencies.tree`, `dependencies.table`)
  - Unknown views must return the canonical `DEVLINK_PLAN_WIDGET_UNKNOWN` error payload; other validation issues return `DEVLINK_PLAN_INVALID_INPUT`

## Studio Surface

- Widgets backed by the plan REST route:
  - `devlink.overview` (`infopanel`)
  - `devlink.actions` (`chart`)
  - `devlink.dependencies` (`tree`)
  - `devlink.packages` (`table`)
- Menus:
  - `devlink-overview`, `devlink-actions`, `devlink-dependencies`, `devlink-packages`

All widgets fetch data via the plan route and rely on contract IDs `plan?view=<PlanViewSchema option>`.

## Artifacts

- `devlink.plan.latest` → `.kb/devlink/last-plan.json`
- `devlink.journal.apply` → `.kb/devlink/last-apply.json`
- `devlink.journal.freeze` → `.kb/devlink/last-freeze.json`
- `devlink.backups.metadata` → `.kb/devlink/backups/{ts}/metadata.json`

These artifacts are referenced by CLI handlers, the manifest, and downstream tooling via the contract manifest.

## API Facade

Public API symbols exported from `packages/core/src/api/index.ts` (facade backed by `packages/core/src/application/api/facade`):

- Commands: `scanAndPlan`, `apply`, `freeze`, `applyLockFile`, `undo`, `status`, `watch`
- Types: `DevLinkPlan`, `DevLinkPolicy`, `DevLinkMode`, `LinkAction`, `LinkActionKind`, `StatusReport`, `StatusReportV2`, `DevLinkWatcher`, `WatchEvent`, `DryRunResult`

These exports bridge runtime functionality to consumers and must stay contract-stable for v1.


