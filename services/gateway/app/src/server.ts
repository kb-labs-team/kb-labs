import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHttpProxy from "@fastify/http-proxy";
import { platform, getAdapterStatus } from "@kb-labs/core-runtime";
import {
  createHttpLogger,
  createServiceReadyResponse,
  registerOpenAPI,
} from "@kb-labs/shared-http";
import {
  logDiagnosticEvent,
  type ICache,
  type ILogger,
  type IServiceTransport,
} from "@kb-labs/core-platform";
import type { GatewayConfig } from "@kb-labs/gateway-contracts";
import { HostRegistrationSchema } from "@kb-labs/gateway-contracts";
import {
  AuthService,
  type JwtConfig,
  type UsersStore,
  type SessionsStore,
  type InvitesStore,
  type ProviderRegistry,
  type IPolicyDecisionPoint,
  type TenantResolver,
  type RateLimiter,
  type OAuthStateStore,
  type AuthReadiness,
} from "@kb-labs/gateway-auth";
import { resolveAccess } from "./access.js";
import { createAuthMiddleware } from "./auth/middleware.js";
import { registerAuthHealthRoute } from "./auth/health-route.js";
import {
  registerAuthRoutes,
  type MachineAuthRoutesUserExt,
} from "./auth/routes.js";
import { createUserAuthMiddleware } from "./auth/user-auth-middleware.js";
import {
  registerUserAuthRoutes,
  createUserRefreshFn,
  type UserAuthServiceForRoutes,
} from "./auth/user-routes.js";
import { registerExecuteRoutes } from "./execute/routes.js";
import { registerLLMGatewayRoutes } from "./llm/routes.js";
import { registerTelemetryRoutes } from "./telemetry/routes.js";
import { registerPlatformRoutes } from "./platform/routes.js";
import { registerAggregatedDocsRoutes } from "./docs/routes.js";
import { HostRegistry } from "./hosts/registry.js";
import { attachGatewayWs, type SocketWsUpstream } from "./ws/gateway-ws.js";
import { GatewayObservabilityCollector } from "./observability/collector.js";
import { randomUUID } from "node:crypto";
import { registerInternalRoutes } from "./internal/routes.js";
import {
  createPressureOnRequest,
  createPressurePreHandler,
  createPressureOnResponse,
} from "./pressure/index.js";
import { globalDispatcher } from "./hosts/dispatcher.js";
import {
  createStudioStatic,
  createStudioUrlRewriter,
} from "./studio/static.js";
import { registerWebhookAdminRoutes } from "./webhook/admin-routes.js";
import {
  registerWebhookRoutes,
  type WebhookManifestEntry,
} from "./webhook/router.js";

/**
 * User-auth dependencies injected from bootstrap. All fields optional so
 * the server can start without a documentDatabase adapter (degraded mode).
 */
export interface UserAuthServerDeps {
  userAuthService: UserAuthServiceForRoutes;
  users: UsersStore;
  sessions: SessionsStore;
  invites: InvitesStore;
  providers: ProviderRegistry;
  pdp: IPolicyDecisionPoint;
  tenantResolver: TenantResolver;
  /** Tenant to use when the Host header resolves no tenant and the request body carries
   *  none either (direct/local gateway access with no subdomain routing). Without this,
   *  such logins silently look up tenantId `''` and always fail with invalid_credentials,
   *  even for the correct password — see bootstrapTenantId in bootstrap.ts. */
  bootstrapTenantId: string;
  cookieSecure: boolean;
  accessTtlSec: number;
  refreshTtlSec: number;
  inviteTtlMs: number;
  rateLimiter?: RateLimiter;
  authRateLimit?: {
    loginPerIpPerMinute: number;
    loginPerEmailPerMinute: number;
  };
  /** OAuth state store (KV-backed). When present, redirect/OAuth routes are registered. */
  oauthState?: OAuthStateStore;
  /** Per-IP callback rate-limit for the OAuth callback. */
  oauthCallbackPerIpPerMinute?: number;
  /** Evaluates auth readiness (admin present, secret sane). Enables `GET /health/auth`. */
  authReadiness?: () => Promise<AuthReadiness>;
}

