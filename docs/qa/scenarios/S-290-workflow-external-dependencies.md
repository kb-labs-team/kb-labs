---
id: S-290
title: Workflow — External dependencies and stalled steps
persona: solo-developer
area: workflow
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, api, studio]
---

## Goal

A workflow author can recover from temporary external failures and detect a silent stalled step without losing run state.

## Prerequisites

- [ ] A registered project and a running workflow service are available.
- [ ] The test workflows use disposable local commands and resources.
- [ ] In secured mode, an authenticated gateway session is available.

## Steps

| # | Action | Expected |
|---|---|---|
| S-290.1 | Run shell, plugin and builtin steps that each report a typed failure with kind, retryability, message, and optional dependency and retry time | Each failed step exposes the same typed failure fields through its own result channel. A nonzero shell exit without a typed result reports kind `exit`, the exit code and the stderr tail. |
| S-290.2 | Run a shell step that reports a retryable dependency failure with a future retry time and a matching retry policy; inspect `kb workflow runs status`, `kb workflow runs watch`, the run REST response and Studio | The step is `waiting` with its reason, dependency and until-time. It does not retry before that time and automatically resumes afterward. |
| S-290.3 | Restart the workflow daemon while the step from S-290.2 is waiting | The persisted wait remains visible and the step resumes automatically at its due time. |
| S-290.4 | Cancel a run while its step is waiting using `kb workflow runs cancel <run-id>` | The run becomes `cancelled` and the step does not resume later. |
| S-290.5 | Report a retry time beyond the configured bounded wait ceiling with an otherwise eligible retry policy | The step terminates with a typed ceiling failure instead of waiting indefinitely. |
| S-290.10 | Start a step with `idleTimeoutMs` whose child and descendant remain silent longer than the timeout | The owned process tree terminates and the step reports typed kind `stalled`; its retry policy determines whether it retries. Output or heartbeat activity resets the idle deadline. |
