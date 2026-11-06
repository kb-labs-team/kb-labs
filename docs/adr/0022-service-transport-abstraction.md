# ADR-0022: IServiceTransport — Service-to-Service Transport Abstraction

**Date:** 2026-05-28
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-28
**Tags:** architecture, gateway, transport, unix-socket, platform

## Context

The gateway proxied to internal services (rest-api, workflow, marketplace) via `@fastify/http-proxy`
with hardcoded TCP URLs from `GatewayConfig.upstreams[].url`. All services bind to `127.0.0.1`
(ADR-0020), but each still consumed a separate TCP port.

This created several constraints:

1. **Port proliferation in solo mode.** Running all services requires opening 4+ TCP ports even when
   everything is on the same machine. Unix domain sockets eliminate all inter-service TCP ports.

2. **No abstraction for future transport modes.** HTTP/TCP is fine for local dev, but k8s and VPS
   deployments need DNS-based service discovery (`http://rest.kb-platform.svc:5050`). There was no
   seam to change the transport without touching gateway internals.

3. **Config coupling.** Service URLs were embedded in `GatewayConfig`, which meant any topology
   change (TCP → socket, local → k8s) required editing gateway config specifically, rather than
   configuring a shared adapter.

## Decision

Introduce `IServiceTransport` as a **platform-only adapter** (not exposed to plugins) that abstracts
how the gateway connects to internal services:

```typescript
interface IServiceTransport {
  connectionInfo(serviceId: string): ServiceConnectionInfo | undefined;
  call(serviceId: string, req: ServiceTransportRequest): Promise<ServiceTransportResponse>;
  stream(serviceId: string, req: ServiceTransportRequest): Promise<ServiceTransportStream>;
  health?(): Promise<ServiceTransportHealth>;
}
```

### Two-phase gateway approach

`connectionInfo()` returns connection options used by `@fastify/http-proxy` at startup:

```typescript
const conn = serviceTransport.connectionInfo(upstream.serviceId);
await app.register(fastifyHttpProxy, {
  upstream: conn.baseUrl,
  undici: conn.socketPath ? { socketPath: conn.socketPath } : {},
  // ...
});
```

`call()` and `stream()` are for programmatic requests (health probes, internal admin calls) where
direct buffering or streaming is needed without going through the proxy layer.

This means `@fastify/http-proxy` continues to handle all proxy mechanics — streaming, SSE, WebSockets,
header forwarding — unchanged. Only the **connection options** change (URL + optional socket path).

### Platform adapter loading

`IServiceTransport` is loaded by the platform's `AdapterLoader` from `adapterOptions.serviceTransport`
in `kb.config.json`. It is **not** in `ADAPTER_DEFAULTS` — the gateway fails at startup if transport is
unconfigured (no NoOp fallback makes sense here).

`serviceTransport` is not in `ADAPTER_REGISTRY` and not exposed via `IPluginAdapters`, enforcing the
platform-only boundary established by ADR-0021.

### Unix socket upgrade path

When `KB_SOCKET_PATH` is set (injected by kb-dev from service config `socket:` field), services bind
to a unix domain socket instead of a TCP port. The `getListenOptions(port, host)` utility in
`@kb-labs/shared-http` handles this transparently:

```typescript
export function getListenOptions(port: number, host = '0.0.0.0') {
  const socket = process.env.KB_SOCKET_PATH;
  if (socket) {
    rmSync(socket, { force: true });          // remove stale file from previous crash
    mkdirSync(dirname(socket), { recursive: true });
    return { path: socket };
  }
  return { port, host };
}
```

Socket path convention: `/tmp/kb-<projectHash>/<serviceName>.sock`
where `projectHash` = first 8 hex chars of MD5 over the absolute project root.
macOS 104-char socket path limit: `/tmp/kb-a3f5c901/marketplace.sock` = 33 chars ✓

### Declarative health probes in kb-dev

Services that declare `socket:` in `devservices.yaml` get a unix-socket HTTP probe automatically.
kb-dev injects `KB_SOCKET_PATH` into the spawned process env and uses `ProbeUnix`
(HTTP GET over `net.Dial("unix", socketPath)`) instead of the regular HTTP probe.
On service stop, kb-dev removes the socket file (best-effort).

