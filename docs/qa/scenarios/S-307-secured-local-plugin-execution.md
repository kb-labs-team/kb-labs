---
id: S-307
title: Secured CLI — publish with an explicitly configured local execution backend
persona: solo-developer
area: plugin-execution
priority: P1
status: active
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

An authenticated developer can publish a project plugin from the installed CLI
when the secured platform has no online execution-capable Gateway host. An
explicit local execution mode preserves the registered project context and
package working directory while CLI authentication remains enforced.

## Prerequisites

- [ ] An installed secured platform with an authenticated user and a registered project.
- [ ] The project contains a built Commit package and no online execution-capable Workspace Agent.
- [ ] The authenticated user can publish to the configured Registry.

## Steps

| # | Action | Expected |
|---|---|---|
| S-307.1 | Run `kb workspace list --json`; set `platform.execution.mode` with `kb config set --scope platform platform.execution.mode subprocess --json`, then `worker-pool`; from a package root inside the registered project, run installed `kb hub publish --json` for each mode | The workspace list has no online execution-capable agent. Both publish commands succeed and report their package versions. The publisher reads `package.json` and its compiled manifest from the command's current package directory, and the authenticated user's Registry package list contains each published version. No Gateway execution host is required; the secured CLI authentication gate remains active. |
