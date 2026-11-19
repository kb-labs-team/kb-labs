---
id: S-270
title: Inspect platform, plugin, and workflow logs
persona: solo-developer
area: observability
priority: P1
status: planned
release: true
modes: [local]
surfaces: [cli, studio]
---

## Goal

Find recent platform, plugin, and workflow logs from the CLI or Studio, including
entries related to a failing plugin command, without exposing secrets.

## Steps

| # | Action | Expected |
|---|---|---|
| S-270.1 | Run `kb logs query --json` after platform and plugin activity | The command returns recent platform and plugin log entries, including each entry's level, source, message, and time. |
| S-270.2 | Run `kb logs query --plugin-id <plugin-id> --trace-id <workflow-run-id> --level error --json` | The result contains only matching plugin, workflow trace, and error-level entries. Matching records retain their workflow `runId` and carry the same `traceId`; a step's distinct `executionId` remains unchanged. |
| S-270.3 | Run a failing plugin command and query logs with the correlation ID shown in its error | The query returns the log entry for that failing command with the same correlation ID. |
| S-270.4 | Open Studio's Logs view after the same activity and apply the plugin, workflow run, and level filters | Studio shows the same matching log entries as the CLI query. |
| S-270.5 | Cause log output to include a secret value, then query that entry | The stored and displayed log entry contains no secrets. |
| S-270.6 | Run a workflow to completion, then run `kb logs query --trace-id <workflow-run-id> --json` | The result includes the workflow's lifecycle and step records with `traceId` equal to the run ID, while preserving `workflow.run_id` on domain records and any distinct step `executionId`. |

## Decision notes

This case is planned until the full set of observable outcomes, including secret
redaction across stored and displayed records, is covered by the installed
journey.
