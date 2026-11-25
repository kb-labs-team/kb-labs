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

When a workflow or job declares `target.sourceRef`, the isolated task workspace
starts from that Git ref. `sourceRef: HEAD` uses the owning project checkout's
current commit, including when that checkout is detached.

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
| S-325.1 | Copy `services/workflow/examples/native-agent-qa-dogfood.yml` into `.kb/workflows/` and run `kb workflow lint` | The `native-agent-qa-dogfood` workflow validates. It requires a task description and defaults the optional review input to false. Its steps resolve to the manifest paths `agent run`, `qa run`, and (when enabled) `review run`, plus the declared `builtin:workspace-patch` step. |
| S-325.2 | On a project checkout whose `HEAD` differs from `main`, run `kb workflow run --workflow-id=native-agent-qa-dogfood --input '{"task":"<task description>","run_review":false}'`, wait for completion, and inspect `kb workflow runs view <runId> --json=all` | The sample workflow declares `target.sourceRef: HEAD`; the isolated task worktree's base commit equals the owning project checkout's `HEAD`, not the adapter's configured default branch. The `agent` step records its JSON result. After it succeeds, the `qa` step runs only the `test` task with JSON output and records at least one selected task result. Both steps use the same isolated task worktree. If agent execution fails, the workflow is failed and QA is not run; if QA fails or selects no tasks, the workflow is failed and its error/result remains inspectable. |
| S-325.3 | Run the workflow with `run_review` set to `true`, then inspect the run record | The `review` command runs after successful QA and its structured report is recorded. If review returns a command failure, the workflow run is failed and the failure is visible in the run record. |
| S-325.4 | Run the workflow with review disabled and inspect the terminal run using `kb workflow runs view <runId> --json=all` | The final `builtin:workspace-patch` step exports the isolated task worktree's changes through the configured workspace adapter and stores a binary-safe Git patch as a workflow artifact. Its step output contains the artifact key, base commit, changed file list, byte size, and SHA-256. The recorded base commit equals the source ref resolved for the workflow/job (`HEAD` in this scenario); applying the patch to that commit reproduces tracked edits, non-ignored additions and deletions, file mode changes, and binary file contents. Ignored files are excluded, including project-local Git exclusions. Export uses the run’s owning project, preserves the task tree through daemon restart, and does not execute repository-configured Git helpers. A redirected artifact directory or missing original base fails the step. Worktrees containing submodules or embedded Git repositories fail capture because their contents require separate patches. Export is scoped to the trusted owning project root, full owner run ID, and workspace ID; a mismatched project, owner run, or worktree path fails without creating an artifact. Legacy worktrees with no verifiable owner remain available for manual recovery but cannot be exported. If export or artifact storage fails, the step and workflow fail with an actionable error and the worktree remains available for debugging. |
