---
id: S-104
title: Security — admins manage tenant access and members cannot manage users
persona: team-admin
area: security
priority: P0
status: active
release: false
modes: [secured]
surfaces: [api, cli, studio]
---

## Goal

Tenant admins can grant member or admin access, while a member can use projects and workflows but cannot administer tenant users.

## Prerequisites

- [ ] Secured gateway with an admin and a member in the same tenant.

## Steps

| # | Action | Expected |
|---|---|---|
| S-104.1 | As admin request `GET <gateway-url>/auth/permissions` | HTTP 200 JSON `permissions` contains `users:read`, `users:write`, `invites:read`, and `invites:write`. |
| S-104.2 | As admin send `POST <gateway-url>/auth/invites` with JSON `{"email":"new-admin@example.test","role":"admin"}` | HTTP 201 returns an `inviteId` and `activationUrl` for the new tenant-admin invite. |
| S-104.3 | As member request `GET <gateway-url>/auth/permissions` | HTTP 200 JSON `permissions` contains `projects:read`, `projects:write`, `plugins:read`, `plugins:write`, `workflows:read`, and `workflows:write`; it excludes `users:read`, `users:write`, `invites:read`, and `invites:write`. |
| S-104.4 | As member request `GET <gateway-url>/auth/users` | HTTP 403 JSON contains `error: "Forbidden"` and `message: "Permission denied: users:read"`. |
| S-104.5 | As member send `POST <gateway-url>/auth/invites` with valid email and role JSON | HTTP 403 JSON contains `error: "Forbidden"` and `message: "Permission denied: invites:write"`. |
| S-104.6 | Open Studio `/login`, then attempt `POST <gateway-url>/auth/register` without a cookie or Authorization header using a human signup body `{"name":"new-member","email":"new-member@example.test","password":"HumanPass123!"}` | The login form has no Sign up, Create account, or Register action. The request is refused by the Gateway auth gate with HTTP 401 JSON whose canonical error envelope has code `KB_AUTH_REQUIRED`, message `Authentication is required.`, and the catalogued login hint rendered with the configured Gateway URL. `/auth/register` remains protected machine registration requiring `machine:register`, and no public human signup endpoint is exposed. |
| S-104.7 | As the only active tenant admin, try to disable your own account and demote your role to member | Both requests fail with HTTP 409 ADR-0049 error envelopes using catalogued code `KB_AUTH_LAST_ADMIN`; the account remains active and retains the admin role. |
