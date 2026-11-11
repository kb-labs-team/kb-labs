---
id: S-046
title: Studio — Switch project context and inspect its extensions
persona: solo-developer
area: studio
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [studio]
---

## Goal

A Studio user selects among registered projects and verifies that each shows its own plugin set while adapters remain platform-owned.

## Prerequisites

- [ ] Studio host, two registered projects, project A without plugins, and project B with Commit attached.

## Steps

| # | Action | Expected |
|---|---|---|
| S-046.1 | Open Studio and select the project named `project-a` in the project selector | The active project selector displays `project-a`. |
| S-046.2 | Open `/plugins` with project A selected | The Plugins view reports `No plugins found`; the built-in workflow service is not listed as a project plugin, and no project adapter settings are shown. |
| S-046.3 | Select the project named `project-b`, then reopen `/plugins` | The selector displays `project-b` and Plugins lists only `@kb-labs/commit`; platform adapter bindings remain global. |
| S-046.4 | Open Projects | The table shows each registered project's name, path, runtime status, `.kb/` declaration, and last-used value; an empty registry instead shows `No projects registered` and `Add project`. |
| S-046.5 | Choose Add project, enter an initialized project folder, and select Register | A success message identifies the registered folder and the project appears in the table. |
| S-046.6 | Choose Remove for the new project's row and confirm with Unregister | The row disappears and Studio reports `Unregistered <name>; files were not touched.`; project folder and runtime state remain. |
