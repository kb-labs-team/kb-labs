---
id: S-266
title: Cloud team — run the published per-service container stack
persona: team-admin
area: deployment
priority: P0
status: planned
release: false
modes: [secured]
surfaces: [cli, studio, api]
---

## Goal

A team administrator runs the released KB Labs service images as separate containers behind an authenticated Gateway and uses the CLI, marketplace, workflows, and Studio through that Gateway.

## Prerequisites

- [ ] A fresh, isolated Compose project uses the images and Dockerfiles in the platform image publish workflow.
- [ ] Every container and data volume belongs to this run; the Gateway URL is available to the operator.
- [ ] The platform has the secured-install bootstrap administrator configured through the shipped bootstrap defaults.

## Steps

The same step list must also run against a deployed stand via `--gateway-url` (T5). The preview Compose stack currently contains only web, Gateway, and docs, so it does not yet include the platform services required by this case.

| # | Action | Expected |
|---|---|---|
| S-266.1 | Start the Compose project with fresh data and deployment secrets. | Every enabled service becomes healthy behind the Gateway; each service address resolves through the declared service transport/config. |
| S-266.2 | Run `kb --help`, then `kb auth login --gateway-url <gateway-url> --email <admin-email>` and authenticate as the seeded administrator. | Help exits 0; login exits 0 and stores the authenticated session for that Gateway URL. |
| S-266.3 | Run `kb marketplace plugins list`, install `@kb-labs/commit` with `kb marketplace install @kb-labs/commit`, verify it with `kb marketplace plugins list`, then run `kb marketplace uninstall @kb-labs/commit`. | Each operation succeeds through the Gateway; the Commit plugin appears after install and is absent after uninstall. |
| S-266.4 | Run `kb workflow runs list --json`. | The command exits 0 and returns the workflow run list through the Gateway. |
| S-266.5 | Open the Studio URL served by the stack and sign in as the seeded administrator. | Studio loads behind authentication and shows the authenticated administrator session. |
| S-266.6 | Send an unauthenticated `GET <gateway-url>/auth/me` request. | The response has HTTP 401 and an ADR-0049 error envelope with code `KB_AUTH_REQUIRED`. |
| S-266.7 | Start a fresh cloud Compose project with `gateway.access.mode` set to `local`. | Gateway startup is refused with the catalogued `KB_DEPLOYMENT_AUTH_REQUIRED` error. |
| S-266.8 | Start a fresh cloud Compose project with `gateway.auth.enabled` set to `false`. | Gateway startup is refused with the same catalogued `KB_DEPLOYMENT_AUTH_REQUIRED` error. |
