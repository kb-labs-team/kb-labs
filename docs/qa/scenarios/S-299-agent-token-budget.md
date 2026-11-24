---
id: S-299
title: Agent — Honor the effective token budget
persona: solo-developer
area: agents
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli, agent]
---

## Goal

As a solo developer, I can set a token budget for an agent run and trust that the run uses the command-line override, configured value, or documented default in that order.

## Prerequisites

- [ ] Agents plugin is installed in a project with an LLM adapter configured.
- [ ] The project can be inspected without modifying tracked files.

## Steps

| # | Action | Expected |
|---|---|---|
| S-299.1 | Run `kb agent run --task "Summarize the project name" --budget 12000 --json` when the project config sets a different `tokenBudget.maxTokens` | The run uses 12,000 as its total token budget; its result or budget-exhaustion event reports the effective limit and the run does not silently use the configured or default limit. |
| S-299.2 | Run the same safe task without `--budget` when `tokenBudget.maxTokens` is configured | The run uses the configured token limit. |
| S-299.3 | Run the same safe task with neither `--budget` nor a configured token limit | The documented agent default applies and is observable in run events. |
| S-299.4 | Run `kb agent run --task "Summarize the project name" --budget "" --json` or pass a non-numeric value | The command exits with invalid-flags code 3 and reports `E_INVALID_FLAGS` before dispatching the agent; no LLM request is made. |
| S-299.5 | Set a 100-token budget and use a mock provider whose first response reports 120 tokens and requests one continuation tool call | The response that crosses the limit may exceed it by that single response's usage; the agent completes that response's tool handling, then stops with `hard_budget` before making another provider request. |
