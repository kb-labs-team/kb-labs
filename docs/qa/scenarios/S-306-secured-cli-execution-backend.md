---
id: S-306
title: Secured CLI uses the configured platform execution backend
persona: team-admin
area: plugin-execution
priority: P1
status: planned
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

Run an installed plugin command under secured access with the configured
isolated backend, without requiring a separately connected execution host.

## Prerequisites

- [ ] A secured platform has the Commit plugin installed and a registered Git project.
- [ ] The administrator can sign in. No host-agent service is started.

## Steps

| # | Action | Expected |
|---|---|---|
| S-306.1 | Sign in as the administrator. Run `kb config set --scope platform platform.execution.mode subprocess --json`, then `kb commit commit --dry-run --json` in the registered project; repeat with `worker-pool`. Run the Commit command once more from a home directory with no saved session. | Both authenticated commands use their configured local isolated backend and return the command result without `KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE`. The command without a session exits nonzero with `KB_AUTH_REQUIRED` before the plugin handler starts. Secured access does not implicitly select Gateway execution. Remote execution mode remains rejected in this release by S-245. |

## Decision notes

- S-240 requires one configured execution mode across every plane; the CLI does not override it based on access mode.
- S-245 rejects `platform.execution.mode=remote` in the current release. An explicit workspace-agent or container topology remains owned by the platform execution backend.

## Source

`cli/bin/src/runtime/bootstrap.ts` authenticates before plugin dispatch and
`cli/runtime/src/v3/execute-command.ts` invokes the shared backend created by
`core/runtime/src/loader.ts`.
