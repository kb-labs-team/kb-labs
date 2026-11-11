import Fastify from "fastify";
import type { RouteOptions } from 'fastify';
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
  type PlatformAuditStore,
  type ICache,
  type ILogger,
  type IServiceTransport,
} from "@kb-labs/core-platform";
import type { GatewayConfig } from "@kb-labs/gateway-contracts";
import { resolveGatewayPressureConfig } from "@kb-labs/gateway-contracts";
import type { ProjectServiceDeclaration } from "@kb-labs/plugin-contracts";
import { HostRegistrationSchema } from "@kb-labs/gateway-contracts";
import {
  AuthService,
  type JwtConfig,
  type UsersStore,
  type MembershipsStore,
  type SessionsStore,
  type ApiTokensStore,
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
import { sendAuthError } from "./auth/error-response.js";
import { registerAuthHealthRoute } from "./auth/health-route.js";
import {
  registerAuthRoutes,
  type MachineAuthRoutesUserExt,
} from "./auth/routes.js";
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
import { registerGatewayUxBoundary } from './ux-boundary.js';
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
import { WebhookHistoryStore } from './webhook/history-store.js';
import {
  registerWebhookRoutes,
  type WebhookManifestEntry,
} from "./webhook/router.js";
import {
  registerProjectRoutes,
  type ProjectRouting,
} from "./project-routing.js";
import type { HostRoutes } from "./host-routes.js";

/**
 * User-auth dependencies injected from bootstrap. All fields optional so
 * the server can start without a documentDatabase adapter (degraded mode).
 */
export interface UserAuthServerDeps {
  userAuthService: UserAuthServiceForRoutes;
  users: UsersStore;
  memberships: MembershipsStore;
  sessions: SessionsStore;
  apiTokens: ApiTokensStore;
  invites: InvitesStore;
  authAudit: PlatformAuditStore;
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
  projectRouting?: ProjectRouting,
  hostRoutes?: HostRoutes,
  routeObserver?: (route: RouteOptions) => void,
  installationIdentity?: { installationId?: string },
  projectServices?: readonly ProjectServiceDeclaration[],
  projectServiceTransport?: Pick<IServiceTransport, "resolveProjectService">,
  readinessControlAddress?: string,
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
  const access = resolveAccess(config);
  const pressureConfig = resolveGatewayPressureConfig(config, access.authEnabled);
  const pressureGatewayConfig = pressureConfig
    ? { ...config, pressure: pressureConfig }
    : config;
  const studioStatic = studioEnabled
    ? await createStudioStatic(config)
    : undefined;
  const bodyLimitBytes = 1024 * 1024;
  const app = Fastify({
    logger: false,
    bodyLimit: bodyLimitBytes,
    ajv: { customOptions: { removeAdditional: false } },
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
  registerGatewayUxBoundary(app, gatewayLogger, { bodyLimitBytes });
  if (routeObserver) {
    app.addHook("onRoute", (route) => {
      if (route.url) {
        routeObserver(route);
      }
    });
  }

  // Cookie parsing must run before the gate so secured cookie sessions are
  // visible when the global auth hook validates the request.
  await app.register(fastifyCookie);

  // Install the deny-by-default gate before OpenAPI, observability, Studio,
  // proxy, project, and plugin routes are registered.
  app.addHook("onRequest", createAuthMiddleware(cache, jwtConfig, {
    authEnabled: access.authEnabled,
    studioEnabled,
    internalSecret: process.env.GATEWAY_INTERNAL_SECRET,
    webhookManifests,
    ...(studioStatic ? { studioPublicAsset: studioStatic.isPublicAsset } : {}),
    ...(userAuth ? { userAuth: {
      users: userAuth.users,
      sessions: userAuth.sessions,
      apiTokens: userAuth.apiTokens,
      pdp: userAuth.pdp,
      tenantResolver: userAuth.tenantResolver,
      jwtConfig,
    } } : {}),
  }));

  const isProduction = process.env.NODE_ENV === "production";
  const webhookHistoryStore = platform.hasResourceBroker
    ? new WebhookHistoryStore(platform.documentDatabase)
    : undefined;

  // OpenAPI / Swagger UI — must be registered before routes
  await registerOpenAPI(app, {
    title: "KB Labs Gateway",
    description:
      "Central API gateway — auth, LLM, telemetry, platform dispatch",
    version: "1.0.0",
    servers: [{ url: resolvePublicUrl(config.port), description: "Local dev" }],
    ui: !isProduction,
  });

  // The gateway does not enable credentialed cross-origin requests. The global
  // auth hook answers protocol preflight without dispatch; deployed reverse proxy
  // or CDN policy controls CORS on the actual request/response.
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
  // is forwarded. Secured mode supplies the default tenant budget; pressure
  // stays inactive without config in local mode.
  if (
    pressureConfig &&
    pressureConfig.enabled !== false &&
    platform.hasResourceBroker
  ) {
    const deps = { broker: platform.resourceBroker, logger, config: pressureGatewayConfig };
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

  // ── Project runtimes (dynamic upstreams) ────────────────────────────
  // `/api/v1/projects/{projectId}/*` is resolved per request by the embedding
  // host, unlike the static upstreams above. Registered after the global auth
  // hooks, so it is covered by the same authentication.
  if (projectServices) {
    await registerProjectRoutes(
      app,
      projectServices,
      projectServiceTransport ?? serviceTransport,
      config.projectRequestTimeoutMs ?? 30_000,
    );
    gatewayLogger.info(
      "Project routing enabled: /api/v1/projects/{projectId}/{serviceId}/*",
    );
  }

  // ── Host API routes ─────────────────────────────────────────────────
  // Machine-level routes owned by the embedding host (for example
  // `/api/v1/projects`). Registered after the global auth hooks, so they are
  // covered by the same authentication; the gateway adds nothing on top.
  if (hostRoutes) {
    await app.register(hostRoutes);
    gatewayLogger.info("Host API routes registered");
  }

  // ── Gateway's own routes ────────────────────────────────────────────
  // Auth hooks now run globally (see above) and already cover these routes
  // via Fastify's hook inheritance (parent hooks apply to child-registered
  // routes), so they are not repeated here.
  await app.register(async function gatewayRoutes(scope) {
    // Per-tenant pressure (ADR-0056). Runs after auth so AuthContext is set.
    if (
      access.authEnabled &&
      pressureConfig?.enabled !== false &&
      pressureConfig?.perTenant?.enabled === true &&
      platform.hasResourceBroker
    ) {
      scope.addHook(
        "preHandler",
        createPressurePreHandler({
          broker: platform.resourceBroker,
          logger,
          config: pressureGatewayConfig,
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
          userLogoutFn: (refreshToken) => userAuth.userAuthService.logout(refreshToken),
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
          memberships: userAuth.memberships,
          sessions: userAuth.sessions,
          apiTokens: userAuth.apiTokens,
          invites: userAuth.invites,
          authAudit: userAuth.authAudit,
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
      "/health/identity",
      { schema: { tags: ["System"], summary: "Gateway installation identity", querystring: { type: 'object', properties: {}, additionalProperties: false }, response: { 200: { type: 'object', properties: { installationId: { type: 'string' } }, additionalProperties: false } } } },
      async () => ({
        ...(installationIdentity?.installationId ? { installationId: installationIdentity.installationId } : {}),
      }),
    );

    scope.get(
      "/health",
      { schema: { tags: ["System"], summary: "Gateway health check", querystring: { type: 'object', properties: {}, additionalProperties: false }, response: { 200: { type: 'object', properties: { studio: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }, status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] }, version: { type: 'string' }, uptime: { type: 'number' }, timestamp: { type: 'string', format: 'date-time' }, adapters: { type: 'object', additionalProperties: { type: 'object', properties: { available: { type: 'boolean' }, latencyMs: { type: 'number' } }, required: ['available'] } }, upstreams: { type: 'object', additionalProperties: { type: 'object', properties: { status: { type: 'string' }, latencyMs: { type: 'number' } }, required: ['status'] } }, projectRuntimes: { type: 'object', properties: { limit: { type: 'number' }, active: { type: 'number' }, runtimes: { type: 'array', items: { type: 'object', properties: { projectId: { type: 'string' }, state: { type: 'string' }, lastUsedAt: { type: 'string', format: 'date-time' }, inflight: { type: 'number' }, restarts: { type: 'number' }, keptRunningSchedules: { type: 'number' } }, required: ['projectId', 'state', 'lastUsedAt', 'inflight', 'restarts'], additionalProperties: false } } }, required: ['limit', 'active', 'runtimes'], additionalProperties: false } }, required: ['status', 'version', 'uptime', 'timestamp', 'adapters', 'upstreams'] } } } },
      async (request, reply) => {
        if (readinessControlAddress) {reply.header("x-kb-host-active-work-address", readinessControlAddress);}
        const snapshot = await collectHealthSnapshot();
        return {
          ...snapshot,
          ...(studioStatic ? { studio: { url: `${request.protocol}://${request.host}/` } } : {}),
          ...(projectRouting ? { projectRuntimes: projectRouting.status() } : {}),
        };
      },
    );

    scope.get(
      "/health/adapters",
      {
        schema: {
          tags: ["System"],
          summary:
            "Platform adapter status — mode (real | inmemory | noop | degraded) per slot",
          querystring: { type: 'object', properties: {}, additionalProperties: false },
          response: { 200: { type: 'array', items: { type: 'object', properties: { slot: { type: 'string' }, mode: { type: 'string', enum: ['real', 'inmemory', 'noop', 'degraded'] }, implementation: { type: 'string' }, configuredPackage: { type: 'string' }, reason: { type: 'string' }, correlationId: { type: 'string' }, action: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, command: { type: 'string' } }, required: ['id', 'label', 'command'] }, recordedAt: { type: 'string', format: 'date-time' } }, required: ['slot', 'mode', 'implementation', 'recordedAt'] } } },
        },
      },
      async () => {
        return getAdapterStatus();
      },
    );

    if (userAuth?.authReadiness) {
      registerAuthHealthRoute(scope, userAuth.authReadiness);
    }

    const readyResponseSchema = {
      type: "object",
      properties: {
        schema: { type: "string", const: "kb.ready/1" },
        ts: { type: "string", format: "date-time" },
        ready: { type: "boolean" },
        status: { type: "string", enum: ["ready", "degraded", "initializing"] },
        reason: { type: "string" },
        components: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              ready: { type: "boolean" },
              status: { type: "string" },
            },
            required: ["ready"],
          },
        },
      },
      required: ["schema", "ts", "ready", "status", "reason", "components"],
      additionalProperties: false,
    };

    scope.get(
      "/ready",
      {
        config: { uxFixture: { validResult: "error-envelope" } },
        schema: {
          tags: ["System"],
          summary: "Gateway readiness check",
          querystring: { type: "object", properties: {}, additionalProperties: false },
          response: { 200: readyResponseSchema, 503: readyResponseSchema },
        },
      },
      async (_request, reply) => {
        const health = await collectHealthSnapshot();
        const upstreams =
          (health.upstreams as
            | Record<string, { status?: string }>
            | undefined) ?? {};
        // A gateway that serves project runtimes has no project-scoped
        // upstream to wait for: runtimes start lazily on first request. The
        // machine-level upstreams it does route to are all required.
        const requiredUpstreams = projectRouting
          ? Object.keys(config.upstreams)
          : ["rest"];
        const missingRequiredUpstreams = requiredUpstreams.filter(
          (id) => (upstreams[id]?.status ?? "down") !== "up",
        );
        const ready = missingRequiredUpstreams.length === 0;
        const projectStatus = projectRouting?.status();
        const upstreamComponents = Object.fromEntries(
          requiredUpstreams.map((id) => [
            `upstream:${id}`,
            {
              ready: (upstreams[id]?.status ?? "down") === "up",
              status: upstreams[id]?.status ?? "down",
            },
          ]),
        );

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
              ...upstreamComponents,
              ...(projectStatus
                ? {
                    // Lazy: a project runtime is ready once started on demand,
                    // so none being active is a normal, ready state.
                    projectRuntimes: {
                      ready: true,
                      status: `${projectStatus.active}/${projectStatus.limit} active`,
                    },
                  }
                : {}),
            },
          }),
        );
      },
    );

    scope.get(
      "/metrics",
      {
        // Prometheus text exposition is consumed by scrapers, not UX JSON clients.
        config: { ux: 'raw' },
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
          querystring: { type: 'object', properties: {}, additionalProperties: false },
          response: { 200: { type: 'object' } },
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
          querystring: { type: 'object', properties: {}, additionalProperties: false },
          response: { 200: { type: 'object' } },
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
      { schema: { tags: ["Hosts"], summary: "Register a host", querystring: { type: 'object', properties: {}, additionalProperties: false }, body: { type: 'object', properties: { name: { type: 'string' }, namespaceId: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string', enum: ['filesystem', 'git', 'editor-context', 'execution'] } }, workspacePaths: { type: 'array', items: { type: 'string' } }, hostType: { type: 'string', enum: ['local', 'cloud'] } }, required: ['name', 'namespaceId', 'capabilities', 'workspacePaths'], additionalProperties: false }, response: { 201: { type: 'object', properties: { hostId: { type: 'string' }, machineToken: { type: 'string' }, status: { type: 'string' } }, required: ['hostId', 'machineToken', 'status'] }, 400: { type: 'object' } } } },
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
      { schema: { tags: ["Hosts"], summary: "List registered hosts", querystring: { type: 'object', properties: {}, additionalProperties: false }, response: { 200: { type: 'object', properties: { hosts: { type: 'array', items: { type: 'object' } } }, required: ['hosts'] }, 401: { type: 'object' } } } },
      async (request, reply) => {
        const auth = request.authContext;
        if (!auth) {
          return sendAuthError(reply, 401);
        }
        const hosts = await hostRegistry.list(auth.namespaceId);
        return { hosts };
      },
    );

    // Get host by ID (auth required)
    scope.get<{ Params: { hostId: string } }>(
      "/hosts/:hostId",
      { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ["Hosts"], summary: "Get host by ID", params: { type: 'object', properties: { hostId: { type: 'string' } }, required: ['hostId'], additionalProperties: false }, querystring: { type: 'object', properties: {}, additionalProperties: false }, response: { 200: { type: 'object' }, 401: { type: 'object' }, 404: { type: 'object' } } } },
      async (request, reply) => {
        const auth = request.authContext;
        if (!auth) {
          return sendAuthError(reply, 401);
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
      { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ["Hosts"], summary: "Deregister a host", params: { type: 'object', properties: { hostId: { type: 'string' } }, required: ['hostId'], additionalProperties: false }, querystring: { type: 'object', properties: {}, additionalProperties: false }, response: { 204: { type: 'null' }, 401: { type: 'object' }, 404: { type: 'object' } } } },
      async (request, reply) => {
        const auth = request.authContext;
        if (!auth) {
          return sendAuthError(reply, 401);
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
    if (webhookHistoryStore) {
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
          historyStore: webhookHistoryStore,
        },
      );
    }
  });

  // ── Webhook delivery routes (outside gatewayRoutes — no auth middleware) ──────
  // Registered in a separate Fastify scope so both user-auth and machine-token
  // middleware (which live only inside gatewayRoutes) are bypassed automatically.
  // Delivery auth is handled by the webhook router itself (secret / hmac / custom).
  if (webhookManifests?.length && webhookHistoryStore) {
    const webhookBaseUrl =
      resolvePublicUrl(config.port);
    await app.register(async (webhookScope) => {
      await registerWebhookRoutes(webhookScope, {
        cache,
        broker: platform.resourceBroker,
        logger,
        manifests: webhookManifests,
        baseUrl: webhookBaseUrl,
        historyStore: webhookHistoryStore,
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
