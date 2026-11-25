---
id: S-326
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
| S-326.1 | Run `kb qa run --json` when the configured tasks execute | The command exits 0 and returns the task rows and summary from DevKit's `{ok:true,data:...}` response, including the actual scheduled count and task outcomes. |
| S-326.2 | Run `kb qa run --json` when a DevKit task fails, including when a failed build blocks every requested test | The command exits nonzero and reports each failed task with its package, task name, exit code, task error or stderr, and log path when available from `{ok:false,error,data:...}`. |
| S-326.3 | Run `kb qa run --json` when `test` is requested and DevKit completes without errors or test task results | The command exits nonzero and reports that no test evidence was produced, including when DevKit returns `results: null` for an empty run. |
