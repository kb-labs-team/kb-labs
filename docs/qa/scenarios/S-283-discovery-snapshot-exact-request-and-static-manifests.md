---
id: S-283
title: Plugin discovery snapshots match their exact request and static manifest data
persona: plugin-author
area: plugins
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A plugin author reopening the catalog sees commands only from the current discovery roots and the currently built JSON manifest, without executing plugin modules.

## Prerequisites

- [ ] A workspace contains a platform root and a separate project root.
- [ ] A plugin declares a static JSON manifest artifact next to its built module.

## Steps

| # | Action | Expected |
|---|---|---|
| S-283.1 | Open the catalog with both platform and project roots, then reopen it with only the project root. | Commands discovered from the removed platform root are absent immediately after the second open. |
| S-283.2 | Declare a plugin module manifest that imports a helper, then open the catalog with its adjacent JSON artifact. Edit only the helper and reopen; then edit the JSON artifact and reopen again. | Discovery does not execute the module or helper; helper-only edits do not change commands, and JSON edits update the registered commands. |
