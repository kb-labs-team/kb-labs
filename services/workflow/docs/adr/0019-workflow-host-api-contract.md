# ADR-0019: Workflow Host Layer and Unified API Contract

**Status:** Accepted  
**Date:** 2026-02-24  
**Deciders:** KB Labs Team

## Context

`kb-labs-workflow` evolved with mixed responsibilities:
- business logic duplicated across route handlers
- inconsistent response shapes between `jobs`, `cron`, `workflows`
- partial route drift (`/api/v1/*` vs `/api/*`)
- weak extension points for testing and future features

This increased release risk and made refactoring slower.

## Decision

We formalize a three-layer flow inside workflow daemon:

1. `Host Layer` (`WorkflowHostService`)  
2. `HTTP Layer` (Fastify routes in `src/api/*`)  
3. `Client Layer` (`workflow-cli` HTTP/REST proxies)

### 1) Host Layer

`WorkflowHostService` is now the application boundary for:
- `jobs` orchestration (`submit/get/list/cancel/logs/steps`)
- `cron` orchestration (`register/list/pause/resume/trigger`)
- `workflows` orchestration (`list/get/run`)

All business mapping/validation lives here, not in route handlers.

### 2) Unified API Response Contract

All `/api/v1/*` workflow endpoints return a strict envelope:

```json
{ "ok": true, "data": { ... } }
```

or

```json
{ "ok": false, "error": "message" }
```

Implemented via shared helpers in `src/api/response.ts`.

### 3) Cron Route Normalization

Canonical routes are now `/api/v1/cron/*`.
Legacy `/api/cron/*` aliases are removed.

### 4) Contract Integration Tests

Added integration tests on route+contract behavior:
- response envelope shape
- cron alias compatibility
- success/error status semantics

## Consequences

### Positive

- Single extension point for domain behavior (`WorkflowHostService`)
- Predictable API contract for CLI/REST consumers
- No route duplication for cron endpoints
- Easier integration testing and faster regression detection

### Negative

- Slightly more boilerplate in handlers due to envelope wrapping

## Extension Points

- Add auth/tenant policies in `WorkflowHostService` without route churn
- Add new transport hosts by reusing host service (e.g. gRPC/websocket)
- Expand contract tests per endpoint group before release

## Migration Notes

- All consumers must use `/api/v1/*`
- Envelope parsing is required for all clients
