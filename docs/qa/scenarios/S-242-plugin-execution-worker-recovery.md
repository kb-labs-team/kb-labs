---
id: S-242
title: Plugin execution — recover workers after crash, timeout, or kill
persona: solo-developer
area: plugin-execution
priority: P0
status: planned
release: true
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

A failed worker call returns its catalogued cause, its entire process tree is
cleaned up, and pool capacity returns for later work.

## Prerequisites

- [ ] `platform.execution.mode` is `worker-pool`.
- [ ] A fixture can crash, hang past its timeout, spawn a detached child, and exit before sending its ready message.
- [ ] The fixture records execution, worker, and child process IDs; pool state is visible in `kb health` over `kb.health/1` and in Studio.

## Steps

| # | Action | Expected |
|---|---|---|
| S-242.1 | Run `kb fixture execution crash --json`, then submit `kb fixture execution healthy --json` | The failed request returns catalogued `WORKER_CRASHED` with its execution ID, not `KB_RUNTIME_UNEXPECTED`. The worker exits, capacity is restored, and the healthy call succeeds. |
| S-242.2 | Run `kb fixture execution spawn-detached-child --timeout-ms=300 --json` | The failed call returns the catalogued timeout code. The worker and every observed descendant exit before capacity returns. If process enumeration fails, a process identity is missing or changes for an observed PID, or a descendant survives the bounded wait, `kb health` reports the worker tree as unverified and execution health as degraded; the root worker is still killed and an unverified descendant is not signaled. |
| S-242.3 | Run `kb fixture execution crash --json` 50 times, then run `kb fixture execution healthy --json` and inspect process and pool state | Each failed call returns catalogued `WORKER_CRASHED`; no failed worker or descendant remains. The healthy call succeeds and the pool reports its available capacity. |
| S-242.4 | Fail transport initialization and worker startup before readiness, then submit `kb fixture execution healthy --json` during recovery | Transport initialization, pool creation, and initial worker startup run in one serialized lifecycle phase with bounded backoff. The failed startup leaves no transport or half-started pool. Health is `degraded` while no worker is available, and the healthy call succeeds after startup recovers. Requests during backoff fail fast with catalogued `WORKER_UNAVAILABLE`; its hint names the recorded diagnostic code and directs the user to `kb health`. The execution health record and structured warning include the catalogued failure code, a sanitized cause message, retry attempt, and retry delay. Concurrent requests do not trigger overlapping transport initialization or additional startup attempts within one backoff window. |

## Decision notes

- D44: “A failed pool start is retried; there is no half-started pool.” Health is degraded when no worker is available or startup failed.
- D45: “`QUEUE_FULL`, `ACQUIRE_TIMEOUT`, `WORKER_CRASHED` and container-unavailable are catalogued codes with hints. A known execution state never surfaces as `KB_RUNTIME_UNEXPECTED`.”

## Source

Worker startup, timeout, kill, and process-tree cleanup are owned by
`core/plugin-execution-factory/src/backends/worker-pool/worker.ts`;
`pool-lifecycle.ts` removes exited workers and starts replacements. The known
process-tree regression is in
`core/plugin-execution-factory/src/__tests__/worker-kill-process-tree.test.ts`.
