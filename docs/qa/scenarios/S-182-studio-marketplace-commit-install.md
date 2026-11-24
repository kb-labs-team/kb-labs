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
| S-182.1 | Open Studio **Marketplace** and search for `@kb-labs/commit` | The matching Commit package appears with its available version. |
| S-182.2 | Open the Commit package detail and select its **Overview** and **Permissions** tabs | The page identifies package `@kb-labs/commit`, the selected version, declared permissions and package details before installation. |
| S-182.3 | Choose project A in the detail page's **Project** selector and install Commit | Studio reports `Installed Commit for Project A`; Marketplace's **Installed** view for project A shows the pinned version and its Commit page is available. |
| S-182.4 | Choose project B in the detail page's **Project** selector and inspect Marketplace's **Installed** view | Project B remains unchanged and does not report Commit as installed. |
| S-182.5 | Choose project A, then request installation of `@kb-labs/unknown-package` from Marketplace's **Installed** view | Studio shows an actionable package-not-found alert using the error message and hint; project A's lock/config and installed list remain unchanged. |
| S-182.6 | In Marketplace's **Installed** view for project A, disable Commit, re-enable it, then uninstall it | Each action updates the visible enabled state; after uninstall Commit is absent from the installed list, and project B remains unchanged. |

## Pass criteria

Studio has one Marketplace navigation destination with separate **Browse** and
**Installed** views. The Marketplace detail page lets the user choose a
registered project and install the selected catalog package there. Installed
project plugins can be enabled, disabled, or removed from the Installed view;
an unknown-package install shows the shared error message and hint in an alert
and preserves project state. The case is planned until the user outcomes pass.
It is release true because Studio's Marketplace and Commit are in the release
scope.
