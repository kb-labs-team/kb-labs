---
id: S-188
title: Workflow — retry a transient failure under a configured policy
persona: workflow-author
area: workflows
priority: P0
status: planned
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

Configure bounded retries for a workflow job, observe attempts and terminal
failure, and ensure cancellation prevents a pending retry from executing.

## Prerequisites

- [ ] A registered project with the built-in workflow service and a deterministic clock.
- [ ] A fixture job that can fail once with a classified `network` failure,
      fail on every attempt, or block while a retry is pending.

## Steps

| # | Action | Expected |
|---|---|---|
| S-188.1 | Set the fixture job's `retries` policy to `{ max: 2, backoff: lin, initialIntervalMs: 50, maxIntervalMs: 100, on: [network] }`, then run it with `kb workflow run --workflow-id=retry/fails-once` | The first network failure is recorded and a retry is queued using the configured linear delay; the fixture succeeds on the next attempt. |
| S-188.2 | Run `kb workflow runs view <runId> --json=status,jobs` | The run is successful and the job's visible `attempt` count is `2`. |
| S-188.3 | Run the always-failing fixture under the same policy and inspect it with `kb workflow runs view <runId> --json=status,jobs` | The terminal run is failed after exactly three total attempts (`max: 2` means two retries); the terminal message identifies retry exhaustion and no fourth attempt is started. |
| S-188.4 | Start the pending-retry fixture, cancel it with `kb workflow runs cancel <runId>`, then advance the deterministic clock past the retry deadline | The run remains cancelled and the fixture execution count does not increase after cancellation. |

## Pass criteria

The retry policy schema is `max`, `backoff` (`exp` or `lin`),
`initialIntervalMs`, optional `maxIntervalMs`, and optional failure-kind `on`
(`services/workflow/contracts/src/schemas.ts:36-52`); job-level policy is
`retries` (`:180-188`) and step-level policy is `retry` (`:115-123`). The
engine increments the attempt, applies `max + 1` total-attempt semantics,
records `willRetry`, schedules the retry, and drops a stale retry when
cancellation changed job state (`services/workflow/engine/src/engine.ts:358-410,412-460`).
The CLI shows `attempt N` and the original job error (`services/workflow/entry/src/commands/runs-view.ts:86-96`), but does not currently identify terminal failure as “retries exhausted.” Keep this case planned until the retry journey exposes a clear exhaustion message and verifies cancellation with a deterministic clock.
