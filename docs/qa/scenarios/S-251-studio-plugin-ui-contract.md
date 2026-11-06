---
id: S-251
title: Studio — load and isolate an installed plugin UI
persona: plugin-developer
area: studio
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [studio]
---

## Goal

Install and enable a project plugin that declares Studio pages, use its navigation entry, and confirm that its UI remains scoped to that project and isolated from other Studio pages when it crashes.

## Prerequisites

- [ ] Two registered projects with Studio access.
- [ ] Project A has a plugin package whose manifest declares a Studio V2 page and menu entry; its page can be configured to throw a deterministic render error.
- [ ] Project B does not have that plugin installed.

## Steps

| # | Action | Expected |
|---|---|---|
| S-251.1 | Install the plugin in project A with `kb marketplace install <PLUGIN_PACKAGE>@<VERSION>` and enable it if the package is disabled | The project A marketplace state records the exact package version as enabled; the project B marketplace state is unchanged. |
| S-251.2 | Open Studio in project A and inspect its plugin navigation | The manifest-declared page is available at its declared route and the menu entry targets that page. |
| S-251.3 | Switch Studio to project B and inspect the same navigation and route | The plugin menu entry is absent and its project A page is not available in project B. |
| S-251.4 | Configure the plugin page in project A to throw its fixture render error, then open it | Studio shows the plugin page error boundary for that plugin and page; the Studio shell and navigation remain usable, and another Studio page can still be opened. |
| S-251.5 | Disable the plugin in project A and refresh the Studio registry | The disabled plugin's page and menu entry are absent in project A. |
| S-251.6 | Re-enable, then uninstall the plugin from project A and refresh the Studio registry | The plugin's page and menu entry are absent; project B remains unchanged. |

## Source

The Studio registry is assembled from discovered manifests by `services/rest-api/app/src/routes/plugins.ts`. The Commit manifest demonstrates the V2 `studio.pages` and `studio.menus` contract in `plugins/commit/src/manifest.ts`. Plugin page crashes are isolated by `studio/federation/src/page-error-boundary.tsx`. Project-specific Marketplace state is owned by `services/marketplace/core/src/marketplace-service.ts`.
