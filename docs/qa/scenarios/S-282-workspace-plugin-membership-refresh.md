---
id: S-282
title: Workspace plugin commands refresh when package membership changes
persona: plugin-author
area: plugins
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A plugin author can add or remove a plugin package inside the existing workspace globs and have the CLI command catalog reflect the current workspace packages after reopening it.

## Prerequisites

- [ ] The project has a `pnpm-workspace.yaml` that includes `plugins/*`.
- [ ] A workspace plugin package declares a CLI command in its plugin manifest.

## Steps

| # | Action | Expected |
|---|---|---|
| S-282.1 | Add plugin package `@kb-labs/b` with a declared `sample from-b` command under the existing `plugins/*` workspace glob, then run `kb sample from-b --help`. | The CLI resolves the declared command from the newly added workspace package. |
| S-282.2 | Remove plugin package `@kb-labs/a`, which declared `sample from-a`, then run `kb sample from-a --help`. | The CLI reports that the removed package's command is unknown. |
