---
id: S-310
title: DevKit reports manually scheduled tasks in affected runs
persona: developer
area: devkit
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a developer running affected checks, I can see which configured tasks were
left out of automatic execution and run them explicitly when needed, so a
frozen task does not slow ordinary feedback or disappear from the report.

## Prerequisites

- [ ] Use a checkout with the repository's DevKit configuration and workspace packages.
- [ ] The `kb-runner:test` task is configured for manual-only automatic scheduling.

## Steps

| # | Action | Expected |
|---|---|---|
| S-310.1 | Run `kb-devkit affected --json` | The JSON lists normally scheduled test packages under `testPackages`; `kb-runner` appears under `skippedManualTasks` with task `test` and a reason. Other internal tools with automatic test variants remain in `testPackages`. |
| S-310.2 | Run `kb-devkit run test --affected --json` | Eligible affected tests execute; the summary reports `kb-runner:test` as skipped/manual-only, without counting it as passed or failed. Failures from eligible tasks remain visible and fail the command. |
| S-310.3 | Run `kb-devkit run test --packages github.com/kb-labs/kb-runner --json` | The explicitly selected test task executes and reports its actual result; manual-only policy does not prevent opt-in execution. |
