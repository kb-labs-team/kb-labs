---
id: S-309
title: Agent quality report works in isolated execution modes
persona: solo-developer
area: agents
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a developer inspecting agent runs, I can read the quality report in isolated
plugin execution modes, including when events are stored in the SQLite
analytics database, without granting the plugin unrestricted process access.

## Prerequisites

- [ ] Install `@kb-labs/agents` in a local platform and select a project with an analytics state directory.
- [ ] Provide the `sqlite3` executable through the host's governed process executor.
- [ ] The fixture can run with `platform.execution.mode` set to `subprocess` or `worker-pool`.

## Steps

| # | Action | Expected |
|---|---|---|
| S-309.1 | With no recent analytics JSONL files and no SQLite database, run `kb agent quality report show --days=1 --json` in subprocess mode, then repeat in worker-pool mode | Both invocations exit successfully and return `{ "success": true, "message": "No analytics files found for selected period", "runs": 0 }`. Loading the handler does not request direct `node:child_process` access. |
| S-309.2 | For each isolated mode, create a recent JSONL analytics buffer with no agent KPI rows and seed the project SQLite database with a recent `agent.kpi.run_completed` event, then run `kb agent quality report show --days=1 --json` | The report includes the seeded run and its KPI values. SQLite is queried through `ctx.api.shell.exec`; only `sqlite3` is allowed for this command, and an executable outside the command whitelist remains denied. |
| S-309.3 | Keep the JSONL buffer and SQLite fixture, but make the host `sqlite3` command unavailable or return a non-zero result; run the same report command | The command completes without an execution crash and returns an empty report, matching the existing fallback behavior when SQLite cannot be queried. |

## Decision notes

- The platform analytics adapter's worker/subprocess IPC is a no-op reader, so this command uses the governed shell API to query its existing SQLite fallback.
- The permission is limited to this CLI command and to the `sqlite3` executable.
- SQLite fallback depends on a host `sqlite3` executable; process launch or non-zero failures remain a best-effort fallback and produce no SQLite rows.

## Source

The command is implemented in `plugins/agents/src/cli/commands/quality-report.ts`
and receives its command-level permissions from `plugins/agents/src/manifest.ts`.
