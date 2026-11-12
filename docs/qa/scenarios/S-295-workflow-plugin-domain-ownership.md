---
id: S-295
title: Workflow routes plugin outcomes and permissions govern sidecar calls
persona: plugin-author
area: platform
priority: P1
status: planned
release: false
modes: [local]
surfaces: [api]
---

## Goal

A plugin author can keep domain work inside a plugin, while project workflow policy routes the plugin's typed outcome and undeclared sidecar calls are refused.

## Steps

| # | Action | Expected |
|---|---|---|
| S-295.1 | Run a plugin handler that calls `ctx.invoke` when its manifest does not declare `invoke.allow` | The call is denied with `KB_PLUGIN_PERMISSION_DENIED`, and the target plugin is not invoked. |
| S-295.2 | Run a plugin handler that calls `ctx.shell.exec` for a command absent from its manifest `shell.allow` | The call is denied with `KB_PLUGIN_PERMISSION_DENIED`, and the process executor is not called. |
| S-295.3 | Run a project workflow whose plugin step returns a typed `status` of `partial` or `success`, and whose `builtin:gate` routes `partial` to step A and `success` to step B | The workflow run executes only the branch selected by the gate: step A for `partial`, or step B for `success`; the other branch is skipped. |
