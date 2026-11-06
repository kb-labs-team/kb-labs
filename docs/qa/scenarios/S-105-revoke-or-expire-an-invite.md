---
id: S-105
title: Team Admin — revoke or allow an invite to expire
persona: team-admin
area: security
priority: P1
status: active
release: false
modes: [secured]
surfaces: [api]
---

## Goal

An administrator can invalidate a pending invite, and invitees cannot activate with a revoked or expired link.

## Prerequisites

- [ ] Secured gateway, tenant-admin session, and a disposable tenant.

## Steps

| # | Action | Expected |
|---|---|---|
| S-105.1 | Create a member invite with `POST /auth/invites` and JSON `{"email":"invitee@example.test","role":"member"}` | HTTP 201 returns `inviteId` and `activationUrl`; the pending invite expires seven days after creation. |
| S-105.2 | Send `POST /auth/invites/<inviteId>/revoke` with the admin session and CSRF token | HTTP 200 JSON is `{"ok":true}`. |
| S-105.3 | Submit the revoked invite token to `POST /auth/activate` with a password | HTTP 422 returns the ADR-0049 error envelope with catalogued code `KB_AUTH_INVALID_INVITE`, message `The invitation is invalid, expired, or already used.`, and a next-step hint to request a new invitation. |
| S-105.4 | Create an invite with `ttlMs: 1000`, wait until the returned `expiresAt` has passed, then submit its token to `POST /auth/activate` | Within 2 seconds after `expiresAt`, HTTP 422 returns the same `KB_AUTH_INVALID_INVITE` envelope as S-105.3; the invite does not create an account. |
