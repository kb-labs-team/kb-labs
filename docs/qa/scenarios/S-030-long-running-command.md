---
id: S-030
title: Commit plugin — Long-running generation reports progress and can be cancelled
persona: solo-developer
area: plugins
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer runs the commit plugin's potentially long LLM generation, sees progress while it runs, and can interrupt it from the terminal.

## Prerequisites

- [ ] The `@kb-labs/commit` plugin is installed and enabled in the project.
- [ ] A Git repository has enough staged changes to keep generation running during observation, and its LLM adapter is configured.

## Steps

| # | Action | Expected |
|---|---|---|
| S-030.1 | Run `kb commit commit --dry-run` with the staged changes | In local and secured mode, the CLI displays an active progress indicator and a generation phase message before printing the plan; in secured mode the message is streamed from the registered project runtime, including with the in-process execution backend. |
| S-030.2 | Observe output while generation is still in progress | At least one subsequent phase update is visible before the final result. |
| S-030.3 | Send Ctrl+C while the command is generating, including before the first progress event reaches the CLI | The secured request is aborted even before the runtime returns its execution ID; the command exits with status 130, restores the terminal prompt, and does not print an uncaught worker `EPIPE` error. |
| S-030.4 | Inspect Git history after cancellation | No commit was created by the interrupted `--dry-run` command. |
