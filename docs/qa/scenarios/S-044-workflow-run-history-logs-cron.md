---
id: S-044
title: S-044 — Configure, inspect, and manage a workflow cron
persona: solo-developer
area: workflow
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

A project user creates a schedule for an existing workflow, observes its scheduled run, disables it, verifies it stays quiet, and enables it again.

## Prerequisites

- [ ] Registered project with the workflow daemon available.
- [ ] The project runtime remains available while an enabled cron exists.
- [ ] Workflow `journey-cron-target` accepts the required string input `message` and logs it.
- [ ] An installed plugin manifest contributes at least one plugin cron to the workflow cron list.

## Steps

| # | Action | Expected |
|---|---|---|
| S-044.1 | Create `.kb/crons/journey-cron.yml` with `schedule: '* * * * *'`, `workflow: journey-cron-target`, `input: { message: journey-cron-fired }`, and `enabled: true`; run `kb workflow crons list --json` | The cron is listed with source `user`, the one-minute schedule, the workflow target, the input, enabled state, and a next fire time. |
| S-044.2 | Wait for the next schedule interval, then inspect `kb workflow runs list --workflow=journey-cron-target --json`, `kb workflow runs view <runId> --json=all`, and `kb workflow runs logs <runId> --json` | A successful run appears with `trigger.type: schedule`, `metadata.cronId: journey-cron`, and the log line `journey-cron-fired`. |
| S-044.3 | Run `kb workflow crons disable journey-cron`; inspect the cron file and `kb workflow crons list --json` | The file contains `enabled: false` and the list reports the cron disabled. |
| S-044.4 | Record run history, wait a full one-minute interval, then inspect history again | No run starts for `journey-cron-target` while the cron is disabled. |
| S-044.5 | Run `kb workflow crons enable journey-cron`; inspect the file and list | The file contains `enabled: true` and the list reports the cron enabled. |
| S-044.6 | Replace the schedule with an invalid expression, then run `kb workflow crons list --json` | Discovery reports `.kb/crons/journey-cron.yml` and a reason identifying the invalid cron expression. |
| S-044.7 | Restore a valid expression, change the target to an unknown workflow, then run `kb workflow crons list --json` | Discovery reports `.kb/crons/journey-cron.yml` and a reason identifying the unknown workflow. |
| S-044.8 | Run `kb workflow crons enable <plugin-cron-id>` for a listed plugin cron | The command is refused with a typed read-only/plugin-cron error; the plugin cron remains unchanged. |
| S-044.9 | Set the user cron schedule to `0 9 * * 1-5`, then run `kb workflow crons list --json` | The weekday range expression is accepted and listed without a cron validation error. |
