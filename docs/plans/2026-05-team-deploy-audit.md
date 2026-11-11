# Team Deployment — State Audit (Phase 0–2)

> **Status:** Complete
> **Date:** 2026-05-22
> **Task:** [TD-1] State audit & contract hardening
> **ClickUp:** https://app.clickup.com/t/869dc8d7k
> **Epic:** https://app.clickup.com/t/869dc8d20

## Purpose

Audit what from the Workspace Agent RFC (Phase 0–2) is already in code, what exists only as a stub, and what lives only in ADR/docs. Provides a factual baseline for TD-2 through TD-14 planning.

**References:**
- RFC: `docs/architecture/workspace-agent.md` (7 invariants, 4 deployments)
- Discussion: `docs/plans/2026-05-19-team-deployment-discussion.md`
- Protocol contracts: `plugins/gateway/contracts/src/protocol.ts`
- ADR-0014: `docs/adr/0014-declarative-delivery-and-fleet-distribution.md`

---

## Summary

| Phase | Area | Status |
|-------|------|--------|
| 0 | Zod schemas (adapter:call/response/error) | ✅ In code |
| 0 | GatewayClient (WS, reconnect, heartbeat) | ✅ In code |
| 0 | GatewayTransport (ITransport) | ✅ In code |
| 0 | TokenManager | ✅ In code |
| 0 | IpcServer (unix socket) | ✅ In code |
| 0 | FilesystemHandler | ✅ In code |
| 0 | ExecutionHandler + LocalPluginResolver | ✅ In code |
| 0 | HostRegistry (cache + SQLiteStore) | ✅ In code |
| 0 | Gateway: adapter:call reverse proxy | ✅ In code |
| 0 | REST API: /internal/adapter-call | ✅ In code |
| 0 | Daemon startup (daemon.ts) | ✅ In code |
| 1 | SearchHandler (grep/glob) | ✅ In code (tagged Phase 3 in doc) |
| 1 | ShellHandler | ✅ In code (tagged Phase 3 in doc) |
| 1 | Gateway: /api/v1/execute dispatch | ✅ In code |
| 2 | adapter:chunk schema | ✅ In code (schema only) |
| 2 | adapter:cancel schema | ✅ In code (schema only) |
| 2 | Actual streaming (adapter:chunk flow) | ⚠️ Schema exists, no gateway send path |
| 2 | adapter:cancel handling in gateway | ⚠️ Schema exists, no gateway handler |
| — | Auth: /auth/token + /auth/refresh | ✅ In code (gateway auth routes) |
| — | CLI: kb agent register / status / list | ✅ In code (entry commands) |
| — | Persistent Host Registry (SQLiteHostStore) | ✅ In code |
| — | Duplicate @kb-labs/host-agent-app package | ⚠️ Two packages at same name |

---

## Detailed Findings

### Phase 0 — Contract Hardening

#### Zod Schemas (`plugins/gateway/contracts/src/protocol.ts`)

All adapter reverse-proxy schemas are **finalized and exported**:

| Schema | Status | Notes |
|--------|--------|-------|
| `AdapterCallMessageSchema` | ✅ | `adapter:call` — Host→Gateway |
| `AdapterResponseMessageSchema` | ✅ | `adapter:response` — Gateway→Host |
| `AdapterErrorMessageSchema` | ✅ | `adapter:error` — Gateway→Host |
| `AdapterChunkMessageSchema` | ✅ | `adapter:chunk` — Phase 2, schema ready |
| `AdapterCancelMessageSchema` | ✅ | `adapter:cancel` — Phase 2, schema ready |
| `AdapterCallContextSchema` | ✅ | namespaceId, hostId, workspaceId, environmentId |
| `AdapterNameSchema` | ✅ | Allowlist: llm, cache, vectorStore, embeddings, storage, state |
| `SerializedErrorSchema` | ✅ | code, message, retryable, details? |

All types are exported via `InboundMessage` / `OutboundMessage` union types. **Schemas are locked — no changes needed.**

Discrepancy vs ADR: ADR listed only llm/cache/vectorStore in allowlist. Code adds `embeddings`, `storage`, `state`. **OK as-is** — superset is safe, the doc is stale.

#### GatewayClient (`services/gateway-host-agent/core/src/ws/gateway-client.ts`)

✅ Full implementation:
- WS connect with JWT Bearer auth
- hello/connected handshake + negotiation
- Heartbeat every 30s (ack expected)
- Exponential backoff reconnect (1s → 2s → ... max 60s)
- `sendAdapterCall()` with timeout and pending map
- `registerHandler(adapter, handler)` for capability dispatch
- `pendingAdapterCalls` Map for in-flight reverse proxy calls
- Handles `adapter:response`, `adapter:error` responses

