---
id: S-038
title: Team admin — Missing production secret fails at service startup
persona: team-admin
area: platform-core
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

An administrator receives an actionable startup error when a required config environment reference is unset, and local or secured kb-create installs generate and preserve the gateway-to-service secret without asking the user to set it.

## Prerequisites

- [ ] A KB Labs deployment whose gateway and internal upstreams share `GATEWAY_INTERNAL_SECRET`.
- [ ] Docker Engine is installed and running.

## Steps

| # | Action | Expected |
|---|---|---|
| S-038.1 | Start the gateway, REST API, Marketplace API, or marketplace-registry container without `GATEWAY_INTERNAL_SECRET` | The process exits non-zero during startup; the catalog diagnostic names `GATEWAY_INTERNAL_SECRET` and tells the operator to set it in the deployment secret configuration. |
| S-038.2 | Start the same services with `GATEWAY_INTERNAL_SECRET` set to a valid test value | Each service starts and its documented health endpoint returns HTTP 200 within 30 seconds. |
| S-038.3 | Run a development service container without `GATEWAY_INTERNAL_SECRET` | Startup fails with the same missing-variable diagnostic; this secret is required in every mode. |
| S-038.4 | Create a fresh local install with kb-create | kb-create generates `GATEWAY_INTERNAL_SECRET`, stores it in the private secret store, and supplies it to the gateway and every internal upstream, including Marketplace API, without prompting the user. |
| S-038.5 | Update that install and inspect the effective service environment | The existing `GATEWAY_INTERNAL_SECRET` value is unchanged and remains available to every service that checks `x-internal-secret`. |
| S-038.6 | Roll back the install and inspect the effective service environment | The same `GATEWAY_INTERNAL_SECRET` value is restored and remains available to every service that checks `x-internal-secret`. |
| S-038.7 | Deploy through the compose or Kubernetes team-deployment configuration without declaring `GATEWAY_INTERNAL_SECRET` | Deployment fails before services start; the diagnostic names the required variable and tells the operator how to provide it through the deployment secret configuration. |

This planned container-level case is separate from config-loader unit behavior and is outside the platform-core release gate until the kb-deploy phase.
