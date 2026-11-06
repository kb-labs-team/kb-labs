---
id: S-003
title: S-003 — Scaffold and link a plugin author’s local loop
persona: plugin-author
area: plugins
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A plugin author scaffolds a plugin, builds it, links it into a project with the V2 marketplace, invokes a command, and sees an edit after rebuilding.

## Prerequisites

- [ ] V2 platform and initialized project; pnpm and workspace dependencies available.
- [ ] In secured mode, sign in to the installed CLI as an administrator before linking the generated plugin.

## Steps

| # | Action | Expected |
|---|---|---|
| S-003.1 | On an installed platform, run `kb scaffold run plugin demo --mode standalone --yes` | Scaffold creates exactly one package under `.kb/plugins/demo` in standalone mode, named `@kb-labs/demo`, and that package can import `@kb-labs/sdk`; the installed platform contains the SDK's runtime peer packages as shared platform artifacts, including `@kb-labs/shared-tool-kit`. |
| S-003.2 | Build the generated plugin using its documented package build command | The root plugin package builds successfully and emits its manifest. |
| S-003.3 | Run `kb marketplace plugins add --link .kb/plugins/demo` | `kb marketplace plugins list --json` shows the linked plugin as a local project plugin; `.kb/marketplace.lock` records the same plugin ID and its relative path. |
| S-003.4 | Run `kb --help` and `kb demo hello` | The `demo` command group is listed and the command prints `Hello, World from demo!`. |
| S-003.5 | Change the greeting in the generated plugin source under `src/core`, rebuild with `pnpm build`, and run `kb demo hello` again | The command prints the edited greeting, showing the author loop works without publishing. |
| S-003.6 | Run `kb marketplace plugins remove <plugin ID returned by kb marketplace plugins list --json>` | That plugin ID is removed from the project plugin list and `.kb/marketplace.lock`. |
| S-003.7 | From the registered plugin workspace, run `kb docs generate-cli-reference --output docs/CLI-REFERENCE.md` | The command writes the generated CLI reference into that project. Running it outside a registered project fails before writing, because its default and requested output paths are project files. |
| S-003.8 | Run `kb marketplace plugins add --link /path/to/plugin` | CLI rejects the absolute path with a clear validation message that `--link` must be relative to the selected scope directory; it does not call the marketplace. |
