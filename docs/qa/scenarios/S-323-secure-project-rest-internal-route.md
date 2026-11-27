---
id: S-323
title: Security — project REST routing does not grant internal adapter access
persona: team-member
area: gateway
priority: P0
status: planned
release: true
modes: [secured]
surfaces: [api]
---

## Goal

Use an authenticated project API route without allowing Gateway's service
credential to satisfy the REST service's separate internal adapter-call check.

## Prerequisites

- [ ] A secured installed platform with a registered project and an authenticated API client.
- [ ] The project's REST service is available through Gateway.

## Steps

| # | Action | Expected |
|---|---|---|
| S-323.1 | Send `POST /api/v1/projects/<project-id>/rest/internal/adapter-call` with a valid Gateway bearer token and adapter-call body, first without `x-internal-secret`, then with an invalid `x-internal-secret` | Both requests return HTTP 403 with `KB_AUTH_FORBIDDEN`; Gateway does not let its trusted identity header satisfy this endpoint's separate internal-secret check, and the adapter call is not executed. |

## Pass criteria

The Gateway suppresses its generated trusted-identity secret when the rewritten
REST target is the internal adapter-call endpoint, on both dynamic project
routes and configured static REST proxies. Matching covers equivalent encoded
segments and normalized path separators; other project routes retain the
trusted identity headers they need. The installed journey sends both requests
through the project route and claims S-323.1. Integration coverage verifies
that the real REST handler returns 403 for missing or invalid secrets and that
the static proxy removes the secret after its prefix rewrite.
