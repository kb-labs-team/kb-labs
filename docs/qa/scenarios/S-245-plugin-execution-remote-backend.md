---
id: S-245
title: Plugin execution — remote mode is rejected in the first release
persona: team-admin
area: plugin-execution
priority: P1
status: planned
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

Reject remote execution mode during configuration validation in the first
release, before a backend factory or runtime can fail.

## Prerequisites

- [ ] The first-release config supports in-process, subprocess, worker-pool, and container modes.
- [ ] The config command validates `platform.execution.mode` before saving it.

## Steps

| # | Action | Expected |
|---|---|---|
| S-245.1 | Run `kb config set platform.execution.mode remote --scope platform --json` | Config validation rejects the setting with catalogued `KB_CONFIG_INVALID`, identifies `platform.execution.mode`, and provides the next command `kb config set platform.execution.mode in-process --scope platform`. The setting is not saved, and no runtime factory throw occurs. |

## Decision notes

- D57: “remote (`backend.execute`) is not in the first release.” This case's current-release claim is configuration rejection; remote execution details are roadmap only.
- D46: “An unsupported mode is rejected at config validation.”

## Source

Execution mode config validation is owned by
`core/runtime/src/config-schemas.ts`; user config writes are validated by
`cli/commands/src/commands/system/config/set.ts`. `KB_CONFIG_INVALID` is in
`core/platform/src/error-envelope/error-codes.generated.ts`.
