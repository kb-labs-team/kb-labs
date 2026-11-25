---
id: S-321
title: Workflow CLI command runs in the selected task worktree
persona: solo-developer
area: workflows
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A project workflow can reuse an installed plugin CLI command and have it operate on the task worktree selected for that workflow run.

## Preconditions

- The project has an installed plugin that declares a CLI command and a workflow that invokes it with `uses: command:<manifest command path>`.
- The workflow runner provisions a task worktree and makes its path available as `KB_WORKSPACE_ROOT`.
- The selected command can report its working directory or make a deterministic file change.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Run a workflow in a task worktree with a step that uses an installed plugin command. Pass command flags directly in `with`, then repeat with `with.flags`. | Both runs receive the command flags and resolve files relative to the worktree. A file the command creates exists in the worktree only. |
| S-321.2 | Run the command step without a task worktree, with a workspace path supplied to the workflow runner. | The plugin handler uses the supplied workspace path as its current directory. |
