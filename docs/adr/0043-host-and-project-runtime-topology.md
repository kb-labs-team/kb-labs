# ADR-0043: Host and Project Runtime Topology

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** runtime, topology, gateway, services, architecture

## Context

Every long-running service starts through `runService()`
(`shared/daemon/src/daemon.ts:196`), which calls `launchPlatform()`
(`core/runtime/src/platform-launch.ts`) and then the service's `setup()`.
The result is "one process = one application = one project": ten services per
project, ports shifted by hand with `--net-offset`.

The target-architecture draft (`docs/architecture/target/04-topology.md`,
model B) proposes a machine-level **host** process (gateway, marketplace,
state daemon, Studio static) plus one lazily started **project runtime** per
active project (rest, workflow, mcp). Task 2.1 asks whether the host half is
feasible on the real code before any migration starts.

This ADR records a throw-away spike (`tmp-host-spike/`, not committed) and its
findings.

## What the spike did

One Node process, launched with a temp `HOME`, a temp platform root and random
high ports (47101-47103; the default ports 4000/5050/5070/7777/7778 were never
touched):

1. `launchPlatform({ applicationId: "kb-host", kind: "service" })` exactly once.
2. State daemon `StateDaemonServer.start()`, marketplace `createServer()` +
   `MarketplaceService`, and the gateway `startGateway()` body run one after
   another on the same `PlatformRuntime`, each on its own port taken from
   `serviceTransport.listenAddress()`.
3. Gateway proxies `/api/v1/marketplace` and `/api/v1/state` to the other two
   via the existing `IServiceTransport` (`connectionInfo()`).
4. Studio `dist/` served at `/` from the same listener, with SPA fallback.
5. One SIGTERM handler owned by the host tears everything down.

The gateway and marketplace setups had to be **copied** into the spike because
they are not exported (see B3). The main checkout's built `gateway-auth`
`dist` lacked `evaluateAuthReadiness`, so the spike stubs it (diagnostics
only). Everything ran under `tsx` (no production bundles).

## Findings

### What worked

- One `launchPlatform` + three setups in one process starts and serves.
  Startup 723-900 ms to ready (dev transpile via tsx).
- `GET /` returns Studio `index.html` with runtime config injected; an unknown
  path (`/some/spa/route`) falls back to `index.html`.
- `GET /health` on the gateway reports both upstreams `up`
  (marketplace 32 ms, state 7 ms). `PUT`/`GET /api/v1/state/state/foo`
  round-trips through the gateway proxy; `/api/v1/marketplace/health` is 200.
- `serviceTransport.listenAddress(serviceId)` gives each module its own port in
  the same process without clashes. Bind and route stay consistent because
  both go through the same offset.
- SIGTERM from a single owner: teardown in reverse order, exit 0, all three
  ports released, no stray process.
- Existing `setup()` bodies needed **no logic changes** to run co-located; the
  only edits were exporting them and passing a context.

### What did not work / refuted assumptions

- **Composing `runService` x3 in one process is impossible**, as suspected:
  a second `launchPlatform` with another id throws
  `Platform is already launched for "kb-host" ... cannot relaunch it`
  (`platform-launch.ts:346-357`; verified by running it). It is also
  impossible for a reason not in 04: `runManagedService` is not exported
  (`daemon.ts:88`) and each call registers its own signal handlers and calls
  `process.exit` (`daemon.ts:181,186-187`), so N composed services would race
  on the first signal.
- The gateway cannot register Studio static routes from outside: `createServer`
  calls `app.ready()` itself (`services/gateway/app/src/server.ts:813`) and
  Fastify refuses `register` after that. The spike worked around it by
  replacing the http server's `request` listener (a hack, not a design).
