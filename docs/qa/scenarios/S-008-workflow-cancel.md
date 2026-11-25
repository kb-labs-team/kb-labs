---
id: S-008
title: Workflow — Cancel an active run
persona: solo-developer
area: workflow
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A user cancels an active workflow run and verifies its terminal state.

## Prerequisites

- [ ] Host running; current directory is a registered project with workflow commands available.
- [ ] A workflow named `long-task` runs an active shell step on the local executor. The step reports its shell and child process IDs, then waits on a test gate.
- [ ] In secured mode, an authenticated gateway session is available.

## Steps

| # | Action | Expected |
|---|---|---|
| S-008.1 | Run `kb workflow run --workflow-id=long-task`; copy the returned run ID | CLI returns the run ID, and the step reports both process IDs while the run is `running`. |
| S-008.2 | Run `kb workflow runs cancel <run-id>` using that ID | CLI confirms the cancellation request for that run ID after the step’s shell and child processes have stopped. |
| S-008.3 | Poll `kb workflow runs view <run-id> --json=status` for up to 30 seconds | JSON reports status `cancelled`. |
| S-008.4 | Run `kb workflow runs cancel <run-id>` again after cancellation | CLI reports that the run is already finished and exits non-zero; the stored status remains `cancelled`. |
