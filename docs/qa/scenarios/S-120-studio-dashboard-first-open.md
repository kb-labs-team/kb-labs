---
id: S-120
title: Studio — Open the current dashboard
persona: solo-developer
area: studio
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [studio]
---

## Goal

Open `/` in local mode or as a signed-in secured administrator, with or without a registered project, and see the current Studio frame and platform health.

## Prerequisites

- [ ] One local-mode fixture and one secured-mode fixture with a signed-in administrator; each has a healthy gateway and can be run once with an empty project registry and once with a registered project.
- [ ] The secured account has `platform-settings:read`.
- [ ] For the degraded/unavailable step, the fixture can return a degraded health snapshot or a not-ready response.

## Steps

| # | Action | Expected |
|---|--------|----------|
| S-120.1 | In local mode with no registered projects, open `/` while gateway health is healthy and ready | The signed-in profile shows `local-admin` and `Online`; the sidebar shows Search (`⌘K`), Dashboard, Projects, Plugins, Adapters, Marketplace, Analytics, Observability, and Settings. The notification bell is present. The project control says `No registered project`. The footer shows `Connected` when the Studio registry has at least one plugin or `Disconnected` when it has none; a non-empty registry also shows its `<n> extensions` count. The footer also shows `local-admin`, `v0.1.0`, and Help. The body shows `Intelligence Dashboard` with `Real-time platform observability and performance analytics`, then `Dashboard` with `Current gateway health and readiness.`, then one `Gateway health` card with `Healthy` and `Gateway is ready.` There are no project activity cards on `/`. |
| S-120.2 | In local mode, register and select one project, then open `/` | The project control shows the selected project name. The dashboard headings and single Gateway health card remain the same because this card reads platform health/readiness; no project-run or project-plugin widget appears. Installed Studio plugin contributions, if any, appear as separate sidebar entries and their pages remain under their own routes. |
| S-120.4 | In secured mode, register and select one project, then open `/` as the administrator | The project control shows the selected project name and the administrator email remains in the profile and footer. Dashboard content is still the same platform Gateway health card; selecting a project does not add project activity cards to `/`. |
| S-120.5 | With a degraded health snapshot, then with readiness false, open `/` | Degraded health adds a `Gateway degraded` banner; `Details` lists each non-OK check and its message when checks are present, and `Retry` is available. Not-ready state shows `Gateway unavailable` and `Not ready at /api/ready` with the readiness reason when supplied. The Gateway health card shows the returned health tag and either `Gateway is ready.` or `Gateway is running but not ready.` |
| S-120.6 | Open the notification bell when there are no warning/error log notifications, then repeat with one error notification | The empty panel says `No critical logs`. With an error it shows the `ERROR` tag, timestamp, message or error name/message, plugin when present, and the first eight characters of the execution ID when present; selecting it opens that notification's log detail. |
| S-120.7 | Make the system health request fail, then open `/` | The page retains its headings and shows `Gateway health is unavailable` in the card. The Health banner says `Gateway unavailable`, displays its readiness detail when available, and offers `Retry`; the page does not become blank. |

## Source inventory

This table records the current rendered sections and their data sources so the case can be checked against the route implementation.

| Rendered section | Data source / visible state | Source |
|---|---|---|
| Studio frame, profile, navigation, status bar, project selector, Health banner | Auth identity/permissions; Studio registry; observability notifications; project selection | `studio/app/src/router.tsx:72-81,86-102,110-153,176-235`; `studio/app/src/components/project-context-selector.tsx:7-31` |
| Profile identity and login mode | Local session resolves as `local-admin`; secured session resolves to the signed-in user's email | `studio/app/src/auth/auth-provider.tsx:141-182`; `studio/app/src/auth/__tests__/auth-provider.test.tsx:80-102` |
| Studio plugin navigation and extension count | `GET /api/v1/studio/registry`; only registry plugins with Studio V2 pages contribute pages/menus | `studio/app/src/providers/registry-v2-provider.tsx:31-45,54-80`; `services/rest-api/app/src/routes/plugins.ts:904-943`; `studio/app/src/router.tsx:110-153,198-224` |
| Project control | `GET /api/v1/projects`; current ID in `localStorage` key `kb-studio-active-project`; no projects displays `No registered project` | `studio/data-client/src/sources/http-projects-source.ts:10-15`; `studio/app/src/providers/project-context-provider.tsx:3-34`; `studio/app/src/components/project-context-selector.tsx:7-31` |
| Global Health banner and Gateway health card | `GET /api/observability/health` and `GET /api/ready`; the banner adds affected-check messages from the health snapshot | `studio/data-client/src/sources/http-system-source.ts:32-75`; `studio/app/src/components/health-banner.tsx:9-132`; `studio/app/src/modules/dashboard/pages/dashboard-page.tsx:5-32` |
| Dashboard headings | Static `Intelligence Dashboard` and `Dashboard` headings and descriptions | `studio/app/src/modules/dashboard/layouts/dashboard-layout.tsx:5-15`; `studio/app/src/modules/dashboard/pages/dashboard-page.tsx:12-15` |
| Notification bell/panel | `useNotifications(sources.observability)`; warning/error logs; empty panel says `No critical logs` | `studio/app/src/router.tsx:94-102,176-196`; `studio/app/src/components/ui/kb-notification-bell.tsx:69-176,182-197` |
| Status bar items | API label is driven by Studio registry plugin count, extension count is the same registry, user is auth email, version is static `0.1.0`, and Help opens the KB Labs site | `studio/app/src/router.tsx:198-224`; `studio/app/src/components/ui/kb-status-bar.tsx:73-133` |
| Plugin contributions on `/` | V2 plugin menus add separate sidebar routes; plugin page content resolves under `/p/*` and is not embedded in the dashboard. The reusable dashboard widget components are not imported by the current root route. | `studio/app/src/router.tsx:112-153,303-311,320-355`; `studio/app/src/routes/plugin-page-v2.tsx:14-41`; `studio/app/src/modules/dashboard/pages/dashboard-page.tsx:1-34` |
