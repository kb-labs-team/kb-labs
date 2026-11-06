---
id: S-280
title: StateBroker cache survives daemon and host restarts
persona: solo-developer
area: platform
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A developer can restart the local host or StateDaemon without losing unexpired StateBroker values, while expired values remain expired.

## Preconditions

- [ ] A local platform data root is available through the platform layout contract and resolved by `resolvePlatformDataRoot`.
- [ ] A StateDaemon can be started and stopped against that resolved root.

## Steps

| # | Action | Expected |
|---|---|---|
| S-280.1 | Through the StateDaemon HTTP API, set a value with an unexpired TTL, stop and recreate the daemon with the same resolved platform data root, then read the key | `GET /state/:key` returns HTTP 200 and the original JSON value. The first successful mutation makes the journal file and its directory entry durable before its StateBroker promise resolves, so a resolved write has no process-crash loss window; an in-flight write whose promise has not resolved may be absent after a crash, and a host/power failure may lose the latest write if storage does not honor `fsync`. |
| S-280.2 | Set one value with an unexpired TTL and one with a TTL that expires by wall-clock time, restart the host and its StateDaemon against the same resolved platform data root, then read both keys | The unexpired key returns HTTP 200 with its original value. The expired key returns HTTP 404; replay checks the persisted absolute expiry timestamp against the current wall clock and does not extend its lifetime. An omitted TTL continues to use the existing five-minute default. |
| S-280.3 | Start the StateDaemon with a journal containing a valid record, a malformed complete record, and another valid record | The service starts and `/ready` reports ready. The prefix value is readable, the later value is absent, and the journal is truncated to the valid prefix. The structured diagnostic uses error code `KB_STATE_BROKER_PERSISTENCE_CORRUPT` from the platform error catalogue. |
| S-280.4 | Start a StateDaemon with a resolved platform data root, write a value, and inspect the filesystem around the platform root | All StateBroker journal files are created only beneath the resolved platform data root; no journal file is created in the repository, process working directory, or outside the platform data root. |
| S-280.5 | Keep one StateBroker writer alive, then let a separate process reclaim a stale lock record while the lock pathname is atomically replaced with the live writer's lock file | The live writer's lock record survives at the lock pathname. |
| S-280.6 | After an acknowledged mutation, begin StateDaemon shutdown, issue a late mutation, and open a second daemon against the same platform data root | Shutdown stops admission and closes the listener before draining admitted mutations; the journal is flushed before the first daemon releases its writer lock. The late mutation is not acknowledged by the stopping daemon. The second daemon opens after shutdown completes, readiness succeeds, and the earlier acknowledged mutation is readable. |
| S-280.7 | Start a StateDaemon with a journal containing a verified record, a partial final record, and trailing bytes after the partial record | The daemon retains only the verified prefix, truncates the journal at that record boundary, emits catalogue diagnostic `KB_STATE_BROKER_PERSISTENCE_CORRUPT`, and reports readiness. |
| S-280.8 | Hold a port open, attempt to start a durable StateDaemon on that port and data root, release the port, then start another durable StateDaemon on the same root | The first start reports its listener error. The second start succeeds and serves `/ready` from the same data root. |
| S-280.9 | Start a StateDaemon with a journal containing one verified record followed by a record with invalid UTF-8 bytes inside a JSON string | The daemon starts and `/ready` reports ready. Replay retains the value from the verified record, omits the corrupt record, truncates the journal to the exact verified byte prefix, and emits catalogue diagnostic `KB_STATE_BROKER_PERSISTENCE_CORRUPT`. |

The `.reclaim` gate serializes a reclaimer's stale-token reread and unlink. Without serialization, reclaimer A can reread a stale record, reclaimer B can unlink it and install a live writer's lock, and then A can unlink B's replacement by pathname. The process-level FIFO test proves the observable live-lock survival for the reread window it controls; it cannot pause two reclaimers between reread and unlink without a production hook, so the gate's necessity is a design argument rather than a claim proven by that test.
