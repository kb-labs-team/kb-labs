---
id: S-101
title: Account — change your own password
persona: team-member
area: security
priority: P1
status: active
release: false
modes: [secured]
surfaces: [studio, api]
---

## Goal

A signed-in user changes their password and is told when the current password is wrong.

## Prerequisites

- [ ] Secured gateway and active user with a known password and at least two session families.

## Steps

| # | Action | Expected |
|---|---|---|
| S-101.1 | From Studio open `/account/password`, enter the current password and a new password of at least eight characters twice, then submit | Studio sends `POST /api/auth/password/change`; the page shows “Your password has been changed. Other devices have been signed out.” |
| S-101.2 | Use the other session family to call `GET /auth/me` | HTTP 401 indicates no active session because changing the password revoked other sessions. |
| S-101.3 | Sign in with the new password, then submit an incorrect current password to `POST /auth/password/change` | The request returns HTTP 400 with `error.code: "KB_AUTH_INVALID_CURRENT_PASSWORD"`, message `Current password is incorrect`, and a hint to check the current password and retry; the password remains unchanged. |
