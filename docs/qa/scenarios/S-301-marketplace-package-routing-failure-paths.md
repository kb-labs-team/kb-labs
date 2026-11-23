---
id: S-301
title: Marketplace — reject unsafe platform package routing failures
persona: solo-developer
area: marketplace
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

Platform Marketplace installs fail safely when the package source or its dependency registry is invalid or unavailable.

## Prerequisites

- [ ] Configure Marketplace source A and platform package manager registry B in an isolated local fixture.
- [ ] Start with an empty extension-store entry for each test package version.

## Steps

| # | Action | Expected |
|---|---|---|
| S-301.1 | Configure source A to return metadata without a tarball URL or with a non-absolute/non-HTTP(S) `dist.tarball`, then run a platform install against an empty store | Installation fails before pnpm starts or registry B receives a request; the plugin itself is never fetched from dependency registry B. |
| S-301.2 | Install a different plugin in project scope while platform `.npmrc` routes the same dependency scope to registry B and the project source resolves dependencies through registry A | Registry A serves the project plugin's transitive dependencies. Platform `.npmrc` routing and credentials are not applied to this project install. |
| S-301.3 | Make registry B reject the platform credential, then inspect the serialized install error | The error reports a safe failure code/status without exposing registry URLs, usernames, tokens, or package-manager credential diagnostics. |
