---
id: S-160
title: Commit plugin — Generate a commit with the deterministic journey LLM
persona: solo-developer
area: plugins
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer uses the marketplace-installed commit plugin to generate and preview a commit plan with the deterministic LLM fixture bound through platform configuration; the missing-adapter path gives an actionable typed error.

## Prerequisites

- [ ] The `@kb-labs/commit` plugin is installed and enabled in the project.
- [ ] A Git repository contains staged changes.
- [ ] The deterministic journey LLM fixture adapter is installed and bound through platform `platform.adapters.llm` configuration.

## Steps

| # | Action | Expected |
|---|---|---|
| S-160.1 | Run `kb commit commit --dry-run --json` with the deterministic fixture adapter configured | Stdout is exactly one JSON envelope containing a generated plan with `plan.metadata.llmUsed: true` and `applied: false`; progress stays on stderr, no commit is created, and the index and working tree are unchanged. In secured mode, after Gateway authentication and project resolution, the command is sent to that registered project runtime and executes through its host-owned `platform.executionBackend`; it succeeds while no Workspace Agent is running. The request identifies only the enabled plugin, canonical command, and bounded arguments; the host resolves `configSection`, handler, permissions, environment, and canonical package root from its own catalog. |
| S-160.2 | Remove the platform LLM adapter binding and run `kb commit commit --dry-run` again | After the project runtime has reloaded the changed platform binding, the command returns a typed error naming the missing `llm` capability and includes the `kb adapter bind llm <installed-adapter-package>` next-command hint; it does not silently use a built-in LLM. |
| S-160.3 | Restore the platform fixture binding and run `kb commit commit --json` | After the project runtime has reloaded the restored platform binding, JSON output reports `applied: true`; a commit is created and `git log -1 --format=%s` prints the conventional commit subject returned by the configured fixture. |
| S-160.4 | After S-160.3 leaves the repository clean, run `kb commit commit --json` again | The command succeeds with an empty plan, `applied: false`, and no applied commits; HEAD, index, and working tree remain unchanged. |
| S-160.5 | Send a command request directly to the project REST listener without the host runtime proof, then run it through the authenticated Gateway project route | The direct request is rejected with HTTP 403 before command execution. The Gateway-routed request streams command progress and its final result from the project runtime; only the host's runtime guard can provide the trusted proof accepted by the listener. |
