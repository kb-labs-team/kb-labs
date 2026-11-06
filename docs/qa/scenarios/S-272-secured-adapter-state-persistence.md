---
id: S-272
title: Secured mode — preserve built-in adapter state across restart
persona: solo-developer
area: platform-core
priority: P0
status: active
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

Verify that built-in persistent adapters retain workflow, document, and KV
state through a secured platform host restart, and that the administrator
account remains usable.

## Prerequisites

- [ ] A fresh secured install with a configured administrator account and one initialized project.
- [ ] The platform package registry is available for the install itself.

## Steps

| # | Action | Expected |
|---|---|---|
| S-272.1 | In a fresh secured install, create an administrator account, complete a workflow run, write one document and one KV value through the platform's installed service APIs, run `kb-create restart --platform-root "$PLATFORM_ROOT"`, then read each item again | The administrator account remains usable; the completed workflow run, document, and KV value remain available with their original IDs and contents. `kb adapter list --json` and `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` show the configured persistent built-in providers for `documentDatabase`, `kvStore`, `storage`, `analytics`, and the log slots in secured mode. |

## Dependencies

- Workflow run-record persistence through the configured `IStorage` adapter is
  owned by the workflow stream.
- The secured administrator account is created during secured installation.
