---
id: S-326
title: QA — run selected workspace packages in a workflow
persona: developer
area: quality
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A developer can run QA for the packages changed by a focused task without
waiting for every test suite in the workspace, while the workflow record shows
which package scope was checked.

## Preconditions

- [ ] The project has the QA plugin and a working `kb-devkit` configuration.
- [ ] `kb-create` is a discovered workspace package with a test task.
- [ ] The project has the `native-agent-qa-dogfood` workflow from S-325.

## Steps

| # | Action | Expected |
|---|---|---|
| S-326.1 | Run `kb qa run --tasks test --packages kb-create --json` from the workspace root | QA runs the `test` task for `kb-create` and any task prerequisites required by the workspace configuration; packages outside that selection are not scheduled. The JSON result retains the selected package and task outcomes. |
| S-326.2 | Run `kb workflow run --workflow-id=native-agent-qa-dogfood --input '{"task":"Make a small change in kb-create","run_review":false,"qa_packages":"kb-create"}'`, wait for completion, then inspect the `qa` step with `kb workflow runs view <runId> --json=all` | The workflow passes `kb-create` as the QA package scope. The QA step succeeds or reports its package-specific failure, and the recorded QA result identifies the selected package. If `qa_packages` is omitted, QA runs the project's configured full `test` task. |
