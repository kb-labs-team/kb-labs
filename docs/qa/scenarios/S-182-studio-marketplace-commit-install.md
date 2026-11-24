---
id: S-182
title: Studio Marketplace — find and install Commit in one project
persona: solo-developer
area: marketplace
priority: P0
status: planned
release: true
modes: [local, secured]
surfaces: [studio, api]
---

## Goal

Find the Commit package, review its release identity and permissions, install
it for one project, and manage its installed state from the same Marketplace
area without changing another project.

## Prerequisites

- [ ] Studio is connected to a Marketplace catalog containing `@kb-labs/commit`.
- [ ] Projects A and B are registered, with neither project initially containing Commit.

## Steps

| # | Action | Expected |
|---|---|---|
| S-182.1 | Open Studio **Marketplace** and select project A | Marketplace opens on installed entities grouped under **Plugins** for project A and offers an **Open marketplace** action. |
| S-182.2 | Choose **Open marketplace**, search for `@kb-labs/commit`, open its details, and inspect **Overview** and **Permissions** | The package catalog opens separately from installed entities; the matching package appears with its available version, declared permissions and package details before installation. |
| S-182.3 | Choose project A in the detail page's **Project** selector and install Commit | Studio reports `Installed Commit for Project A`; Marketplace's **Plugins** category shows the pinned version and its Commit page is available. |
| S-182.4 | Choose project B in the detail page's **Project** selector, return to Marketplace, and inspect its **Plugins** category | Project B remains unchanged and does not report Commit as installed. |
| S-182.5 | Choose project A, search the package catalog for `@kb-labs/unknown-package`, and request installation | Studio shows an actionable package-not-found alert using the error message and hint; project A's lock/config and installed list remain unchanged. |
| S-182.6 | On Marketplace for project A, disable Commit, re-enable it, then remove it | Each action updates the visible enabled state; after removal Commit is absent from the Plugins category, and project B remains unchanged. |

## Pass criteria

Studio opens Marketplace on installed project entities grouped by type; its
Plugins category supports enable, disable, and remove. The **Open marketplace**
action opens package search and details separately, where a selected package
can be installed into a registered project. An unknown-package install shows
the shared error message and hint in an alert and preserves project state. The
case is planned until the user outcomes pass. It is release true because
Studio's Marketplace and Commit are in the release scope.
