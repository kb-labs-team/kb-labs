---
id: S-255
title: Gateway — enforce secured access, resource limits, and project boundaries
persona: platform-admin
area: gateway
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [api]
---

## Goal

Confirm that secured Gateway access boundaries are enforced, authenticated traffic is limited by its configured resource and tenant limits, bounded telemetry batches are enforced, and project-scoped requests cannot read another project's resources.

## Prerequisites

- [ ] A running Gateway with a deterministic test pressure configuration: the selected route's limit and per-tenant limit are enabled and low enough to exceed with a fixed request batch.
- [ ] Two registered projects with distinct test resources and credentials for each project.
- [ ] An analytics adapter and valid telemetry fixtures.
- [ ] A declared webhook route, a protected MCP route, and a registry fixture with public and private package metadata.

## Steps

| # | Action | Expected |
|---|---|---|
| S-255.1 | Send requests to one Gateway resource beyond its configured request limit | Requests admitted by the broker reach their route; rejected requests return HTTP 429 with `Retry-After`, `error: "rate_limited"`, and the resource identifier. |
| S-255.2 | In secured mode with the default Gateway configuration, send requests for tenant A beyond its default limit of 600 requests per minute, then send one request for tenant B | The per-tenant pressure limit is active by default in secured mode; tenant A receives HTTP 429 with its tenant resource identifier after its limit is reached, and tenant B is governed by its separate tenant resource. |
| S-255.3 | Read a project-scoped workflow or analytics resource through `/api/v1/projects/<PROJECT_A>/<SERVICE>/...`, then request it through the equivalent project B route | Project A receives only project A's resource; project B receives only its own resource or the route's catalogued not-found response, never project A's data. |
| S-255.4 | Send the same project resource request without credentials in secured mode | Gateway returns HTTP 401 with the catalogued `KB_AUTH_REQUIRED` envelope before the project service is reached. |
| S-255.5 | Send a request whose body is larger than the Gateway's explicit default byte limit of 1 MiB | Gateway rejects it with HTTP 413 and error code `KB_RUNTIME_PAYLOAD_TOO_LARGE` before forwarding it; the error message and hint identify the enforced 1 MiB limit. |
| S-255.6 | Send a body below the 1 MiB Gateway default but above a lower limit declared by the target route schema | The route rejects the request under its lower schema limit; the shared Gateway default remains the upper byte bound. |
| S-255.7 | In secured mode, send an anonymous request to `GET /api/v1/studio/registry`, `GET /api/v1/projects/$PROJECT_ID/workflow/health`, and `POST /api/v1/projects/$PROJECT_ID/mcp` | Each request stops at the gateway and returns HTTP 401 with the `KB_AUTH_REQUIRED` catalog envelope; the service, project runtime, or MCP tool handler is not reached. |
| S-255.8 | In secured mode, send a declared webhook request with its valid manifest-configured signature, then send it with a missing or invalid signature; also send an unsigned request to an undeclared `/webhooks/...` path | The declared valid request reaches its webhook handler without a user session. Missing/invalid signatures return HTTP 401 with the `KB_AUTH_REQUIRED` catalog envelope before the handler runs. An undeclared path cannot bypass the gateway gate by resembling a webhook route. |
| S-255.9 | In secured mode, send `OPTIONS /api/v1/mcp` with `Origin` and `Access-Control-Request-Method: POST`, then send an OPTIONS request without `Access-Control-Request-Method` to a protected route | The CORS preflight gets only the configured CORS response, without dispatching to a session, tool, service or plugin handler. An ordinary OPTIONS request remains behind the auth gate and returns HTTP 401 with the `KB_AUTH_REQUIRED` envelope. |
| S-255.10 | Through the Gateway, request the registry package list, public package metadata, and package stats anonymously, then request private package metadata anonymously and as an authenticated caller with access | Public catalog reads remain available without a user session. Private package access is decided by the registry's `canAccess`: anonymous callers receive 403, and an authenticated caller's forwarded namespace is used for the access decision. |

## Decision note

**D51:** Gateway has an explicit default request-body byte limit of 1 MiB; a route schema may set a lower limit. Requests over the applicable limit receive HTTP 413 with `KB_RUNTIME_PAYLOAD_TOO_LARGE`; the catalogued message and hint identify the enforced limit when the boundary knows it, and avoid naming a size when it does not. Secured mode has an independent default tenant budget of 600 requests per minute; operators can explicitly disable it or configure a different limit.

## Source

Gateway request pressure is implemented in `services/gateway/app/src/pressure/hooks.ts` and configured in `services/gateway/contracts/src/config.ts`; the Fastify server is created in `services/gateway/app/src/server.ts`. Telemetry's 1–500 item limit is already covered by S-190. Project request routing is configured in `services/gateway/app/src/server.ts`; project service resolution and isolation are covered by S-198, S-199, and S-201.
