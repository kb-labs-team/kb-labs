---
id: S-027
title: Workflow — Follow live progress from the CLI
persona: solo-developer
area: workflow
priority: P0
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A user watches a multi-step workflow and sees step transitions before the run finishes.

## Prerequisites

- [ ] Host running with workflow commands available from a registered project.
- [ ] Workflow `multi-step` has two local steps, each held at a controllable test gate long enough to observe a transition.
- [ ] In secured mode, an authenticated gateway session is available.
- [ ] A workflow engine test can inject a failing event bus or cache adapter for terminal side effects.

## Steps

| # | Action | Expected |
|---|---|---|
| S-027.1 | Run `kb workflow run --workflow-id=multi-step` and copy its run ID | CLI returns a non-empty run ID. |
| S-027.2 | Run `kb workflow runs watch <run-id>` while the run is active | Output includes events for the run ID and identifies both step IDs as they enter and leave execution. |
| S-027.3 | Wait for the workflow to finish | Watch output includes the terminal event with status `success`, then the command exits 0 within 60 seconds of the last step completing. |
| S-027.4 | Fail event publishing, blocked-dependent cancellation, or dead-letter storage after a workflow step finishes | The terminal run remains persisted before ancillary work. The caller receives a typed ancillary failure result, and run detail/history exposes the persisted diagnostic. A blocked dependent whose cancellation write fails remains queued with that state persisted. The platform log contains one structured record with operation, run ID, job ID, and the adapter error. Later ancillary operations still run. |
| S-027.5 | Cancel a running run through the workflow engine | The persisted run and history show `cancelled`; terminal events and other ancillary effects run after that state is durable. |
| S-027.6 | Kill the real workflow worker process while a step is running | The daemon detects the worker death, transitions the run to a terminal failed state, and run history exposes a diagnostic naming the process-death cause. |
| S-027.7 | Start the approval workflow, wait until its gate is pending, connect to the run's SSE events, then approve the gate | The already-connected subscriber receives `log.appended` for stdout `after approval` from step `After gate` before the terminal run event closes the stream, even though the shell command exits immediately. The event includes the run ID and step name. |

SE-06 verifies S-027.7 through the installed API.
