---
id: S-300
title: Marketplace — use platform package manager config for plugin dependencies
persona: solo-developer
area: marketplace
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A developer installs a platform-scoped Marketplace plugin whose tarball comes from the configured Marketplace source while pnpm resolves its transitive dependencies using the installed platform package manager configuration.

## Prerequisites

- [ ] Configure Marketplace source A to serve a plugin tarball.
- [ ] Configure the installed platform `.npmrc` to route the plugin's transitive dependency through a separate reachable registry B.
- [ ] Make registry B require credentials from the platform package manager configuration.

## Steps

| # | Action | Expected |
|---|---|---|
| S-300.1 | Run `kb marketplace install @fixture/platform-plugin@1.0.0 --scope platform --json` and inspect the result, platform Marketplace lock, and both registry request logs | Installation succeeds and records the plugin in the platform Marketplace lock. Source A serves the plugin tarball; registry B serves transitive dependency metadata and bytes using credentials from the platform `.npmrc`. The Marketplace source URL is not passed as pnpm's dependency registry, and the package manager config is not copied into the synthetic project or included in reports. |

