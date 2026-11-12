---
id: S-296
title: Host lifecycle — supervisor, status, doctor and start agree on one host state
persona: solo-developer
area: platform-core
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A supervised host that dies unexpectedly is restarted, or the death is reported
plainly with its cause and the next command. `start`, `status`, `doctor` and
`stop` never disagree about whether the host is running.

## Prerequisites

- [ ] A disposable installation whose host is a real child process on a free loopback port (never the default gateway port).
- [ ] `kb-create start` has returned a healthy host under its supervisor.

## Steps

| # | Action | Expected |
|---|---|---|
| S-296.1 | Kill the host child process with SIGKILL while its supervisor stays alive | Within the restart budget the supervisor starts a new host child (new PID); `status` reports `running` with that PID and `doctor` reports the platform healthy. |
| S-296.2 | Kill the host child again until the supervisor's restart budget (3 restarts in 10 minutes) is exhausted | The supervisor stays alive and does not restart again. `status --json` reports `hostState: "host-exited"`, `running: false`, the last exit cause and `hostExit.exhausted: true`, and `next` is the exact `kb-create start` command. `doctor` reports the `host-process` check failed with the same cause and the same command. |
| S-296.3 | Run `kb-create start` with the supervisor alive and the host child dead | Exits 0 and recovers the host child through the supervisor (new PID, healthy, restart budget cleared). It never returns `KB_HOST_ALREADY_RUNNING` for a host that does not answer. |
| S-296.4 | Run `kb-create stop` in each state of S-296.2 and S-296.3 | Exits 0; the supervisor is gone and `status` reports `stopped`. |
| S-296.5 | The host child dies again after an earlier death was already restarted, and `kb-create status` runs before the supervisor has recorded the new death | `status --json` reports `hostState: "host-exited"` without a `hostExit` cause; it never presents the earlier death's cause as the cause of this one. Once the supervisor records it, `hostExit` describes the new death. |

## Pass criteria

One typed host state (supervisor alive × child alive × health) is computed by
one owner; every command reads it. A dead child under a live supervisor is
never reported as "not running" by one command and "already running" by another.
