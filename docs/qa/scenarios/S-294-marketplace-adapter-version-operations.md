---
id: S-294
title: Repeat and bump a marketplace adapter install
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A platform owner can safely repeat an adapter installation or explicitly move to a different exact version.

## Preconditions

- [ ] The installed platform has a marketplace source with two versions of the same adapter package.

## Steps

| # | Action | Expected |
|---|---|---|
| S-294.1 | Install the same adapter version again | The operation is a no-op and preserves the existing lock entry and installed package. |
| S-294.2 | Install a different adapter version over the installed version | The operation reports an explicit version bump and updates the exact version and provenance in the lock. |
