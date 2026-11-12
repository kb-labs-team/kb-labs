---
id: S-292
title: Install an adapter into the platform from the marketplace
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: true
modes: [local]
surfaces: [cli, agent]
---

## User value

A platform owner can install an adapter package from the marketplace into the installed platform with a pinned version and recorded source provenance.

## Preconditions

- [ ] The installed platform is configured with a marketplace source that contains the adapter package.

## Steps

| # | Action | Expected |
|---|---|---|
| S-292.1 | Run `kb marketplace install @kb-labs/adapters-vibeproxy --scope platform` | The installed platform contains the exact resolved adapter version. Its marketplace lock records the package identity, version, integrity, and marketplace source provenance. |