The existing `health_check: http://...` format continues to work when `socket:` is absent —
fully backwards compatible.

## Alternatives Considered

### Keep hardcoded TCP URLs in gateway config

Rejected. This prevents unix socket mode and makes topology changes require gateway-specific config
edits. The abstraction boundary is worth the added indirection.

### gRPC transport

Out of scope for this PR. The interface is transport-agnostic — a `GrpcServiceTransport` can be added
later without changing gateway code.

### Make serviceTransport a plugin adapter

Rejected. Plugins should never configure how the gateway routes to internal services — that is
platform infrastructure. ADR-0021 already establishes the type boundary. `serviceTransport` lives
in `IPlatformAdapters` only, outside `ADAPTER_REGISTRY`.

## Consequences

**Good:**
- Solo mode can eliminate all inter-service TCP ports — only gateway `:4000` and studio `:3000` need
  TCP.
- Gateway has a single seam for topology changes (TCP, unix socket, DNS).
- Service daemons are transport-oblivious — they call `getListenOptions()` and bind to whatever the
  platform injected.
- Health probes auto-upgrade to unix socket when socket is configured — no per-service changes needed.

**Neutral:**
- `undici` becomes a runtime dependency of `@kb-labs/adapters-service-transport-http`. Native `fetch()`
  cannot connect via unix domain sockets.

**Breaking:**
- `GatewayConfig.upstreams[].url` removed — replaced by `upstreams[].serviceId` + transport adapter
  config.
- `PROXY_TIMEOUT_MS` env var via `http.requestOptions` removed — timeout moves to transport config.
- Gateway startup fails if `adapterOptions.serviceTransport` is not configured.

## Implementation

| Package | Change |
|---|---|
| `core/platform` | `IServiceTransport` interface + types |
| `core/platform` | `serviceTransport?: IServiceTransport` on `IPlatformAdapters` |
| `adapters/service-transport-http` | `HttpServiceTransport` using undici `Pool` |
| `adapters/service-transport-http` | `manifest.ts` + `createAdapter` for platform loader |
| `plugins/gateway/contracts` | Remove `transport` from `GatewayConfigSchema`; upstream uses `serviceId` |
| `plugins/gateway/app` | Load transport via `platform.getAdapter<IServiceTransport>('serviceTransport')` |
| `shared/http` | `getListenOptions(port, host)` — checks `KB_SOCKET_PATH` |
| `plugins/rest-api/app` | `server.listen(getListenOptions(...))` |
| `services/workflow/daemon` | Same |
| `services/marketplace/app` | Same |
| `core/plugin-contracts` | `socket?: string` on `ServiceRuntime` |
| `tools/kb-dev` | `ProbeUnix`, `ClassifyServiceProbe`, `Socket` config field, `KB_SOCKET_PATH` injection, socket cleanup on stop |
| `e2e/gateway` | Transport e2e tests (TR-01..TR-07) |

## Project-aware resolution amendment (2026-10-09)

`IServiceTransport` also resolves project-scoped connections by both project
and service identity:

```typescript
interface IServiceTransport {
  resolveProjectService(
    projectId: string,
    serviceId: string,
  ): Promise<ProjectServiceConnectionInfo | undefined>;
}

interface ProjectServiceConnectionInfo extends ServiceConnectionInfo {
  pathPrefix?: string;
  headers?: Readonly<Record<string, string>>;
  release?: () => void;
}
```

`release` is optional because cloud services need no lease; local transport
returns it to release the lazy runtime after the request. The local host
implementation resolves the project through `ProjectRouting.acquire` and uses
the runtime's internal `/{serviceId}` guard mount. Cloud transport reads the
per-project service address map, for example
`projectServices[projectId][serviceId].url`; a deployment may provide this map
or a per-project address template. Gateway routing always calls the same
project-aware transport contract and does not branch on topology.

Public project URLs are service-namespaced:
`/api/v1/projects/{projectId}/{serviceId}/{servicePath}`. Service manifests
supply the public `serviceId` and internal `rewritePrefix`; the Gateway removes
the public service namespace and restores only that declared internal mount.
Unknown service IDs are rejected before transport resolution. Because a
project-scoped service ID is part of the public API, renaming or splitting a
service is a breaking change.
