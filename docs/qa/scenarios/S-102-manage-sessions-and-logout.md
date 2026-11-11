---
id: S-102
title: Account — inspect and revoke sessions, then log out
persona: team-member
area: security
priority: P1
status: active
release: false
modes: [secured]
surfaces: [cli, studio, api]
---

## Goal

A user can identify their own sessions, revoke one session, and clear saved CLI credentials.

## Prerequisites

- [ ] Secured gateway and two active sessions for the same user.

## Steps

| # | Action | Expected |
|---|---|---|
| S-102.1 | With a browser session, send `GET <gateway-url>/auth/sessions` | HTTP 200 JSON lists both sessions with `familyId`, timestamps, `userAgent`, and `isCurrent`. |
| S-102.2 | Send `POST <gateway-url>/auth/sessions/<other-family-id>/revoke` with the current session and CSRF token | HTTP 200 JSON is `{"ok":true}`; the revoked session's next `GET /auth/me` returns HTTP 401. |
| S-102.3 | With a saved CLI login, run `kb auth logout --json` | JSON reports `ok: true` and `message: "Logged out. Credentials removed."`; the next `kb auth status --json` reports `session.authenticated: false`. |
