---
id: S-106
title: Studio — administer users and invites
persona: team-admin
area: studio
priority: P0
status: active
release: false
modes: [secured]
surfaces: [studio]
---

## Goal

A tenant administrator manages users and pending invites from one secured Users page.

## Prerequisites

- [ ] Secured gateway and signed-in tenant-admin account with `users:read`, `users:write`, `invites:read`, and `invites:write`.
- [ ] One active member, one disabled member, and one pending invite in the tenant.

## Steps

| # | Action | Expected |
|---|---|---|
| S-106.1 | Open Studio `/admin/users` | The Users page lists each tenant user's email, role (`admin` or `member`), and status (`active` or `disabled`). It does not list users from another tenant. |
| S-106.2 | Choose Invite, enter an email, select `member`, and submit | The page creates the invite and copies its activation link; the pending invite appears with email, selected role, and expiry. |
| S-106.3 | Revoke the pending invite from the Users page | The invite becomes revoked in the list and its activation link is rejected by `/auth/activate` with HTTP 422 `invalid_invite`. |
| S-106.4 | Generate a password reset link for an active user and choose Copy | The page copies the 24-hour reset URL; it sends no email. |
| S-106.5 | Disable then enable the member | The list changes status to `disabled` then `active`; while disabled, the user's existing session receives HTTP 401 on its next protected request. |
| S-106.6 | Change an active member's role to admin, then back to member | The row shows the updated role after each save and `/auth/permissions` reflects the role's corresponding permissions. |

Endpoint mapping: list users `GET /auth/users`; create/list/revoke invites `POST /auth/invites`, `GET /auth/invites`, `POST /auth/invites/:id/revoke`; reset link `POST /auth/users/:id/password-reset-link`; disable/enable `POST /auth/users/:id/disable` and `/enable`; role change `POST /auth/users/:id/role`. The user and invite controls appear together on `/admin/users`.
