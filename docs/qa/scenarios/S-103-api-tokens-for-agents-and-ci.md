---
id: S-103
title: Authentication — create, use, and revoke a personal API token
persona: team-member
area: security
priority: P1
status: active
release: false
modes: [secured]
surfaces: [cli, studio, api, agent]
---

## Goal

A user gives an agent or CI a named personal token, then revokes access when it is no longer needed.

## Prerequisites

- [ ] Secured gateway and a signed-in member with project read access.

## Steps

| # | Action | Expected |
|---|---|---|
| S-103.1 | Run `kb auth tokens --name "nightly CI" --expires-in-days 90 --json` from the active platform root | The command uses the Gateway selected for that root (the installed receipt URL for a local root or the saved session URL for a client root). JSON contains `ok: true`, one `token` secret, and `tokenRecord` metadata with name `nightly CI` and expiry within 90 days; the secret is printed only on creation. |
| S-103.2 | Run `kb auth tokens --json` | The token list contains the token ID, name, issue and expiry times, and no token secret. |
| S-103.3 | Send `GET <gateway-url>/auth/me` with `Authorization: Bearer <token>` | HTTP 200 JSON contains the token owner's `email` and `tenantId`. |
| S-103.4 | Run `kb auth tokens --revoke <token-id> --json`, then repeat `GET <gateway-url>/auth/me` with the revoked secret | Revocation JSON reports `ok: true`; the profile request returns HTTP 401. |
| S-103.5 | Run `kb auth tokens --name "local agent" --json` without an expiry option | The new token is usable and its metadata has no expiry. |
