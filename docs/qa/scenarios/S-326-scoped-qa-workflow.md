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
- [ ] `@kb-labs/qa` is a discovered workspace package with a test task.
- [ ] The project has the `native-agent-qa-dogfood` workflow from S-325.

## Steps

| # | Action | Expected |
|---|---|---|
| S-326.1 | Run `kb qa run --tasks test --packages @kb-labs/qa --json` from the workspace root | QA schedules the `test` task for `@kb-labs/qa` and its declared prerequisites. The package's `build` prerequisite schedules builds for its workspace dependencies, including the SDK peer dependency, before the QA build and test run. It does not schedule test tasks for packages pulled in only as build dependencies. The result identifies `@kb-labs/qa`; unrelated package tests are not scheduled, and claim scanning ignores isolated Git worktrees under `.worktrees/` because they are not project sources. |
| S-326.2 | Run `kb workflow run --workflow-id=native-agent-qa-dogfood --input '{"task":"Make a small change in the QA plugin","run_review":false,"qa_packages":"@kb-labs/qa"}'`, wait for completion, then inspect the `qa` step with `kb workflow runs view <runId> --json=all` | The workflow passes `@kb-labs/qa` as the QA package scope. The QA step succeeds or reports its package-specific failure, and the recorded QA result identifies the selected package. If `qa_packages` is omitted, QA runs the project's configured full `test` task. |
| S-326.3 | Run `kb-devkit run test --packages <discovered-package-without-a-test-variant> --json` | The command exits nonzero with a catalogued `KB_RUNTIME_INPUT_INVALID` diagnosis naming the package and `test` task. It must not return a successful empty result when an explicit package scope schedules no tasks. |