- Studio is **not** just a static file server. `studio/app/server.js` also
  (a) injects `window.__KB_STUDIO_CONFIG__` into `index.html`,
  (b) proxies `/api/*` to the gateway **stripping the `/api` prefix**, and
  (c) applies cache headers and a path-traversal guard. Item (b) is
  load-bearing: the SPA calls `/api/auth/*` (`studio/app/src/auth/api-base.ts:14`)
  and the gateway only has `/auth/*`; the refresh cookie `Path` is
  `/api/auth/refresh`. Serving Studio from the gateway therefore needs a
  `/api` -> root alias for auth routes. **Not exercised in the spike** (code
  read only).
- Gateway upstreams are fixed at startup: `connectionInfo()` is read once and a
  static `@fastify/http-proxy` is registered per upstream
  (`server.ts:244,262`). That is fine for machine-level services and
  **insufficient for project runtimes**, whose addresses appear and disappear.

### Inventory: process-global state per module

| Concern | State daemon | Marketplace | Gateway | Studio `server.js` |
|---|---|---|---|---|
| Bind | port from transport, host default `localhost` (`bootstrap.ts`) | port from transport, host default `0.0.0.0` | ignores `ctx.port`; binds `config.port + KB_NET_OFFSET` (`bootstrap.ts:434-435`), host from config, default `0.0.0.0` | `PORT` + offset, `HOST` default `0.0.0.0` |
| `process.env` | none beyond platform | `KB_REGISTRY_URL`, `KB_REGISTRY_TOKEN` (`bootstrap.ts:39,44`) | `GATEWAY_JWT_SECRET`, `GATEWAY_INTERNAL_SECRET`, `GATEWAY_PUBLIC_URL`, `GATEWAY_BOOTSTRAP_*`, `AUTH_*`, `NODE_ENV`, `KB_NET_OFFSET` (bootstrap.ts:119-246,341,434; server.ts:131,730,742,796) | `KB_API_BASE_URL`, `KB_GATEWAY_TOKEN`, `KB_EVENTS_*`, `PORT`, `HOST`, `KB_NET_OFFSET` |
| `process.cwd()` | default arg of `bootstrap()` only | same | same (`bootstrap.ts:45`) | none |
| Signals | `runService` installs `SIGTERM`/`SIGINT` + `process.exit` | same | same | none |
| Module-level state | `InMemoryStateBroker` per instance (`server.ts:39`), fallback logger stamps `applicationId: "kb-labs"` | none | `HostRegistry` per instance; pressure limits registered on the shared `resourceBroker` | none |
| Hard-coded URLs | none | OpenAPI hint `localhost:${port}` | OpenAPI `servers` `http://localhost:4000` (`server.ts:139`); `GATEWAY_PUBLIC_URL` default `localhost:port+offset` (`server.ts:742,796`); CLI-credential `gatewayUrl` `http://127.0.0.1:${config.port}` (`bootstrap.ts:367`) | default `KB_API_BASE_URL` `http://localhost:4000/api/v1` |
| Entry auto-runs | `index.ts` exports only; `bin.ts` runs | `index.ts` runs `bootstrap()` on import | `index.ts` runs `bootstrap()` on import | runs only if entrypoint |

Process-wide, shared by anything in the same process (independent of module):
`platform` container on `process` under `Symbol.for('kb.platform')`
(`core/runtime/src/container.ts:940,974`), `globalThis.__KB_PLATFORM_CONFIG__`,
`__KB_RAW_CONFIG__`, `__KB_EFFECTIVE_CONFIG__`
(`platform-launch.ts:182-186`; read by `shared/command-kit`, `cli/bin`,
`config-adapter.ts`), `process.env` mutation by `.env` loading
(`config-loader.ts:196-201`) and `KB_SOCKET_HASH` derivation
(`config-loader.ts:218-227`), and `activeRuntime` (`platform-launch.ts:104`).
For a single host these are harmless. They are exactly what makes a second
project in the same process impossible, which confirms the 04 reasoning for
**not** doing model A now.

### Measurements (macOS, tsx dev transpile, in-memory adapters)

| | Single host (3 modules) | 3 separate processes (one module each) |
|---|---|---|
| Time to ready | 723-900 ms | 368 / 460 / 912 ms (started concurrently) |
| RSS ~10 s after start | ~259 MB | 246 + 243 + 251 = ~740 MB |

