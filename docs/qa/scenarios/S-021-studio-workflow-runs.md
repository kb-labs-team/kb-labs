---
id: S-021
title: Studio — Inspect workflow runs for the selected project
persona: solo-developer
area: studio
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [studio]
---

## Goal

A Studio user selects a project and inspects its workflow run history, run details, and step logs.

## Prerequisites

- [ ] Host running with Studio available and a registered project selected.
- [ ] The project has one successful and one failed workflow run with step output.
- [ ] In secured mode, the user is logged in and authorized to view the project.

## Steps

| # | Action | Expected |
|---|---|---|
| S-021.1 | Open **Workflows → Runs** for the selected project | The runs table shows only runs belonging to the selected project and includes each run ID, workflow ID, status, and start time. |
| S-021.2 | Open the successful run, then the failed run | Each detail page shows the selected run ID, its exact terminal status (`success` or `failed`), and its workflow ID. |
| S-021.3 | Open the successful run's step logs | The completed step's captured output is visible. |
| S-021.4 | Open the failed run's step logs | The failed step is identified and its error message is visible. |
| S-021.5 | Select a different project with no runs | The Runs view shows an empty state for that project and does not show either run from the first project. |
| S-021.6 | Open a successful run whose step declares JSON artifacts sourced from `steps.<step-id>.outputs` and `steps.<step-id>.outputs.<field>` | The completed step shows both artifact labels, its complete outputs object, and the selected field's JSON value. |
