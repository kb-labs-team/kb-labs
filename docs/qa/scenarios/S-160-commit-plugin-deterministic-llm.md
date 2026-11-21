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
| S-160.1 | Run `kb commit commit --dry-run --json` with the deterministic fixture adapter configured | JSON output contains a generated plan with `plan.metadata.llmUsed: true` and `applied: false`; no commit is created and the index and working tree are unchanged. In secured mode on the installed host, the command uses the configured local execution backend and succeeds while no Workspace Agent is running; secured access does not implicitly make plugin execution remote. |
| S-160.2 | Remove the platform LLM adapter binding and run `kb commit commit --dry-run` again | The command returns a typed error naming the missing `llm` capability and includes the `kb adapter bind llm <installed-adapter-package>` next-command hint; it does not silently use a built-in LLM. |
| S-160.3 | Restore the platform fixture binding and run `kb commit commit --json` | JSON output reports `applied: true`; a commit is created and `git log -1 --format=%s` prints the conventional commit subject returned by the configured fixture. |
| S-160.4 | After S-160.3 leaves the repository clean, run `kb commit commit --json` again | The command succeeds with an empty plan, `applied: false`, and no applied commits; HEAD, index, and working tree remain unchanged. |
