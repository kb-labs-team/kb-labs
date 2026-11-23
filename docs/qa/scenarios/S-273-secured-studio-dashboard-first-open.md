---
id: S-273
title: Secured Studio — open the dashboard without registered projects
persona: solo-developer
area: studio
priority: P1
status: active
release: false
modes: [secured]
surfaces: [studio]
---

## Goal

Open the Studio dashboard in secured mode as an administrator when no project
has been registered and see the current platform health and Studio frame.

## Prerequisites

- [ ] A secured-mode fixture with a signed-in administrator, healthy gateway, and no registered projects.
- [ ] The secured account has `platform-settings:read`.

## Steps

| # | Action | Expected |
|---|---|---|
| S-273.1 | In secured mode with no registered projects, sign in as the administrator and open `/`; request `GET /api/v1/studio/registry` and `GET /api/v1/plugins/registry` with the signed-in Gateway session | Both authenticated requests return HTTP 200 with `{ ok: true, data: ... }`. The Studio `data` has `schema: "kb.studio/2"`, `schemaVersion: 2`, and a `plugins` array; the catalog `data` has a `manifests` array. Empty arrays are valid and render the empty Marketplace state; a missing route is reported as unavailable, not as a successful zero-plugin catalog. The same dashboard headings, Gateway health card, project empty label, Search, notification bell, core sidebar entries, and footer sections as S-120.1 are visible. The profile and footer user item show the signed-in administrator email. Settings is present because this administrator has `platform-settings:read`; the API connection label and extension count still reflect the Studio registry. |
