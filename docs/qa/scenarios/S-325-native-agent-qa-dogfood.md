---
id: S-325
title: Workflow — run an agent task and QA in one task workspace
persona: solo-developer
area: workflow
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A developer runs a coding-agent task and the QA test task in sequence through
native workflow CLI steps, then inspects their structured outputs in workflow
history.

## Prerequisites

- [ ] A registered local project has the workflow, agents, and QA plugins available.
- [ ] The project has a configured LLM adapter for agent execution.
- [ ] A workspace adapter provisions an isolated task worktree for workflow runs.
- [ ] The workflow `command:` runner change from PR #711 is present so both CLI
      commands use that task worktree. It is not present on the `origin/master`
      revision this case was written against.
- [ ] The selected project has a `test` task supported by its `kb-devkit` configuration.
- [ ] If review is requested, the review plugin is installed.

## Steps

| # | Action | Expected |
|---|---|---|
| S-325.1 | Copy `services/workflow/examples/native-agent-qa-dogfood.yml` into `.kb/workflows/` and run `kb workflow lint` | The `native-agent-qa-dogfood` workflow validates. It requires a task description and defaults the optional review input to false. Its steps resolve to the manifest paths `agent run`, `qa run`, and (when enabled) `review run`, with only declared command flags. |
| S-325.2 | Run `kb workflow run --workflow-id=native-agent-qa-dogfood --input '{"task":"<task description>","run_review":false}'`, wait for completion, and inspect `kb workflow runs view <runId> --json=all` | The `agent` step records its JSON result. After it succeeds, the `qa` step runs only the `test` task with JSON output and records the task results. Both steps use the same isolated task worktree. If agent execution fails, the workflow is failed and QA is not run; if QA fails, the workflow is failed and its error/result remains inspectable. |
| S-325.3 | Run the workflow with `run_review` set to `true`, then inspect the run record | The `review` command runs after successful QA and its structured report is recorded. If review returns a command failure, the workflow run is failed and the failure is visible in the run record. |
| S-325.4 | Inspect a successful run after it reaches a terminal state | The run history retains the agent, QA, and optional review step outputs. The workspace adapter releases the task worktree after success. Patch verdict for this MVP is `blocked/no_changes`: no patch is captured, which does not claim that the agent made no edits. A failed run retains its task worktree for debugging. |
