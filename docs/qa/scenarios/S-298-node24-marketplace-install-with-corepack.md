---
id: S-298
title: Marketplace plugin install without standalone pnpm
persona: solo-developer
area: platform-core
priority: P0
status: active
release: true
modes: [local]
surfaces: [cli]
---

## Goal

Install a scenario plugin through the Marketplace on a clean Node 24 host that
has Corepack but no standalone `pnpm` executable.

## Environment

- [ ] Node 24 with its bundled Corepack available on `PATH`
- [ ] No standalone `pnpm` executable on `PATH`
- [ ] A fresh platform root and a candidate release index with an available Marketplace source

## Steps

| # | Action | Expected |
|---|---|---|
| S-298.1 | Install the candidate with `kb-create install` and select the `explore` scenario | Installation succeeds and the receipt records `@kb-labs/commit` as installed from the Marketplace. Corepack uses the release-pinned pnpm; its package-manager files stay under the platform extension-store cache, and no global pnpm install or user-level package-manager state is needed. |

## Pass criteria

The Marketplace plugin is available to the installed host, and a fresh install
completes without a standalone pnpm executable.
