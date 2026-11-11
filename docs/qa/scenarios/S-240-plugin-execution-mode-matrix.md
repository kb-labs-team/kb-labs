---
id: S-240
title: Plugin execution — one resolved mode across every plane
persona: solo-developer
area: plugin-execution
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [cli, api, agent]
---

## Goal

Run the same fixture command through every execution plane and observe the
same configured and resolved backend, result, structured logs, and error
contract.

## Prerequisites

- [ ] A fixture plugin exposes one deterministic command through CLI, REST, REST WebSocket, workflow, Gateway webhook, and MCP entry points. It has success and catalogued-failure outcomes.
- [ ] The platform can be restarted in `in-process`, `subprocess`, `worker-pool`, and `container` modes; container mode has its required environment adapter.
- [ ] The fixture log includes plugin ID, command path, and request ID. Each plane exposes its invocation result and error envelope.

## Steps

| # | Action | Expected |
|---|---|---|
| S-240.2 | Run `kb config get platform.execution.mode --json` and `kb health --json`, then open Studio's health view after each restart; inspect each plane's execution record and the `execution` component in the shared `kb.health/1` snapshot | Config output shows the selected setting. Every plane's record, the execution health component, and Studio show the same concrete resolved mode, never `auto`. If configured as `auto`, they show the concrete mode selected at startup. |
| S-240.3 | For every plane and mode, invoke the fixture's typed failure with the same request ID | Every plane returns the same catalogued error code and request ID. |
| S-240.4 | For every plane and mode, inspect the structured log from the successful fixture request | Each log has the same plugin ID and command path. |

## Decision notes

- D55: “one execution mode, honored by every plane.” The planes are CLI, REST routes, REST WebSocket handlers, the workflow daemon, Gateway webhooks, and MCP. “A plane may not force its own backend.”
- D55: “The resolved mode must be visible, not `auto`.” Each plane-local backend choice is a failing claim.
- D46: “An unsupported mode is rejected at config validation.” Remote mode is specified in S-245.

## Source

`core/runtime/src/loader.ts` creates the shared backend. Plane wiring is in
`cli/runtime/src/v3/execute-command.ts`,
`services/rest-api/app/src/routes/plugins.ts`,
`services/workflow/daemon/src/worker.ts`,
`services/gateway/app/src/webhook/router.ts`, and
`services/mcp/app/src/mcp/tool-router.ts`. The REST WebSocket path is also in
`services/rest-api/app/src/routes/plugins.ts`.
