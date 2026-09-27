# @kb-labs/agent

> Autonomous AI agents — execute tasks, generate plans, edit files, and debug runs.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-agent%20%7C%20autonomous%20%7C%20llm%20%7C%20orchestration-lightgrey)

---

## Overview

Agent System gives you a general-purpose AI agent that can read and write files,
run shell commands, search your codebase, and maintain memory across sessions.
Four modes cover the main use cases: direct execution, plan-first, targeted file
editing, and post-mortem debugging from a trace file.

---

## Features

- Four modes: `execute`, `plan`, `edit`, `debug`
- Plan → approve → execute lifecycle with plan review before any action
- Per-session memory — agent remembers context across tasks in the same session
- File change history with per-change diffs
- Rollback any agent-made changes (by change ID, file, session, or timestamp)
- Trace toolchain — inspect token usage, context windows, tool calls, errors
- Quality reports — KPI aggregation across recent runs
- Real-time event streaming over WebSocket
- Studio UI for visual session management

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Platform services**

| Service | Required | Purpose |
|---------|----------|---------|
| `llm` | Required | Agent reasoning |
| `cache` | Optional | Result caching |
| `analytics` | Optional | KPI tracking |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/agent-entry
```

---

## Commands

### Running tasks

```bash
kb agent run --task="Create analytics system"          # execute immediately
kb agent run --task="Add auth" --mode=plan             # generate plan first
kb agent run --task="Add auth" --mode=plan --approve   # generate + auto-approve
kb agent run --task="Add auth" --mode=plan --approve --execute  # plan + execute in one step
kb agent run --task="Fix bug" --mode=edit --files src/auth.ts   # edit specific files
kb agent run --task="Why crash?" --mode=debug --trace .kb/traces/trace-123.json
kb agent run --task="Explain this diagram" --attachments ./architecture.png
kb agent run --task="Summarize this report" --attachments ./report.pdf
kb agent run --task="Heavy refactor" --timeout=300 --budget=500000
kb agent run --task="..." --session-id=abc --verbose   # resume session
```

### Trace debugging

```bash
kb agent trace stats     --task-id=task-123            # tokens, cost, timing
kb agent trace filter    --task-id=task-123 --type=llm:call
kb agent trace iteration --task-id=task-123 --iteration=3
kb agent trace context   --task-id=task-123            # context window + truncations
kb agent trace diagnose  --task-id=task-123            # comprehensive diagnostic report
```

### Quality control

```bash
kb agent quality report                   # last 24h
kb agent quality report --days=7
kb agent quality report --session-id=abc
```

### File change history

```bash
kb agent history                             # all recent changes
kb agent history --session-id=abc
kb agent history --file=src/index.ts
kb agent diff     --change-id=change-abc123  # line-by-line diff
kb agent rollback --change-id=change-abc123  # undo one change
kb agent rollback --session-id=abc --dry-run # preview session rollback
kb agent rollback --after="2026-05-01T00:00:00Z"
```

**Full flag reference — `kb agent run`**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--task` | `string` | — | Task description |
| `--mode` | `execute \| plan \| edit \| debug` | `execute` | Agent mode |
| `--session-id` | `string` | auto | Session ID for continuity |
| `--approve` | `boolean` | `false` | Auto-approve generated plan |
| `--execute` | `boolean` | `false` | Execute plan immediately after approval |
| `--files` | `string[]` | — | Target files (edit mode) |
| `--attachments` | `string[]` | — | Input PDFs/images (repeat the flag for multiple files) |
| `--trace` | `string` | — | Trace file path (debug mode) |
| `--complexity` | `simple \| medium \| complex` | — | Task complexity hint (plan mode) |
| `--timeout` | `number` | — | Abort after N seconds (exit 124) |
| `--budget` | `number` | — | Token budget override |
| `--dry-run` | `boolean` | `false` | Preview without applying (edit mode) |
| `--verbose` | `boolean` | `false` | Verbose output |
| `--debug` | `boolean` | `false` | Emit full prompts/responses as events |
| `--json` | `boolean` | `false` | Structured JSON output |

Attachments can also be added in the Studio Agent page. The first iteration
accepts PDF and JPEG/PNG/WebP/GIF images, up to 10 files and 7 MiB total (with
an individual file limit of 7 MiB). PDF pages are converted to text before the
LLM call; scanned/image-only PDFs are rejected with a request to attach the
relevant pages as images. Images are sent as image content and therefore require
the selected LLM tier to declare the `vision` capability. Unsupported tiers are
rejected before an agent session starts. Session history stores attachment
metadata only, not file contents.

---

## REST API

Base path: `/v1/plugins/agents`

Requires the `gateway` plugin.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/plugins/agents/run` | Start a new agent run |
| `GET` | `/v1/plugins/agents/runs/:runId/status` | Get run status |
| `POST` | `/v1/plugins/agents/runs/:runId/correct` | Send correction to running agent |
| `POST` | `/v1/plugins/agents/runs/:runId/stop` | Stop a running agent |
| `GET` | `/v1/plugins/agents/sessions` | List sessions |
| `POST` | `/v1/plugins/agents/sessions` | Create a new session |
| `GET` | `/v1/plugins/agents/sessions/:id` | Get session details |
| `GET` | `/v1/plugins/agents/sessions/:id/turns` | Get session turns |
| `GET` | `/v1/plugins/agents/sessions/:id/plan` | Get current plan |
| `POST` | `/v1/plugins/agents/sessions/:id/plan/approve` | Approve plan |
| `POST` | `/v1/plugins/agents/sessions/:id/plan/execute` | Execute approved plan |
| `POST` | `/v1/plugins/agents/sessions/:id/plan/spec` | Generate spec from plan |
| `GET` | `/v1/plugins/agents/sessions/:id/plan/spec` | Get current spec |
| `GET` | `/v1/plugins/agents/sessions/:id/changes` | List file changes |
| `GET` | `/v1/plugins/agents/sessions/:id/changes/:changeId/diff` | File change diff |
| `POST` | `/v1/plugins/agents/sessions/:id/rollback` | Rollback changes |
| `POST` | `/v1/plugins/agents/sessions/:id/approve` | Approve changes |

**WebSocket** — `/v1/ws/plugins/agents/sessions/:id/stream`
Real-time event stream for a session (all runs). Idle timeout: 1 hour.

---

## Studio

Adds an **Agent** page to KB Labs Studio.

| Page | Route | Description |
|------|-------|-------------|
| Agent | `/p/agent` | Session management, run history, live output |

Access via **Studio → Agent** in the sidebar.

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem (rw) | `**/*`, `.agent-memory/**` | File editing + memory storage |
| Environment | `KB_*` | Platform configuration |
| Platform | `llm`, `cache`, `analytics` | Core functionality |
| Quotas | 30 min timeout, 1 GB RAM | Complex multi-step tasks |

---

## Artifacts

| Path | Description |
|------|-------------|
| `.agent-memory/memory.json` | Persistent agent memory (facts, project context) |

## Architecture

- [Multi-agent orchestration design](./docs/architecture/multi-agent-orchestration.md) — working C1/C2 design for policies, safety checks, budgets, tools/MCP, worktrees, and future orchestrator collaboration.
- [External harness sub-agents](./docs/adr/0022-external-harness-subagents.md) — harness adapter and sub-agent lifecycle decision.

---

## Changelog

### 0.1.0

- Initial release: execute, plan, edit, debug modes
- Trace toolchain: stats, filter, iteration, context, diagnose
- File change history with rollback
- Quality reporting

---

## License

MIT
