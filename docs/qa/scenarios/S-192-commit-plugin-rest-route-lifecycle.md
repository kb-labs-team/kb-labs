---
id: S-192
title: Marketplace — call Commit REST routes after installation
persona: platform-developer
area: marketplace
priority: P0
status: planned
release: true
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

Install the release Commit plugin, call a declared project REST route, then
uninstall it and verify that its route is no longer available.

## Prerequisites

- [ ] A registered project and authenticated project API client.
- [ ] A published `@kb-labs/commit` marketplace version compatible with the platform.
- [ ] Commit is absent from the platform marketplace lock. When needed, remove
  it through `kb marketplace uninstall @kb-labs/commit --scope platform`
  before starting the project-scoped flow.

## Steps

| # | Action | Expected |
|---|---|---|
| S-192.1 | With no runtime active for the registered project, GET `/api/v1/projects/<project-id>/unknown-service/health` | Gateway returns HTTP 404 with the catalogued `KB_PROJECT_SERVICE_NOT_FOUND` envelope and its catalogue-provided hint. Host health still reports no runtime for that project. |
| S-192.2 | After S-192.7 passes, run `kb marketplace install @kb-labs/commit@<version>` in the registered project | The selected Commit version is installed and enabled in that project's marketplace state. The platform lock remains without Commit, so its project route is served by the project installation. |
| S-192.3 | After S-192.2 completes, GET `/api/v1/projects/<project-id>/rest/plugins/commit/status` for the registered project without restarting any service | The Commit handler answers successfully with its status response; the response's `data.scope` is `root`, the default Commit scope for the project checkout. |
| S-192.4 | Run `kb marketplace uninstall @kb-labs/commit` in the project, then GET `/api/v1/projects/<project-id>/rest/plugins/commit/status` again and inspect the platform lock | The request returns HTTP 404 with the typed envelope `{ok:false,error:{code:"KB_PLUGIN_NOT_INSTALLED",message:"Plugin is not installed in this project.",hint:"Run `kb marketplace install @kb-labs/commit` in this project.",correlationId:<non-empty>}}`; the platform lock still has no Commit entry. |
| S-192.5 | Run `kb marketplace install @kb-labs/commit@<version>` again, then GET `/api/v1/projects/<project-id>/rest/plugins/commit/status` | The Commit handler answers successfully without restarting any service. |
| S-192.6 | GET `/api/v1/projects/<project-id>/rest/api/v1/plugins/commit/status` | Gateway returns HTTP 404 with the catalogued `KB_RUNTIME_RESOURCE_NOT_FOUND` envelope; the internal `/api/v1` mount prefix is not public. |
| S-192.7 | Before S-192.2, inspect the platform marketplace lock and GET `/api/v1/projects/<project-id>/rest/plugins/commit/status` | Commit is absent from the platform lock, and the route returns HTTP 404 with `KB_PLUGIN_NOT_INSTALLED`; this proves the project install starts without a platform copy keeping the route mounted. |

## Pass criteria

The installable artifact is `@kb-labs/commit` and its manifest ID is
`@kb-labs/commit` (`plugins/commit/src/package.json:2`;
`plugins/commit/src/manifest.ts:63`). Commit declares
`GET /v1/plugins/commit/status` in its manifest and response
contract (`plugins/commit/src/manifest.ts:227-247`;
`plugins/commit/src/contracts/routes.ts:7-24`). REST route mounting replaces
the manifest `/v1` prefix with the REST service's internal `/api/v1` base path
(`services/rest-api/app/src/routes/plugins.ts:404-450`); the Gateway's project
service declaration strips that internal base from the public URL. `KB_PLUGIN_NOT_INSTALLED` is the typed response for a route whose plugin is
absent from the effective discovered plugin set. For the known Commit prefix,
the handler resolves `@kb-labs/commit` from the extension store and gives
the exact project install command. For an unknown prefix with no matching stored
manifest, it gives `kb marketplace plugins list` without guessing a package name.
Both branches use the catalogued `KB_PLUGIN_NOT_INSTALLED` message; the known
Commit install hint is asserted by S-192.4. The case is release-scoped because
Commit is the release plugin and REST routes are part of its advertised plugin
surface.