/** Strip bearer tokens from query params before logging (prevents JWT leakage in access logs). */
function redactQueryToken(url: string): string {
  return url.replace(/([?&]access_token=)[^&]*/gi, "$1[REDACTED]");
}

/**
 * Public base URL of the gateway: GATEWAY_PUBLIC_URL when set, otherwise the
 * loopback URL of the resolved listen port.
 */
export function resolvePublicUrl(listenPort: number): string {
  return process.env.GATEWAY_PUBLIC_URL ?? `http://localhost:${listenPort}`;
}

export async function createServer(
  config: GatewayConfig,
  cache: ICache,
  logger: ILogger,
  jwtConfig: JwtConfig,
  registry: HostRegistry | undefined,
  serviceTransport: IServiceTransport,
  userAuth?: UserAuthServerDeps,
  webhookManifests?: WebhookManifestEntry[],
) {
  const gatewayLogger = createHttpLogger(logger, {
    serviceId: "gateway",
    layer: "service",
    component: "gateway-server",
    operation: "gateway.http",
  });
  // Studio hosting (task 2.3): validated first so a missing bundle fails startup
  // with KB_HOST_STUDIO_ASSETS_MISSING before anything is bound.
  const studioEnabled = config.studio?.enabled === true;
  const studioStatic = studioEnabled
    ? await createStudioStatic(config)
    : undefined;
  const app = Fastify({
    logger: false,
    // CD-10: gateway sits behind nginx; parse X-Forwarded-For for real client IPs.
    trustProxy: true,
    // Studio calls auth under /api/auth/*; route it to the gateway's /auth/*.
    ...(studioEnabled
      ? {
          rewriteUrl: ((rewrite) => (req: { url?: string }) =>
            rewrite(req.url ?? "/"))(createStudioUrlRewriter(config)),
        }
      : {}),
  });

  // Cookie parsing — required by user-auth middleware and cookie-based sessions.
  await app.register(fastifyCookie);

  const isProduction = process.env.NODE_ENV === "production";

  // OpenAPI / Swagger UI — must be registered before routes
  await registerOpenAPI(app, {
    title: "KB Labs Gateway",
    description:
      "Central API gateway — auth, LLM, telemetry, platform dispatch",
    version: "1.0.0",
    servers: [{ url: resolvePublicUrl(config.port), description: "Local dev" }],
    ui: !isProduction,
  });

  // CORS disabled at gateway level — browser clients (Studio) connect via same-origin or
  // have CORS handled at the reverse-proxy / CDN layer. Reflecting arbitrary origins
  // (origin: true) would allow any attacker site to make credentialed cross-origin requests.
  await app.register(fastifyCors, { origin: false });
  const observability = new GatewayObservabilityCollector(config);
  observability.register(app);

  // Studio SPA at `/` — before auth/pressure so the shell loads pre-login.
  if (studioStatic) {
    app.addHook("onRequest", studioStatic.onRequest);
    gatewayLogger.info(`Studio served from ${studioStatic.dir}`);
  }

  // ── Pressure control (ADR-0056) ────────────────────────────────────
  // Registered BEFORE upstream proxies so 429 is returned before the request
  // is forwarded. No-op when `config.pressure` is absent or disabled.
  if (
    config.pressure &&
    config.pressure.enabled !== false &&
    platform.hasResourceBroker
  ) {
    const deps = { broker: platform.resourceBroker, logger, config };
    app.addHook("onRequest", createPressureOnRequest(deps));
    app.addHook("onResponse", createPressureOnResponse());
  }

  app.addHook("onRequest", async (request, reply) => {
    const requestId =
      (request.headers["x-request-id"] as string | undefined) ||
      request.id ||
      randomUUID();
    const traceId =
      (request.headers["x-trace-id"] as string | undefined) || randomUUID();

    request.id = requestId;
    reply.header("X-Request-Id", requestId);
    reply.header("X-Trace-Id", traceId);

    const safeUrl = redactQueryToken(request.url);
    request.kbLogger = createHttpLogger(logger, {
      serviceId: "gateway",
      layer: "service",
      component: "http-request",
      requestId,
      traceId,
      method: request.method,
      url: safeUrl,
      operation: "http.request",
    });
    request.kbLogger.debug("HTTP request started");
  });

  app.addHook("onResponse", async (request, reply) => {
    const requestLogger = request.kbLogger;
    if (!requestLogger) {
      return;
    }

    requestLogger.info("HTTP request completed", {
      "http.status_code": reply.statusCode,
    });
  });

  // ── Auth (B-023 fix) ────────────────────────────────────────────────
  // Registered globally on `app`, BEFORE the proxy upstreams below, so it
  // actually covers proxied routes (/api/v1/*, /api/exec/*, etc.) and not
  // just the gateway's own /auth/* routes. A prior version scoped these
  // hooks inside the `gatewayRoutes` child plugin registered AFTER the
  // proxy loop — Fastify hook encapsulation meant they never ran for
  // proxied requests, and rest-api/workflow/marketplace do not enforce
  // auth themselves, so every proxied route was reachable with no token
  // at all (confirmed: garbage Bearer token still got 200 on
  // /api/v1/studio/registry). Mirrors the pressure-hook precedent above,
  // which already runs globally ahead of the proxy loop for the same reason.
  //
  // User-auth middleware runs FIRST (before machine Bearer check).
  // Validates kb_access cookie, cross-tenant guard, CD-1 status check.
  // No-op when no cookie is present — machine auth takes over.
  if (userAuth) {
    app.addHook(
      "onRequest",
      createUserAuthMiddleware({
        users: userAuth.users,
        tenantResolver: userAuth.tenantResolver,
        jwtConfig,
      }),
    );
  }

  // Machine Bearer middleware — skips if userAuthContext already set by above.
  // When auth is disabled (solo/local), the middleware runs every request as
  // the local admin (B-023).
  app.addHook(
    "onRequest",
    createAuthMiddleware(cache, jwtConfig, {
      authEnabled: resolveAccess(config).authEnabled,
    }),
  );

  // ── Proxy upstreams ────────────────────────────────────────────────
  // Connection details (baseUrl, socketPath) come from IServiceTransport.
  // WS-enabled upstreams bound to a unix socket: @fastify/http-proxy can't dial
  // unix sockets for WS upgrades, so the gateway proxies those WS itself (see
  // attachGatewayWs). HTTP for the same prefix still goes through http-proxy.
  const socketWsUpstreams: SocketWsUpstream[] = [];

  for (const [name, upstream] of Object.entries(config.upstreams)) {
    const conn = serviceTransport.connectionInfo(upstream.serviceId);
    if (!conn) {
      throw new Error(
        `Gateway startup error: no transport config for upstream "${name}" (serviceId: "${upstream.serviceId}"). ` +
          `Configure @kb-labs/adapters-service-transport-http as adapterOptions.serviceTransport.services in kb.config.json.`,
      );
    }
    // A WS upstream on a unix socket is handled by the gateway's own dialer, not
    // by http-proxy's websocket support (which only works over TCP).
    const wsOverSocket =
      Boolean(upstream.websocket) && Boolean(conn.socketPath);
    if (wsOverSocket) {
      socketWsUpstreams.push({
        prefix: upstream.prefix,
        rewritePrefix: upstream.rewritePrefix ?? upstream.prefix,
        socketPath: conn.socketPath!,
      });
    }
    await app.register(fastifyHttpProxy, {
      upstream: conn.baseUrl,
      prefix: upstream.prefix,
      rewritePrefix: upstream.rewritePrefix ?? upstream.prefix,
      disableCache: true,
      // Disable http-proxy WS for socket upstreams — the gateway dialer owns it.
      websocket: wsOverSocket ? false : (upstream.websocket ?? false),
      undici: {
        // Restore 1-hour body timeout for SSE streams and large transfers.
        // undici defaults: headersTimeout=30s, bodyTimeout=300s — too short for streaming.
        bodyTimeout: 3_600_000,
        ...(conn.socketPath ? { socketPath: conn.socketPath } : {}),
      },
    });
    const connDesc = conn.socketPath
      ? `${conn.baseUrl} (unix:${conn.socketPath})`
      : conn.baseUrl;
    const wsDesc = upstream.websocket
      ? wsOverSocket
        ? ", ws→unix"
        : ", ws"
      : "";
    gatewayLogger.info(
      `Upstream registered: ${name} → ${connDesc} (${upstream.prefix}${wsDesc})`,
    );
  }

  // ── Gateway's own routes ────────────────────────────────────────────
  // Auth hooks now run globally (see above) and already cover these routes
  // via Fastify's hook inheritance (parent hooks apply to child-registered
  // routes), so they are not repeated here.
  await app.register(async function gatewayRoutes(scope) {
    // Per-tenant pressure (ADR-0056). Runs after auth so AuthContext is set.
    if (
      config.pressure?.perTenant?.enabled === true &&
      platform.hasResourceBroker
    ) {
      scope.addHook(
        "preHandler",
        createPressurePreHandler({
          broker: platform.resourceBroker,
          logger,
          config,
        }),
      );
    }

    // Machine auth routes (/auth/register, /auth/token, /auth/refresh).
    // When userAuth is available, wire user cookie refresh into /auth/refresh.
    const authService = new AuthService(cache, jwtConfig);
    const userExt: MachineAuthRoutesUserExt | undefined = userAuth
      ? {
          userRefreshFn: createUserRefreshFn({
            userAuthService: userAuth.userAuthService,
            cookieOpts: { cookieSecure: userAuth.cookieSecure },
          }),
          pdp: userAuth.pdp,
        }
      : undefined;
    registerAuthRoutes(
      scope as unknown as Parameters<typeof registerAuthRoutes>[0],
      authService,
      userExt,
    );

    // User-auth routes — all new endpoints + /auth/me.
    if (userAuth) {
      registerUserAuthRoutes(
        scope as unknown as Parameters<typeof registerUserAuthRoutes>[0],
        {
          userAuthService: userAuth.userAuthService,
          users: userAuth.users,
          sessions: userAuth.sessions,
          invites: userAuth.invites,
          providers: userAuth.providers,
          pdp: userAuth.pdp,
          tenantResolver: userAuth.tenantResolver,
          bootstrapTenantId: userAuth.bootstrapTenantId,
          cookieOpts: { cookieSecure: userAuth.cookieSecure },
          accessTtlSec: userAuth.accessTtlSec,
          refreshTtlSec: userAuth.refreshTtlSec,
          inviteTtlMs: userAuth.inviteTtlMs,
          jwtConfig,
          rateLimiter: userAuth.rateLimiter,
          authRateLimit: userAuth.authRateLimit,
          oauthState: userAuth.oauthState,
          oauthCallbackPerIpPerMinute: userAuth.oauthCallbackPerIpPerMinute,
        },
      );
    }

    // Health (public) — comprehensive adapter + upstream health
    const HEALTH_CACHE_KEY = "__gateway_health";
    const HEALTH_CACHE_TTL = 15_000; // 15s cache to prevent health DDoS
    const startupTime = Date.now();

    const collectHealthSnapshot = async () => {
      const cached = await cache
        .get<Record<string, unknown>>(HEALTH_CACHE_KEY)
        .catch(() => null);
      if (cached) {
        return cached;
      }

      const adapterNames = [
        "llm",
        "cache",
        "analytics",
        "vectorStore",
        "embeddings",
      ] as const;
      const adapters: Record<
        string,
        { available: boolean; latencyMs?: number }
      > = {};

      for (const name of adapterNames) {
        await observability.observeOperation(
          `gateway.adapter.${name}`,
          async () => {
            const probeStart = Date.now();
            try {
              // Try direct property first (production runtime stores adapters as platform.llm etc.),
              // then fall back to getAdapter() for environments where only that API is available.
              type FlexPlatform = Record<string, unknown> & {
                getAdapter?: (n: string) => unknown;
              };
              const pf = platform as unknown as FlexPlatform;
              const adapter = pf[name] ?? pf.getAdapter?.(name);
              adapters[name] = {
                available: !!adapter,
                latencyMs: Date.now() - probeStart,
              };
            } catch {
              adapters[name] = {
                available: false,
                latencyMs: Date.now() - probeStart,
              };
            }
          },
        );
      }

      const upstreams: Record<string, { status: string; latencyMs?: number }> =
        {};
      for (const [name, upstream] of Object.entries(config.upstreams)) {
        await observability.observeOperation(
          `gateway.upstream.${name}.health`,
          async () => {
            const probeStart = Date.now();
            try {
              const res = await serviceTransport.call(upstream.serviceId, {
                path: "/health",
                signal: AbortSignal.timeout(2000),
              });
              const latencyMs = Date.now() - probeStart;
              upstreams[name] = { status: res.ok ? "up" : "down", latencyMs };
              if (!res.ok) {
                logDiagnosticEvent(logger, {
                  domain: "service",
                  event: "gateway.upstream.health",
                  level: "warn",
                  reasonCode: "upstream_unavailable",
                  message: "Gateway upstream health probe failed",
                  outcome: "failed",
                  serviceId: "gateway",
                  route: `${upstream.prefix}/health`,
                  evidence: {
                    upstreamId: name,
                    serviceId: upstream.serviceId,
                    statusCode: res.statusCode,
                    latencyMs,
                  },
                });
              }
            } catch (error) {
              const latencyMs = Date.now() - probeStart;
              upstreams[name] = { status: "down", latencyMs };
              logDiagnosticEvent(logger, {
                domain: "service",
                event: "gateway.upstream.health",
                level: "warn",
                reasonCode: "upstream_unavailable",
                message: "Gateway upstream health probe failed",
                outcome: "failed",
                error:
                  error instanceof Error ? error : new Error(String(error)),
                serviceId: "gateway",
                route: `${upstream.prefix}/health`,
                evidence: {
                  upstreamId: name,
                  serviceId: upstream.serviceId,
                  latencyMs,
                },
              });
            }
          },
        );
      }

      const llmOk = adapters.llm?.available ?? false;
      const allOk = Object.values(adapters).every((a) => a.available);
      const snapshot = {
        status: llmOk ? (allOk ? "healthy" : "degraded") : "unhealthy",
        version: "1.0",
        uptime: Math.floor((Date.now() - startupTime) / 1000),
        timestamp: new Date().toISOString(),
        adapters,
        upstreams,
      };

      await cache
        .set(HEALTH_CACHE_KEY, snapshot, HEALTH_CACHE_TTL)
        .catch(() => {});
      return snapshot;
    };

    scope.get(
      "/health",
      { schema: { tags: ["System"], summary: "Gateway health check" } },
      async () => {
        return collectHealthSnapshot();
      },
    );

    scope.get(
      "/health/adapters",
      {
        schema: {
          tags: ["System"],
          summary:
            "Platform adapter status — mode (real | inmemory | noop) per slot",
        },
      },
      async () => {
        return getAdapterStatus();
      },
    );

    if (userAuth?.authReadiness) {
      registerAuthHealthRoute(scope, userAuth.authReadiness);
    }

    scope.get(
      "/ready",
      { schema: { tags: ["System"], summary: "Gateway readiness check" } },
      async (_request, reply) => {
        const health = await collectHealthSnapshot();
        const upstreams =
          (health.upstreams as
            | Record<string, { status?: string }>
            | undefined) ?? {};
        const missingRequiredUpstreams = ["rest"].filter(
          (id) => (upstreams[id]?.status ?? "down") !== "up",
        );
        const ready = missingRequiredUpstreams.length === 0;

        return reply.code(ready ? 200 : 503).send(
          createServiceReadyResponse({
            ready,
            status: ready ? "ready" : "degraded",
            reason: ready
              ? "ready"
              : `upstream_unavailable:${missingRequiredUpstreams.join(",")}`,
            components: {
              gatewayAdapters: {
                ready: true,
              },
              restUpstream: {
                ready: (upstreams.rest?.status ?? "down") === "up",
                status: upstreams.rest?.status ?? "down",
              },
              workflowUpstream: {
                ready: (upstreams.workflow?.status ?? "down") === "up",
                status: upstreams.workflow?.status ?? "down",
              },
              marketplaceUpstream: {
                ready: (upstreams.marketplace?.status ?? "down") === "up",
                status: upstreams.marketplace?.status ?? "down",
              },
            },
          }),
        );
      },
    );

    scope.get(
      "/metrics",
      {
        schema: {
          tags: ["Observability"],
          summary: "Gateway metrics in Prometheus format",
        },
      },
      async (_request, reply) => {
        const health = await collectHealthSnapshot();
        const status =
          (health.status as "healthy" | "degraded" | "unhealthy" | undefined) ??
          "healthy";
        reply.header(
          "Content-Type",
          "text/plain; version=0.0.4; charset=utf-8",
        );
        return observability.renderPrometheusMetrics(status);
      },
    );

    scope.get(
      "/observability/describe",
      {
        schema: {
          tags: ["Observability"],
          summary: "Gateway observability contract descriptor",
        },
      },
      async () => observability.buildDescribe(),
    );

    scope.get(
      "/observability/health",
      {
        schema: {
          tags: ["Observability"],
          summary: "Gateway observability health snapshot",
        },
      },
      async () => {
        const health = await collectHealthSnapshot();
        const adapterChecks = Object.entries(
          (health.adapters as
            | Record<string, { available?: boolean; latencyMs?: number }>
            | undefined) ?? {},
        ).map(([id, value]) => ({
          id,
          available: !!value?.available,
          latencyMs: value?.latencyMs,
        }));
        const upstreamChecks = Object.entries(
          (health.upstreams as
            | Record<string, { status?: string; latencyMs?: number }>
            | undefined) ?? {},
        ).map(([id, value]) => ({
          id,
          status: value?.status ?? "unknown",
          latencyMs: value?.latencyMs,
        }));
        const status =
          (health.status as "healthy" | "degraded" | "unhealthy" | undefined) ??
          "healthy";
        return observability.buildHealth({
          status,
          adapterChecks,
          upstreamChecks,
        });
      },
    );

    // Host registration (public)
    // Use injected registry (with persistence) or fallback to cache-only
    if (!registry) {
      gatewayLogger.warn(
        "No persistent HostRegistry injected — hosts will be lost on restart",
      );
    }
    const hostRegistry = registry ?? new HostRegistry(cache);
    scope.post(
      "/hosts/register",
      { schema: { tags: ["Hosts"], summary: "Register a host" } },
      async (request, reply) => {
        const parsed = HostRegistrationSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "Bad Request", issues: parsed.error.issues });
        }
        const result = await hostRegistry.register(parsed.data);
        return reply.code(201).send({
          hostId: result.descriptor.hostId,
          machineToken: result.machineToken,
          status: result.descriptor.status,
        });
      },
    );

    // List hosts (auth required)
    scope.get(
      "/hosts",
      { schema: { tags: ["Hosts"], summary: "List registered hosts" } },
      async (request, reply) => {
        const auth = request.authContext;
        if (!auth) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        const hosts = await hostRegistry.list(auth.namespaceId);
        return { hosts };
      },
    );

    // Get host by ID (auth required)
    scope.get<{ Params: { hostId: string } }>(
      "/hosts/:hostId",
      { schema: { tags: ["Hosts"], summary: "Get host by ID" } },
      async (request, reply) => {
        const auth = request.authContext;
        if (!auth) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        const { hostId } = request.params;
        const host = await hostRegistry.get(hostId, auth.namespaceId);
        if (!host) {
          return reply.code(404).send({ error: "Host not found" });
        }
        return host;
      },
    );

    // Deregister host (auth required)
    scope.delete<{ Params: { hostId: string } }>(
      "/hosts/:hostId",
      { schema: { tags: ["Hosts"], summary: "Deregister a host" } },
      async (request, reply) => {
        const auth = request.authContext;
        if (!auth) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        const { hostId } = request.params;
        const deleted = await hostRegistry.deregister(hostId, auth.namespaceId);
        if (!deleted) {
          return reply.code(404).send({ error: "Host not found" });
        }
        return reply.code(204).send();
      },
    );

    // Execute endpoint — public API for CLI/Studio clients (auth required)
    registerExecuteRoutes(
      scope as unknown as Parameters<typeof registerExecuteRoutes>[0],
      logger,
    );

    // AI Gateway — OpenAI-compatible LLM endpoint (auth required)
    registerLLMGatewayRoutes(
      scope as unknown as Parameters<typeof registerLLMGatewayRoutes>[0],
      logger,
    );

    // Telemetry ingestion — unified event collection (auth required)
    registerTelemetryRoutes(
      scope as unknown as Parameters<typeof registerTelemetryRoutes>[0],
      logger,
    );

    // Unified Platform API — single dispatch for any adapter (auth required)
    registerPlatformRoutes(
      scope as unknown as Parameters<typeof registerPlatformRoutes>[0],
      logger,
    );

    // Aggregated docs — /openapi-merged.json + /docs-all
    registerAggregatedDocsRoutes(
      scope as unknown as Parameters<typeof registerAggregatedDocsRoutes>[0],
      config,
      serviceTransport,
      cache,
    );

    registerInternalRoutes(
      scope as unknown as Parameters<typeof registerInternalRoutes>[0],
      process.env.GATEWAY_INTERNAL_SECRET,
      hostRegistry,
      cache,
    );

    // Webhook admin routes — provision / list / revoke (auth required, inside scope).
    // Registered unconditionally when the resource broker is available so that the
    // admin API (GET /api/v1/webhooks, POST /api/v1/webhooks/provision, DELETE) works
    // even in environments where no webhook-enabled plugins are currently installed.
    if (platform.hasResourceBroker) {
      const webhookBaseUrl =
        resolvePublicUrl(config.port);
      // Thin adapter: globalDispatcher.call() requires namespaceId — threaded via optional field
      const provisionBackend = {
        async execute({
          handlerRef,
          pluginRoot,
          input,
          namespaceId,
        }: {
          handlerRef: string;
          pluginRoot: string;
          input: unknown;
          namespaceId?: string;
        }): Promise<unknown> {
          if (!namespaceId) {
            return;
          }
          const hostId = globalDispatcher.firstHostWithCapability(
            namespaceId,
            "execution",
          );
          if (!hostId) {
            return;
          }
          return globalDispatcher.call(
            namespaceId,
            hostId,
            "execution",
            "execute",
            [{ handlerRef, pluginRoot, input }],
          );
        },
      };
      registerWebhookAdminRoutes(
        scope as unknown as Parameters<typeof registerWebhookAdminRoutes>[0],
        {
          cache,
          logger,
          backend: provisionBackend,
          manifests: webhookManifests ?? [],
          baseUrl: webhookBaseUrl,
          broker: platform.resourceBroker,
        },
      );
    }
  });

  // ── Webhook delivery routes (outside gatewayRoutes — no auth middleware) ──────
  // Registered in a separate Fastify scope so both user-auth and machine-token
  // middleware (which live only inside gatewayRoutes) are bypassed automatically.
  // Delivery auth is handled by the webhook router itself (secret / hmac / custom).
  if (webhookManifests?.length && platform.hasResourceBroker) {
    const webhookBaseUrl =
      resolvePublicUrl(config.port);
    await app.register(async (webhookScope) => {
      await registerWebhookRoutes(webhookScope, {
        cache,
        broker: platform.resourceBroker,
        logger,
        manifests: webhookManifests,
        baseUrl: webhookBaseUrl,
      });
    });
  }

  // ── Gateway WebSocket endpoints ────────────────────────────────────
  // Must be after ready() so http-proxy's upgrade listener is registered.
  // attachGatewayWs captures it, removes it, and installs a unified handler
  // that dispatches gateway WS paths to raw ws handlers and delegates
  // everything else (upstream WS proxy) to http-proxy.
  await app.ready();
  attachGatewayWs(
    app.server,
    cache,
    jwtConfig,
    logger,
    registry,
    socketWsUpstreams,
  );

  return app;
}
