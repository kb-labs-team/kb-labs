---
id: S-190
title: Gateway — ingest telemetry within the batch limit
persona: service-developer
area: gateway
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [api]
---

## Goal

Send valid telemetry batches to the platform analytics adapter and get a clear
validation result at and above the per-request event limit.

## Prerequisites

- [ ] A running gateway, authenticated API client, and analytics adapter.
- [ ] A deterministic event generator that can create valid batches of 500 and 501 events.

## Steps

| # | Action | Expected |
|---|---|---|
| S-190.1 | POST `{"events":[...]}` containing exactly 500 valid events to `/telemetry/v1/ingest` | The request passes validation and returns HTTP 200 with `accepted: 500` and `rejected: 0` when the analytics adapter accepts each event. |
| S-190.2 | POST a valid batch of 501 events to `/telemetry/v1/ingest` | The request is rejected before ingestion with HTTP 400 and the shared UX error envelope containing `KB_RUNTIME_INPUT_INVALID`; `error.details.field` identifies `events`, and no event from the rejected batch is written. |

## Pass criteria

The request contract requires 1–500 events, each with non-empty bounded
`source` and `type` and optional timestamp, payload, and tags
(`services/gateway/contracts/src/telemetry.ts:15-35`). The route is
`POST /telemetry/v1/ingest`; schema failures return HTTP 400 in the shared UX
error envelope with the invalid field in `error.details`, while valid events
are passed to analytics and counted in the response
(`services/gateway/app/src/telemetry/routes.ts:20-33,42-87`). The limit is
implemented, but this worktree has no journey claim exercising the route at
500 and 501 events; keep the release case planned until the journey proves both
the accepted boundary and no-mutation rejection above it.
