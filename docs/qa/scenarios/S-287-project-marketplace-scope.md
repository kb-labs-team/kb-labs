---
id: S-287
title: Marketplace — installed platform and project lock scope
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A registered project uses its installed platform and receives actionable Marketplace lock errors.

## Steps

| # | Action | Expected |
|---|---|---|
| S-287.1 | Run the installed `kb marketplace sync` in a registered project with `pnpm-workspace.yaml` and `platform.mode: development` in its config | The installed platform remains the platform root; sync uses project scope. A development launcher that explicitly declares the checkout as its platform retains the shared platform scope. |
| S-287.2 | Run Marketplace doctor, uninstall, update, list and sync against a rejected project lock | Each reports the catalogued lock error with its file and next command; none reports a missing lock, empty success, or successful mutation. Project sync repairs a lock whose only project-scope violation is adapter entries, preserving plugins. |
| S-287.3 | Uninstall an ID absent from a valid project lock, and separately pass multiple IDs to uninstall | An absent ID fails with a catalogued error. Multiple IDs are handled separately or rejected; they are never combined into one ID. |
| S-287.4 | Run a Marketplace command that reports an error in human mode | The invocation renders one error, without `KB_CLI_RESULT_UNAVAILABLE` after the reported error. |
| S-287.5 | Start a service in a registered project containing workspace adapters while the distinct platform config enables development mode | Workspace adapter discovery uses the platform root; project workspace adapters are not loaded. |
| S-287.6 | Launch a development checkout whose launcher declares its binary path, without `KB_PLATFORM_ROOT`, or load its platform configuration with `platform.dir` pointing elsewhere | The launcher resolves the declared checkout as its platform; configuration cannot replace that root. |
| S-287.7 | Resolve a platform using a malformed launcher module URL without an explicit root | Resolution fails with the URL conversion error rather than selecting another root. |
