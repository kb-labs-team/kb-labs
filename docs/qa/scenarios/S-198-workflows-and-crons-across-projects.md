---
id: S-198
title: Projects — Keep workflow and cron runs within their project
persona: solo-developer
area: workflows
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, studio, api]
---

## Goal

Run workflows and scheduled work for multiple repositories while keeping
definitions, executions, history, and logs scoped to each project.

## Prerequisites

- [ ] Projects A and B are registered and have different workflow definitions and cron schedules.
- [ ] Both projects have workflow storage configured and the gateway can start their runtimes.

## Steps

| # | Action | Expected |
|---|---|---|
| S-198.1 | From Project A, run its workflow and then run `kb workflow runs list --json` and `GET /api/v1/projects/<project-id>/workflow/runs`; repeat from Project B | Each CLI and project-scoped API list contains only that project's run IDs and workflow IDs. Neither project's list includes the other project's run. |
| S-198.2 | Inspect each run's detail and step logs using `kb workflow runs view <run-id>` and the selected project's Studio Runs view | The run output and captured logs contain only that project's fixture data; another project's selected view cannot resolve or display the run. |
| S-198.3 | Create and enable a cron in Project A, then inspect `kb workflow crons list --json` from both project roots | Project A lists the enabled cron; Project B does not list it. Each cron targets a workflow in its own project. |
| S-198.4 | Advance the scheduler through Project A's due time and inspect both project histories and Studio's selected-project Crons and Runs views | Exactly the Project A scheduled run appears in A's history and views; B shows no cron or run from A. Logs are available only while viewing A. |
| S-198.5 | Run a workflow that provisions an isolated git worktree, then run an installed plugin command from that worktree | The command resolves the owning registered project ID while its cwd remains the worktree path. |
| S-198.6 | From a workflow step in the worktree, run `kb project show --json` and a platform CLI command | `KB_PLATFORM_ROOT` points to the installed platform, `KB_WORKSPACE_ROOT` points to the worktree, and the command resolves the owning project ID. |
| S-198.7 | Register a repository root, then a project directory inside another repository; run plugin commands from their worktrees, including a path inside and outside the registered subdirectory; then run from an unregistered or bare repository | Each registered worktree path inside its registered project resolves to that project. A path outside a registered subdirectory, an unregistered repository, and a bare repository return `KB_PROJECT_UNKNOWN` with a `kb project add <path>` hint. |
| S-198.8 | For a project using the built-in filesystem adapter with its default project-state storage, start the workflow daemon with a valid legacy run at `$KB_HOME/state/<project-id>/storage/workflows/<run-id>.json`; restart it and inspect run history | The legacy run is copied into that project's scoped history once, its source file remains intact, and the durable migration marker prevents a later restart from restoring a scoped run the user removed. |
| S-198.9 | Repeat with explicit/shared custom storage, a corrupt legacy record, and a symlinked legacy workflow file | No ambiguous/custom, corrupt, or symlinked record is imported; existing source bytes remain unchanged and no foreign project history appears. |

## Dependencies

- S-002, S-044, S-055, S-184 and S-187 cover individual workflow, cron,
  Studio, and installed-project behavior. This case verifies the two-project
  boundary through the full run and log lifecycle.
