---
id: S-189
title: Gateway — call an allowed adapter through the platform API
persona: service-developer
area: gateway
priority: P0
status: planned
release: false
modes: [local, secured]
surfaces: [api]
---

## Goal

Discover the callable platform adapter methods, invoke a configured method,
and receive typed, client-safe errors for unsupported calls while streaming
async iterable results.

## Prerequisites

- [ ] A running gateway with an authenticated API client and configured analytics and LLM adapters.
- [ ] A fixture for a successful analytics call and a streaming LLM response.

## Steps

| # | Action | Expected |
|---|---|---|
| S-189.1 | Send an authenticated `GET /platform/v1/adapters` | HTTP 200 returns the shared UX success envelope with `ok: true`; `data.adapters` lists only the supported adapter/method pairs: `llm` (`complete`, `stream`, `chatWithTools`), `cache` (`get`, `set`, `delete`, `clear`), `vectorStore` (`search`, `upsert`, `delete`, `count`), `analytics` (`track`, `identify`, `flush`, `getEvents`, `getStats`, `getDailyStats`), `embeddings` (`embed`), `storage` (`read`, `write`, `delete`, `list`, `exists`), `eventBus` (`publish`, `subscribe`), `documentDatabase` (`find`, `findById`, `count`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `updateById`, `deleteMany`, `deleteById`, `bulkWrite`, `ensureCollection`, `ping`), and `kvStore` (`get`, `getMany`, `set`, `setMany`, `setIfNotExists`, `delete`, `exists`, `cas`, `incr`, `ttl`, `expire`, `persist`, `ping`). The catalog is the same allowlist enforced by POST calls. |
| S-189.2 | Send an authenticated `POST /platform/v1/analytics/track` with `{"args":["case.gateway.call",{"source":"case-fixture"}]}`, then query `POST /platform/v1/analytics/getEvents` for that event type | HTTP 200 returns the shared UX success envelope with `ok: true`, a present `data` field (`null` for the void method), and numeric `meta.durationMs`; the query returns the recorded `case.gateway.call` event. |
| S-189.3 | Send authenticated calls to `POST /platform/v1/unknownAdapter/method` and `/platform/v1/analytics/unknownMethod` | Each returns a typed ADR-0049 error naming the unknown adapter or disallowed method, with a corrective hint directing the client to `GET /platform/v1/adapters`, and no stack trace in the response. |
| S-189.4 | Send an authenticated `POST /platform/v1/llm/stream` with `{"args":["case stream"]}` where the adapter returns an `AsyncIterable` | The response uses `text/event-stream`, yields each result chunk, and ends with the `[DONE]` event. |
| S-189.5 | Send an authenticated stream request whose configured mock provider rejects the key, then a request that triggers its deterministic provider-unavailable failure; check gateway health after each request | With either supported mock provider protocol configured, the key failure returns HTTP 502 with `KB_CONFIG_LLM_KEY_INVALID`. For the provider-unavailable request, the provider first yields at least one stream chunk and then fails; the Gateway returns HTTP 200 `text/event-stream` containing that chunk followed by a terminal `event: error` with `KB_CONFIG_LLM_PROVIDER_UNAVAILABLE`, and does not emit `[DONE]`. Both responses include their catalogued corrective hints and correlation IDs, both requests end cleanly, and the Gateway remains healthy. |
| S-189.6 | Send an authenticated `POST /platform/v1/llm/stream` with `{"args":[]}` | HTTP 400 contains the typed `KB_RUNTIME_INPUT_INVALID` envelope; the gateway remains healthy. |
| S-189.7 | Send an authenticated `GET /platform/v1/unknown/resource` for an unmounted Platform API route | HTTP 404 returns a JSON ADR-0049 `KB_RUNTIME_RESOURCE_NOT_FOUND` envelope. Studio's SPA document is never returned for an API-shaped path. |

## Pass criteria

The route is `POST /platform/v1/:adapter/:method`; its static allowlist and
derived catalog at `GET /platform/v1/adapters` are in
`services/gateway/app/src/platform/routes.ts`. It streams async iterables as
SSE ending in `[DONE]`, emits catalogued provider errors when the adapter fails,
and returns `KB_RUNTIME_INPUT_INVALID` for a stream request without a prompt.
The case remains planned until S-189.1 has a documented adapter catalog endpoint
and the installed journey passes all steps.
