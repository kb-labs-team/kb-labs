---
id: S-122
title: Studio — Find diagnostics for a failed workflow run
persona: solo-developer
area: studio
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [studio]
---

## Goal

When a workflow fails or a runtime is unhealthy, use Studio to identify the affected project and run, then reach the relevant logs and health diagnostics without searching unrelated platform output.

## Prerequisites

- [ ] Registered project with a workflow fixture that fails in a named step and emits a unique diagnostic marker.
- [ ] Gateway observability data contains the failed run and the matching log record; a second healthy project is registered.

## Steps

| # | Action | Expected |
|---|--------|----------|
| S-122.1 | Select the failing project and open Workflow Runs | The failed run appears with its run ID, workflow name, failure status, and completion time. The healthy project's runs are not mixed into the selected project's list. |
| S-122.2 | Open the failed run | The named failing step and its error message are visible, with a link or action to inspect the run's logs. |
| S-122.3 | Follow the run's log action | Studio opens History for the selected project filtered to that run, without sending requests to a previously selected project or applying an implicit time window. History loads successfully and shows the unique diagnostic marker from the run without entries from other runs, including when the run is older than 15 minutes. An AI summary requested from this view stays scoped to the same run and does not add a time window. |
| S-122.4 | Open Observability Metrics or service health from the same project context | The unhealthy service/runtime is named with its reported health state and recent error; the project/run context remains identifiable. |
| S-122.5 | Request the same diagnostics when the observability service is unavailable | Studio shows a visible error naming the unavailable diagnostics source and the next command `kb-create doctor --platform-root <platform-root>`; the workflow failure detail remains available. |
