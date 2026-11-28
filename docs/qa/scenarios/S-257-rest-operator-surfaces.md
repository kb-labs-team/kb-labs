---
id: S-257
title: REST — protect operator diagnostics and expose metrics
persona: platform-admin
area: rest-api
priority: P1
status: planned
release: false
modes: [secured]
surfaces: [api]
---

## Goal

Keep REST operator diagnostics available to administrators, deny them to members, and provide operators a stable Prometheus metrics contract.

## Prerequisites

- [ ] A secured platform with an administrator and a tenant member, each using a valid authenticated credential.
- [ ] The REST API and Gateway are running with at least one registered job and one plugin.

## Steps

| # | Action | Expected |
|---|---|---|
| S-257.1 | As a tenant member, request `GET /api/v1/routes`, `POST /api/v1/cache/invalidate`, `GET /api/v1/jobs`, and `GET /api/v1/jobs/stats` | Each request is denied with HTTP 403 and the catalogued `KB_AUTH_FORBIDDEN` error envelope. No route inventory, cache refresh, or job diagnostics are returned. **This is a failing claim today:** these REST handlers do not enforce an administrator permission. |
| S-257.2 | As an administrator, request those same route, cache, and jobs endpoints | Each request reaches its normal handler and returns its documented response; cache invalidation refreshes the registry. |
| S-257.3 | As an authenticated operator, request `GET /metrics` and parse the Prometheus text exposition | The response has Prometheus text content type and includes the supported families: `http_request_duration_ms`, `http_requests_total`, `http_errors_total`; process/runtime and service-operation families (`process_uptime_seconds`, `process_cpu_percent`, `process_rss_bytes`, `process_heap_used_bytes`, `process_event_loop_lag_ms`, `service_health_status`, `service_restarts_total`, `service_active_operations`, `service_operation_total`, `service_operation_duration_ms`); plugin and tenant request families (`kb_plugin_request_total`, `kb_plugin_request_duration_ms`, `kb_tenant_request_total`, `kb_tenant_request_errors_total`, `kb_tenant_request_duration_ms`); header-policy families (`kb_headers_filtered_total`, `kb_headers_sensitive_inbound_total`, `kb_headers_validation_errors_total`, `kb_headers_vary_applied_total`, `kb_headers_dry_run_decisions_total`); and the plugin-mount, Redis-status, and route-budget families (`kb_plugins_mount_total`, `kb_plugins_mount_succeeded`, `kb_plugins_mount_failed`, `kb_plugins_mount_elapsed_ms`, `kb_redis_status_updates_total`, `kb_redis_status_transitions_total`, `kb_redis_healthy`, `kb_redis_role_state_total`, `http_request_route_budget_ms`) when their source data is present. |
| S-257.4 | As an authenticated operator, request `GET /openapi.json` and inspect `GET /api/v1/jobs`. Then call the jobs endpoint with `status=active`, an unsupported status, and while the cron manager is unavailable. | OpenAPI lists the supported `status` values and documents the JSON `jobs` response. The endpoint accepts the supported status, rejects the unsupported value with HTTP 400, and reports an unavailable cron manager with HTTP 503. Both failures use the shared JSON error envelope. |

## Decision note

**D54:** `/routes`, cache invalidation, and the jobs API are admin-only diagnostics. In secured mode, deny by default and return the catalogued 403 envelope to members. `/metrics` is a supported operations contract with the metric families listed in the route and registry owners below.

## Source

REST diagnostics are registered in `services/rest-api/app/src/routes/index.ts`; the route inventory, cache invalidation, and jobs handlers are in `services/rest-api/app/src/routes/debug.ts`, `cache.ts`, and `jobs.ts`. `/metrics` custom output is in `services/rest-api/app/src/routes/metrics.ts`; registered Prometheus families are in `services/rest-api/app/src/observability/prometheus-registry.ts`. The catalogued forbidden error is `KB_AUTH_FORBIDDEN`.
