---
id: S-029
title: S-029 — Workflow failure is visible and actionable
persona: solo-developer
area: workflow
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

When a workflow step fails, the user can identify the failed step, error, and relevant logs.

## Prerequisites

- [ ] Project workflow containing a shell step that exits non-zero.

## Steps

| # | Action | Expected |
|---|---|---|
| S-029.1 | Run the failing workflow using `kb workflow run --workflow-id=<project>/fails` | CLI returns a run ID. |
| S-029.2 | Run `kb workflow runs view <runId>` after the step fails | The persisted run reaches `failed` without a daemon restart and names the failed step with its useful error message. |
| S-029.3 | Run `kb workflow runs logs <runId>` | Output shows the failing command’s diagnostic context without a raw service stack trace. |
| S-029.4 | Run a workflow command step that returns a structured failure with diagnostics, then inspect it with `kb workflow runs view <runId> --json=all` | The failed step retains the failure code, hint, diagnostics, and any captured command outputs in persisted run detail. |
