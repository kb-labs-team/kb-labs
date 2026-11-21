---
id: S-291
title: Agents — run external coding agents as measured sub-agents
persona: solo-developer
area: agents
priority: P1
status: planned
release: false
modes: [local]
surfaces: [agent, workflow]
---

## Goal

A lead runs an external coding agent as a governed sub-agent, can resume its session, receives typed outcomes and failures, and sees measured usage alongside native agent runs.

## Prerequisites

- [ ] Agents and the selected vendor runner are installed in the project.
- [ ] The platform execution grants required by the runner are available.
- [ ] Workflow execution is available for the project.

## Steps

| # | Action | Expected |
|---|---|---|
| S-291.1 | Invoke the agent workflow handler with a task and a declared runner id, without a session id. | A fresh sub-agent run returns a typed terminal outcome, a vendor session id, its last message, and measured usage fields when the runner supplies them. |
| S-291.2 | Invoke the handler with the session id returned by S-291.1 and a follow-up task. | The selected runner resumes that session and returns the updated session id and last message. |
| S-291.3 | Run a worker whose first two results are `partial` and whose third result is `done`. | The coordinator resumes the same session at most twice, returns `done`, and reports all three rounds. |
| S-291.4 | Run a review role whose result is `partial`. | The review returns after one round without continuation. |
| S-291.5 | Run a worker that returns a vendor usage-limit response with a parseable reset time. | The result is a typed retryable rate-limit failure carrying the supplied `retryAfterMs`; the workflow boundary receives that failure. |
| S-291.6 | Run when a required execution prerequisite is unavailable. | A typed preflight failure is returned before invocation; the vendor executable is invoked zero times. |
| S-291.7 | Run with a required platform permission denied. | A typed permission-denied result is returned promptly and the process does not silently hang or access the denied resource. |
| S-291.8 | Inspect the completed vendor run in `kb agent quality report`. | The vendor run appears beside a native run with known input/output tokens, wall time and rounds; unknown cost remains unavailable and is not estimated. |
| S-291.9 | Request a declared runner id that cannot be resolved. | The parent receives the catalogued typed unknown-runner failure and no child process starts. |
| S-291.10 | Set a finite parent token budget and select a runner that does not declare usage reporting. | A typed budget-unmeasurable refusal occurs before the child starts. |
| S-291.11 | Set a finite parent token budget and select a runner that declares usage reporting but returns no usage. | The run returns typed invalid output with missing measurement details; the missing usage is not recorded as zero. |
| S-291.12 | Cause a contributing tier result to omit token usage. | The aggregate `tokensUsed` and `usage.totalTokens` remain unknown; CLI, Studio, ledger, and analytics do not present the missing aggregate as zero. |
