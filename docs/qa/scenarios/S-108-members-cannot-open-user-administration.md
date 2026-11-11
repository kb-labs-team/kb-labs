---
id: S-108
title: Studio — members cannot open user administration
persona: team-member
area: studio
priority: P1
status: active
release: false
modes: [secured]
surfaces: [studio]
---

## Goal

Members can use project, plugin, and workflow pages but do not see or open tenant user administration.

## Prerequisites

- [ ] Secured Studio and a signed-in tenant-member account.

## Steps

| # | Action | Expected |
|---|---|---|
| S-108.1 | Inspect the Studio navigation while signed in as a member | No Users or Invites navigation entry is shown. |
| S-108.2 | Open `/admin/users` and `/admin/invites` directly | Each route displays `403 — Forbidden` and `You do not have permission to view this page.`; neither route requests or renders tenant user or invite records. |
| S-108.3 | Open a project, plugin, or workflow page available to the member | The page remains available under the member's project-use permissions. |
