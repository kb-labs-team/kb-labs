---
id: S-042
title: Team Admin — invite a member and issue a reset link
persona: team-admin
area: security
priority: P1
status: active
release: false
modes: [secured]
surfaces: [cli, api]
---

## Goal

An administrator provisions a member with a one-time invite and recovers an existing member with a one-time reset link shared out of band.

## Prerequisites

- [ ] Secured gateway, authenticated tenant-admin account, and disposable tenant.
- [ ] No user exists yet for the invited email.
- [ ] Existing member account has an active session for the password-reset flow.

## Steps

| # | Action | Expected |
|---|---|---|
| S-042.1 | Send `POST <gateway-url>/auth/invites` with the admin session, CSRF token, and JSON `{"email":"member@example.test","role":"member"}` | HTTP 201 JSON contains `inviteId` and an `activationUrl` on the gateway host. |
| S-042.2 | Submit the `activationUrl` token to `POST <gateway-url>/auth/activate` with JSON `{"token":"<activation-token>","password":"MemberPass123!"}` | HTTP 200 JSON is `{"ok":true}`; `GET /auth/me` with the returned session identifies `member@example.test`. |
| S-042.3 | Submit the same activation token again to `POST <gateway-url>/auth/activate` | HTTP 422 returns the ADR-0049 error envelope with catalogued code `KB_AUTH_INVALID_INVITE`, message `The invitation is invalid, expired, or already used.`, and a next-step hint to request a new invitation. |
| S-042.4 | As admin run `kb auth reset-link --user-id <user-id> --json` from the active platform root | The command uses the Gateway selected for that root (the installed receipt URL for a local root or the saved session URL for a client root). ADR-0049 success JSON contains `ok: true`, `data.resetUrl`, and numeric `data.expiresAt`; the URL expires 24 hours after creation. |
| S-042.5 | Send `POST <gateway-url>/auth/password/reset` with JSON `{"token":"<reset-token>","newPassword":"NewMemberPass123!"}` | HTTP 200 JSON is `{"ok":true}`; the target user's existing sessions are revoked, a login with the new password succeeds, and a login with the old password returns HTTP 401 `{"error":"invalid_credentials"}`. |
| S-042.6 | Submit the consumed reset token to `POST <gateway-url>/auth/password/reset` again | HTTP 400 returns the ADR-0049 error envelope with catalogued code `KB_AUTH_INVALID_PASSWORD_RESET`, message `This reset link is invalid, expired, or already used.`, and a next-step hint to request a new reset link. |
