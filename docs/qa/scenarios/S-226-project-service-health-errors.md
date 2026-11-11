---
id: S-226
title: Project runtime — report startup and service health failures as typed errors
persona: platform-developer
area: platform-core
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [api]
---

## Goal

Diagnose a project runtime that rejects its host identity or has a declared health endpoint that is unhealthy or unreachable.

## Steps

| # | Action | Expected |
|---|---|---|
| S-226.1 | Request `GET /api/v1/projects/<project-id>/<service-id>/health` when the declared health endpoint reports an unhealthy status or cannot be reached | Gateway returns HTTP 502 with the catalogued `KB_PROJECT_RUNTIME_START_FAILED` UX error envelope. The message identifies the project service, and the hint gives `kb logs query --source <service-id> --level error --limit 20` as the next command. |
| S-226.2 | At the host-to-runtime boundary, start the runtime with a canonical project root and an ID that does not derive from that root | The runtime argument parser rejects startup before binding; its unit test verifies the identity mismatch, and the host boundary returns the separate catalogued `KB_PROJECT_RUNTIME_IDENTITY_MISMATCH` error without a raw stack. This is a non-release internal defense case. |

## Pass criteria

The project router uses the service manifest's declared health endpoint for every project service. Failures return one catalogued UX error; healthy responses return the service health payload in the shared success envelope. Runtime startup validates its host-passed project identity before binding.
