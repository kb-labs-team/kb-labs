---
id: S-321
title: Studio Marketplace — browse and install platform adapters
persona: platform-owner
area: studio
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [studio, api]
---

## User value

A platform owner can find adapters in the Marketplace Registry and install one for the whole platform without changing its active adapter configuration.

## Preconditions

- [ ] The platform Marketplace source points to a Registry containing a published adapter and a published plugin.
- [ ] One administrator has `platform-settings:write`; one member does not.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Open the Marketplace adapters catalog in Studio | Entries come from the Marketplace Registry and show the canonical package identity and Registry-declared `adapter` type; runtime plugin discovery is not used as the catalog. |
| S-321.2 | Install a listed adapter as an administrator, then inspect the platform marketplace lock and platform config | The response identifies `primaryKind: adapter`; the exact package version is recorded under the lock's `adapters` map. No project lock is changed and no `platform.adapters` binding or `platform.adapterOptions` value is written. |
| S-321.3 | Submit a Registry plugin identity to the adapter install operation | The operation fails with a typed invalid-package response and makes no package or lock changes. |
| S-321.4 | Submit an adapter install request as a member without `platform-settings:write` | The operation is denied and makes no package or lock changes. |
| S-321.5 | Call the generic Marketplace install API for a platform package as that same member | The operation is denied; the generic install route cannot bypass the platform settings permission. |
| S-321.6 | Attempt to install an adapter whose Registry metadata, package manifest, or adapter manifest identity/version disagree | Installation fails before replacing the installed package or recording a lock entry; any previous package remains intact. |
| S-321.7 | Submit a project-scope operation whose project root aliases the platform root | The operation is rejected and cannot read or mutate the platform lock under project scope. |

## Source

The Registry owns package identity and primary kind. The Marketplace service resolves and verifies the Registry artifact and adapter manifest. Adapter selection remains an explicit platform configuration action, as specified by the platform adapter decision.
