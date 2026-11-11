---
id: S-246
title: Plugin execution — consistent cancellation and timeout across modes
persona: solo-developer
area: plugin-execution
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [cli, api, agent]
---

## Goal

Cancel or time out the same long-running fixture command in each first-release
execution mode and plane, with the same user-visible result and no continuing
work left behind.

## Prerequisites

- [ ] A fixture command can run until cancelled and can run beyond a configured timeout.
- [ ] The platform supports `in-process`, `subprocess`, `worker-pool`, and `container` modes for the fixture.
- [ ] The fixture command is exposed through CLI, REST, and workflow entry points.

## Steps

| # | Action | Expected |
|---|---|---|
| S-246.1 | For each supported mode, start the same fixture command through CLI, REST, and workflow; cancel with Ctrl+C in CLI, cancel or close the REST request, and cancel the workflow run | Each caller reports the same catalogued cancellation code and request ID. The handler stops; subprocess/container processes and environments are removed, and active worker calls release capacity. |
| S-246.2 | For each supported mode, run the same fixture command with a 300 ms timeout through CLI, REST, and workflow | Every caller reports the same catalogued timeout code and timeout value. The handler stops and releases its worker, subprocess, or container environment. |

## Decision notes

- D55: “one execution mode, honored by every plane.” The mode remains the same across every plane; this case checks cancellation and timeout consistency across CLI, REST, and workflow.
- D57: remote execution and its cancellation behavior are roadmap-only; remote is not a first-release mode.

## Source

Timeout and cancellation paths are implemented in
`core/plugin-execution-factory/src/backends/` and routed through
`core/plugin-execution-factory/src/factory.ts`. Worker-pool cancellation is in
`backends/worker-pool/pool.ts` and `worker.ts`; container calls use
`core/plugin-execution-factory/src/isolated-backend.ts`.
