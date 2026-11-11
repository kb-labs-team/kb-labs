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
| S-273.1 | In secured mode with no registered projects, sign in as the administrator and open `/` | The same dashboard headings, Gateway health card, project empty label, Search, notification bell, core sidebar entries, and footer sections as S-120.1 are visible. The profile and footer user item show the signed-in administrator email. Settings is present because this administrator has `platform-settings:read`; the API connection label and extension count still reflect the Studio registry. |