Missing vs ADR:
- `adapter:chunk` handling in `pendingAdapterCalls` (streaming Phase 2) — **gap for TD-11**

#### GatewayTransport (`services/gateway-host-agent/core/src/transport/gateway-transport.ts`)

✅ Implements `ITransport` interface:
- `send(AdapterCall) → AdapterResponse` via `GatewayClient.sendAdapterCall()`
- `close()` / `isClosed()`
- Injects default context (namespaceId, hostId, workspaceId)

Note: `ITransport` interface is locally defined (copy of `@kb-labs/core-runtime/transport`). Should import from canonical package — **minor cleanup, TD scope OK as-is.**

#### Daemon (`services/host-agent/app/src/daemon.ts`)

✅ Full startup sequence:
1. Load `~/.kb/agent.json` (AgentConfigSchema)
2. TokenManager.start() → fetch tokens from `/auth/token`
3. GatewayClient.connect()
4. Register handlers: `filesystem`, `search`, `shell`, `execution`
5. IpcServer.start() (unix socket / named pipe via `createTransport`)
6. SIGTERM/SIGINT graceful shutdown

Note: SearchHandler and ShellHandler are registered and tagged as `@see Phase 3` in their source docs — they're **already implemented**, the tag is outdated. **OK as-is.**

#### ExecutionHandler + LocalPluginResolver

`services/host-agent/app/src/handlers/execution-handler.ts` — ✅ Full implementation:
- Receives `call(adapter:'execution', method:'execute')`
- `LocalPluginResolver.resolve(pluginId, handlerRef)` → absolute path
- Creates `ProxyPlatform` with `GatewayTransport`
- `runInProcess` or `runInSubprocess` depending on config
- Execution journal (at-most-once semantics)
- Timeout via AbortSignal
- Path traversal protection

`LocalPluginResolver` (`local-plugin-resolver.ts`) — ✅:
- Scans `allowedPaths` for plugin manifests
- Cache on first scan
- Path traversal validation
- symlink/realpath security

#### HostRegistry + SQLiteHostStore

`plugins/gateway/app/src/hosts/registry.ts` — ✅:
- Two-level: ICache (hot) + IHostStore (cold)
- `restore()` on startup → all hosts start as offline
- `resetStaleHosts()` on startup
- Reconnect grace timer (10s default)
- Namespace index for host discovery

`plugins/gateway/core/src/stores/sqlite-host-store.ts` — ✅ persistent store.

Discrepancy vs TD-5 (Persistent Host Registry): **already in code**. TD-5 may be about additional indexing, host metadata, or fleet-wide visibility. Needs separate review.

#### Gateway Adapter:Call Handler

`plugins/gateway/app/src/hosts/ws-handler.ts`, line 290 — ✅:
```
case 'adapter:call':
  void handleAdapterCall(msg, socket, hostId, namespaceId);
```
`handleAdapterCall()`:
- Validates with `AdapterCallMessageSchema`
- Forwards to REST API: `POST /api/v1/internal/adapter-call`
- Sends `adapter:response` or `adapter:error` back to host

#### REST API Adapter-Call Endpoint

`plugins/rest-api/app/src/routes/adapter-call.ts` — ✅:
- `POST /api/v1/internal/adapter-call`
- `AdapterRegistry` with per-adapter method allowlists
- Zod schema validation on args
- Audit logging
- Auth: `x-internal-secret` header

Currently registered methods need audit — see gap list below.

---

### Phase 1 — Bidirectional Protocol

#### /api/v1/execute

`plugins/gateway/app/src/execute/routes.ts` — ✅:
- `POST /api/v1/execute`
- `globalDispatcher.firstHostWithCapability(namespaceId, 'execution')`
- Streams `ExecutionEventMessage` as ndjson
- CC2 (cancel), CC3 (retry via `executeWithRetry`), CC5 (broadcast to WS subscribers)

Gap: `firstHostWithCapability` selects first host — no routing by workspaceId or hostId. Routing config per-namespace is TD-10 scope.

#### Execution streaming (CC5)

`plugins/gateway/app/src/clients/subscription-registry.ts` — ✅:
- Clients can subscribe to executionId
- Broadcasts `ExecutionEventMessage` to all subscribers

---

### Phase 2 — Streaming & Cancel

#### adapter:chunk (streaming) — ⚠️ Schema only

`AdapterChunkMessageSchema` exists in `protocol.ts`. But:
- `GatewayClient` does not handle `case 'adapter:chunk'` in incoming messages
- `handleAdapterCall` in gateway does not forward chunks from REST API to host
- REST API `adapter-call.ts` does not stream responses

