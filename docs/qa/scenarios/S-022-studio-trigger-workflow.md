---
id: S-022
title: Studio — Trigger a workflow with declared inputs
persona: solo-developer
area: studio
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [studio]
---

## Goal

A project user starts an enabled workflow from Studio, supplies its required inputs, and finds the resulting run in project history.

## Prerequisites

- [ ] Host running, registered project selected, and Studio access available.
- [ ] The project has an enabled manual workflow `greet` with required string input `name`.
- [ ] In secured mode, the user is logged in and authorized to run workflows in the selected project.

## Steps

| # | Action | Expected |
|---|---|---|
| S-022.1 | Open **Workflows → Definitions**, select `greet`, and choose **Run** | The run form identifies required input `name` and marks it required. |
| S-022.2 | Submit `name` with value `Ada` | Studio creates a run and shows its run ID and initial status within 30 seconds. |
| S-022.3 | Open the created run from **Workflows → Runs** | The detail page shows the same run ID, workflow ID `greet`, and submitted input `name: Ada`; within 60 seconds its status is `success` and the step output contains `Ada`. |
| S-022.4 | Start `greet` again and submit the form with `name` empty | Studio keeps the form open, marks `name` as required, and does not create a run. |
| S-022.5 | Submit **Run** while the selected project's workflow service returns an unstructured HTTP 500 response | Studio shows a catalogued `KB_RUNTIME_COMMAND_FAILED` message and recovery hint; the response retains the failed workflow route and upstream status without exposing the upstream body. |
