---
id: S-241
title: Plugin execution — pool saturation queues work and reports capacity
persona: solo-developer
area: plugin-execution
priority: P0
status: planned
release: true
modes: [local, secured]
surfaces: [cli, studio]
---

## Goal

See pool pressure and health, have work wait in the bounded queue, and receive
a catalogued error when the queue is full.

## Prerequisites

- [ ] `platform.execution.mode` is `worker-pool` and the platform has started.
- [ ] A fixture command can hold a worker until a test control releases it.
- [ ] `kb health` (`kb.health/1`) and Studio expose total, idle, busy, and queued workers, configured worker and queue limits, resolved execution mode, last worker start or replacement failure, and execution health.

## Steps

| # | Action | Expected |
|---|---|---|
| S-241.1 | Hold every worker with `kb fixture execution hold --release-file=/tmp/worker-1 --json`, submit another hold, then release `/tmp/worker-1` before the acquire timeout | The extra request remains queued, then runs and returns the fixture result. `kb health --json` (`kb.health/1`) and Studio report total, busy, idle, queued, configured worker and queue limits, and resolved execution mode consistently. |
| S-241.2 | Keep all workers busy, fill the configured queue, then submit one more fixture request | The extra request fails with catalogued `QUEUE_FULL`; its error identifies the configured queue limit and carries the catalogued hint. Earlier queued calls remain queued. |
| S-241.3 | Fill the queue and wait beyond the configured acquire timeout | The expired queued request fails with catalogued `ACQUIRE_TIMEOUT`; its hint is present. It does not appear as running work after the timeout. |
| S-241.4 | Release every fixture hold and inspect `kb health --json` and Studio's health view | State reports all available workers idle, no busy workers, and no queued requests. Zero free workers while no work is running is impossible. |
| S-241.5 | With no request running, stop all workers using the fixture pool control and inspect `kb health --json` and Studio's health view | Both surfaces report `status: degraded` and execution health as `degraded` while no worker is available. |

## Decision notes

- D44 (corrected): pool state is visible through `kb health` over the shared `kb.health/1` snapshot and in Studio. Health is `degraded` when no worker is available, startup failed, or a replacement failed and live workers are below `min`. A failed pool start is retried; there is no half-started pool.
- D45: “`QUEUE_FULL`, `ACQUIRE_TIMEOUT`, `WORKER_CRASHED` and container-unavailable are catalogued codes with hints. A known execution state never surfaces as `KB_RUNTIME_UNEXPECTED`.”

## Source

`core/plugin-execution-factory/src/backends/worker-pool/pool.ts` queues work;
`pool-queue.ts` enforces acquire timeout; `pool-stats.ts` owns pool counts;
`errors.ts` defines pool errors. `kb health` serves the shared `kb.health/1`
snapshot.