**Gap:** Full streaming requires:
1. `GatewayClient`: add `case 'adapter:chunk'` handler, accumulate or relay chunks
2. Gateway `handleAdapterCall`: detect streaming response, relay chunks via WS
3. REST API: respond with chunked/ndjson for streaming adapters (llm.stream)

**Scope:** TD-11 (Reconnect & delivery semantics) or a new sub-task. **Not blocking Phase 0-1.**

#### adapter:cancel — ⚠️ Schema only

`AdapterCancelMessageSchema` exists. Gateway `ws-handler.ts` does not have `case 'adapter:cancel'`. **Same scope as streaming gap.**

---

## Gap List

| ID | Description | Status | Planned task |
|----|-------------|--------|-------------|
| G-1 | `adapter:chunk` streaming — GatewayClient + ws-handler | Schema ready, no implementation | TD-11 |
| G-2 | `adapter:cancel` — gateway ws-handler case | Schema ready, no handler | TD-11 |
| G-3 | Execution routing by workspaceId (not just first host) | `firstHostWithCapability` is round-robin only | TD-10 |
| G-4 | Auth endpoint (`/auth/token`) on REST API vs gateway | Lives in gateway — verify TD-4 scope | TD-4 |
| G-5 | Duplicate `@kb-labs/host-agent-app` package directory | Two dirs, same package name | Cleanup |
| G-6 | `SearchHandler`/`ShellHandler` Phase 3 tags outdated | Already implemented, tag wrong | Cleanup |
| G-7 | Registered adapter methods in REST API need enumeration | Which llm/cache methods are registered? | TD-3 |

---

## Discrepancies: ADR vs Code

| Item | ADR says | Code has | Resolution |
|------|----------|----------|-----------|
| Adapter allowlist | llm, cache, vectorStore | + embeddings, storage, state | **OK as-is** — superset, ADR is stale |
| SearchHandler phase | "Phase 3" | Implemented and registered | **OK as-is** — ahead of schedule |
| ShellHandler phase | "Phase 3" | Implemented and registered | **OK as-is** — ahead of schedule |
| GatewayTransport ITransport | Import from core-runtime | Local copy | **Minor** — can unify, not blocking |
| Reconnect grace | 10s default in docs | 10s in code | ✅ Match |
| SUPPORTED_PROTOCOL_VERSIONS | `['1.0']` | `['1.0'] as const` | ✅ Match |

---

## What Is Only in ADR / Docs (Not Yet in Code)

| Feature | ADR/Doc | Code gap | Task |
|---------|---------|----------|------|
| RBAC & namespace visibility | D-1 discussion | No multi-tenant namespace isolation | TD-8 |
| Fleet Distribution (multi-host routing) | ADR-0014 | Only `firstHostWithCapability` | TD-6, TD-7 |
| Persistent Host Registry (fleet-wide) | TD-5 description | SQLiteStore exists, fleet indexing missing | TD-5 |
| GitHub OAuth + team tokens | D-1 discussion | Only machine token (clientId/clientSecret) | TD-4 |
| Bidirectional WS streaming (LLM chunks) | Phase 2 in doc | Schema only | TD-11 |
| Reconnect + delivery guarantees | 2026-03-22 plan | Basic reconnect, no at-least-once delivery | TD-11 |
| Workflow mixed targets (INV-7) | D-4 discussion | Workflow engine has no target routing | TD-10 |
| Onboarding / bootstrap | TD-12 | No flow implemented | TD-12 |
| Platform deploy pipeline | TD-13 | No CI/docker-compose for cloud deploy | TD-13 |
| Cloud Studio | TD-9 | Studio runs locally only | TD-9 |

---

## Conclusion

**Phase 0 is complete** — all core contracts, GatewayClient, GatewayTransport, daemon, handlers, HostRegistry, and the reverse proxy flow are in code and production-quality.

**Phase 1 execution path is complete** — `/api/v1/execute` dispatches to workspace-agent via WS, streams events to clients.

**Phase 2 (streaming) is schema-ready but not implemented** — `adapter:chunk` and `adapter:cancel` are unblocked by schemas but need gateway and client-side work (TD-11 scope).

Next concrete tasks in dependency order:
1. **TD-3** — ExecutionHandler + LocalPluginResolver (review for completeness, add tests)
2. **TD-2** — Bidirectional WS review (verify Phase 1 gaps, document protocol state machine)
3. **TD-5** — Persistent Host Registry (fleet-wide listing, namespace index)
4. **TD-4** — Identity & Auth (GitHub OAuth + team tokens)
5. **TD-11** — Reconnect & delivery semantics (adapter:chunk streaming)