Each separate process pays the full runtime baseline (~245 MB under tsx), so
the host saves roughly two thirds of memory for three modules. Absolute
numbers are inflated by tsx and will be lower with tsup bundles; the ratio is
the useful part. Startup is not a win in wall time (the biggest module
dominates), it just does not add up.

## Decision

Proposed: **GO for the host half of model B.** Keep the rest of 04 unchanged.

1. One `kb-host` process calls `launchPlatform` once and composes machine-level
   modules (gateway, marketplace, state, Studio static) as **setups**, not as
   `runService` calls.
2. Introduce a composable module contract next to `runService`:
   `defineHostModule({ id, serviceId, setup })` and
   `runHost({ appId, modules })`. `runService` becomes the one-module special
   case of `runHost`, so services that stay standalone (rest, workflow, mcp
   until stage 3) keep working unchanged.
3. The host owns process concerns: one signal handler, one exit code, one
   teardown order (reverse of start), one health aggregate. Modules only
   return a teardown.
4. Studio is served by the gateway through a static-assets option on
   `createServer` (registered before `ready()`), including the `/api` alias
   for auth routes and runtime-config injection. `studio/app/server.js`
   remains only as a dev/Docker convenience until removed.
5. Project runtimes stay separate processes (per 04). The gateway needs a
   **dynamic** upstream resolver (project id -> address) instead of static
   `@fastify/http-proxy` registrations; this is stage 3.2 work, not a blocker
   for stage 2.
6. Bind policy moves to the host: the loopback-vs-auth guard
   (`gateway/app/src/bootstrap.ts:423`) is evaluated once for the host's
   effective bind, and modules that are internal-only (marketplace, state)
   bind loopback regardless of their old defaults.

### Blockers and minimal changes

| # | Blocker | Where | Change | Size |
|---|---|---|---|---|
| B1 | One application per process; `runService` bundles launch + setup | `platform-launch.ts:346-357`, `daemon.ts:196` | New `runHost` that launches once and iterates modules; `runService` delegates to it | S |
| B2 | Signal/exit ownership inside `runManagedService` | `daemon.ts:88,181,186-187` | Move signals and `process.exit` into `runHost` only; export a pure `startModule(ctx, setup)` | S |
| B3 | Setups not importable; entrypoints auto-run on import | gateway `bootstrap.ts:61` (private `startGateway`), gateway/marketplace `index.ts`, marketplace inline `setup` (`bootstrap.ts:38`) | Export `setup` functions from each package (subpath export or named export); keep `bin`/`index` as thin wrappers | S per module |
| B4 | Port/host resolution is per service and inconsistent (gateway ignores `ctx.port`) | `daemon.ts:69-82`, gateway `bootstrap.ts:434-435` | Export `resolveNetwork` per module; gateway takes `ctx.port`; `KB_NET_OFFSET` read in one place | S |
| B5 | Gateway cannot host Studio static | `server.ts:813` (`ready()` inside `createServer`) | Add `staticAssets` / `extraPlugins` option; alias `/api/auth/*` -> `/auth/*`; port config injection from `server.js`; add `@fastify/static` | M |
| B6 | Static upstreams | `server.ts:244,262` | Dynamic upstream resolver keyed by project id, backed by the project registry | M-L (stage 3.2) |
| B7 | Hard-coded `localhost:4000`/`127.0.0.1:<port>` URLs | `server.ts:139,742,796`; `bootstrap.ts:367`; `server.js` | Derive from one resolved public address in the host context | S |
| B8 | `serviceTransport.services` written by hand in config | user `kb.config` | Generated by the installer/host from the module list (stage 2/1 installer work) | M |
| B9 | Identity/log stamping drifts inside modules | state daemon `server.ts:29,50` (`applicationId: "kb-labs"`) | Modules must derive their logger from `ctx.logger.forComponent(...)` only | S |
| B10 | Global config, platform singleton, env mutation | `platform-launch.ts:182-186`, `container.ts:974`, `config-loader.ts:196-227` | **No change** for the host. Removing them is model A and stays out of scope | (L, deferred) |

