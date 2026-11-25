---
id: S-321
title: QA run preserves DevKit results and failures
persona: developer
area: quality
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a developer running the QA command, I can see the actual DevKit task results and failures so that a successful QA report means tasks ran and a failed task cannot appear green.

## Prerequisites

- [ ] Use a registered project with `devkit.yaml` task definitions and the QA plugin installed.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Run `kb qa run --json` when the configured tasks execute | The command exits 0 and returns the task rows and summary from DevKit's `{ok:true,data:...}` response, including the actual scheduled count and task outcomes. |
| S-321.2 | Run `kb qa run --json` when a DevKit task fails | The command exits nonzero, retains the failed task rows from `{ok:false,error,data:...}`, and reports task diagnostics with package and failure details. |
| S-321.3 | Run `kb qa run --json` when `test` is requested but DevKit produces no test task results | The command reports that no test evidence was produced and does not return success. |
