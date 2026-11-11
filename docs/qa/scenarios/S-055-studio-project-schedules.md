---
id: S-055
title: S-055 — See and manage project schedules in Studio
persona: solo-developer
area: studio
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [studio]
---

## Goal

A project user reviews its user and plugin schedules in Studio, changes a user cron, and verifies schedule lists stay isolated by project.

## Prerequisites

- [ ] Studio and workflow daemon are available for two registered projects.
- [ ] Project A has one user cron and one plugin cron; project B has a different user cron.

## Steps

| # | Action | Expected |
|---|---|---|
| S-055.1 | Open the Workflows Crons page for project A | Both user and plugin rows show their schedule, target, enabled state, last-run status (or an empty marker), and next fire time; the plugin row is read-only. |
| S-055.2 | Disable project A's user cron with the page toggle | The row changes to disabled and the project cron file/API state reports `enabled: false`. |
| S-055.3 | Disable the same user cron with `kb workflow crons disable <id>`, then refresh the page | Studio reflects the CLI change as disabled. |
| S-055.4 | Select project B and open Workflows Crons | Project B's user cron appears and project A's user cron is absent. Plugin manifest crons remain visible as shared read-only schedules. |