Rough total for stage 2.2-2.3: about 2 M + 6 S, i.e. roughly 1.5-2.5 weeks of
one engineer, most of it B5 and the tests around `runHost`. B6 is the only
item that could surprise the schedule and belongs to stage 3.

## Consequences

### Positive

- Machine-level services stop multiplying processes: roughly one third of the
  memory of three separate processes in the measurement, one signal path, one
  place for bind policy.
- `setup()` functions are reused as they are; the change is at the launcher,
  not in service logic.
- The transport seam already does what is needed for co-located modules, so
  cloud (separate pods) and local (one host) share code.

### Negative

- A crash or blocked event loop in one module (for example a marketplace
  install spike) affects the gateway and state. Mitigation: the marketplace
  install path must stay non-blocking, or move to a worker; revisit if seen.
- Startup is not faster in wall time.
- Modules share one `platform` container and one `process.env`, so they
  cannot have different adapter sets or secrets.
- Two Studio serving paths coexist until `server.js` is removed.

### Alternatives Considered

- **Keep separate processes, only hide ports behind one external port.**
  Cheapest, but keeps N runtimes and N signal owners; does not reduce
  process count.
- **Model A (project in `AsyncLocalStorage`).** Blocked by the globals listed
  above; rejected for the first version, as in 04.
- **Fork per module inside the host.** Solves isolation but reintroduces N
  runtimes and IPC; only worth it if module fault isolation becomes a
  requirement.

## Implementation

Order: B1+B2+B3+B4 (host bootstrap, task 2.2), then B5+B7 (gateway serves
Studio, task 2.3), then B8 with the installer. B6 belongs to stage 3.2.
Each step needs regression tests: `runHost` start/teardown order, second
launch rejection, single signal path, gateway static + SPA fallback + auth
alias.

### Stage 3 implementation notes (project runtimes)

B6 is implemented as a resolver hook instead of a per-request transport lookup:
the gateway takes `projectRouting` (`GatewayEmbedOptions`) and serves
`/api/v1/projects/{projectId}/*` by asking it for an upstream on every request;
static upstreams stay for marketplace and state. The host supplies the hook
(`ProjectRuntimeManager` + project registry, ADR-0044). Runtimes are
`kb-project-runtime` processes (`services/project-runtime/app`) that run rest
and workflow through `runHost`, each on its own loopback port behind a single
guard address that demands a per-process secret header. `/ready` no longer
requires a `rest` upstream when the gateway serves project runtimes. Not done:
mcp in the runtime, WebSocket proxying to runtimes, per-module secret
enforcement (modules keep unauthenticated loopback ports), per-project plugin
sets (stage 7).

### Not verified by the spike

- Production bundles (`tsup`) and the installed layout: setups were run from
  source with `tsx`; memory and startup will differ.
- Real adapters (sqlite, redis, pino); the spike used the in-memory
  fallbacks. Gateway auth with `access.mode: "secured"` and login flow, the
  `/api/auth/*` alias and cookie `Path` behaviour, WebSocket upstreams, and
  Studio in a real browser (only HTML fetches were checked).
- Marketplace `readKbConfig(projectRoot)` registry lookup was dropped in the
  spike; how it maps to a machine-level module is open (04 says the project
  lock is an operation parameter).
- Windows and unix-socket transports.
- The gateway `evaluateAuthReadiness` path (stale local `dist`, stubbed).

## References

- `docs/architecture/target/04-topology.md`, `07-migration.md`, `10-clickup-tasks.md` (task 2.1),
  branch `docs/target-architecture` (PR #479)
- `shared/daemon/src/daemon.ts`, `core/runtime/src/platform-launch.ts`
- ADR-0020 (gateway identity), ADR-0036 (platform log context contract),
  [ADR-0042](./0042-release-engine-control-plane.md) (format reference)

---

**Last Updated:** 2026-09-26
