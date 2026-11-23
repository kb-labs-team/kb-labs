---
id: S-300
title: Marketplace — use platform package manager config for plugin dependencies
persona: solo-developer
area: marketplace
priority: P1
status: planned
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
- [ ] Start with an empty extension store entry for the plugin version; an existing immutable entry is reused without re-resolving dependencies.

This case remains planned until a public CLI journey verifies the install result, platform lock, and both registry request logs together.

## Steps

| # | Action | Expected |
|---|---|---|
| S-300.1 | Run `kb marketplace install @fixture/platform-plugin@1.0.0 --scope platform --json` and inspect the result, platform Marketplace lock, and both registry request logs | Installation succeeds and records the plugin in the platform Marketplace lock. Source A serves the plugin tarball; registry B serves transitive dependency metadata and bytes using credentials from the platform `.npmrc`, while the ordinary user `.npmrc` remains available. The Marketplace source URL is not passed as pnpm's dependency registry, and the package manager config is not copied into the published store entry or included in reports. |
| S-300.2 | Configure source A to return metadata without a tarball URL or with a non-absolute/non-HTTP(S) `dist.tarball`, then run the same platform install against an empty store | Installation fails before pnpm starts or registry B receives a request; the plugin itself must never be fetched from dependency registry B. |
| S-300.3 | Install a different plugin in project scope while platform `.npmrc` routes the same dependency scope to registry B and the project source resolves dependencies through registry A | Registry A serves the project plugin's transitive dependencies. Platform `.npmrc` routing and credentials are not applied to this project install. |
| S-300.4 | Make registry B reject the platform credential, then inspect the serialized install error | The error reports a safe failure code/status without exposing registry URLs, usernames, tokens, or pnpm's credential diagnostics. |

