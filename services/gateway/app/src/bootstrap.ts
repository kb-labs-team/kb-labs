import {
  logDiagnosticEvent,
  type IServiceTransport,
} from "@kb-labs/core-platform";
import {
  createInMemoryDocumentDatabase,
  createInMemoryKVStore,
} from "@kb-labs/core-platform/inmemory";
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import type { IHostStore, AuthConfig } from "@kb-labs/gateway-contracts";
import type { IContextLogger } from "@kb-labs/core-platform";
import type { IDocumentDatabase } from "@kb-labs/core-platform/adapters";
import { HostStore } from "@kb-labs/gateway-core";
import {
  UsersStore,
  CredentialsStore,
  MembershipsStore,
  SessionsStore,
  InvitesStore,
  loadIdentityProviders,
  createPasswordPolicy,
  createUserAuthService,
  createStubPDP,
  createTenantResolver,
  createRateLimiter,
  ensureBootstrapAdmin,
  evaluateAuthReadiness,
  type AuthReadiness,
  type BootstrapStatus,
  ensureBootstrapCliCredentials,
  AuthService,
  OAuthStateStore,
} from "@kb-labs/gateway-auth";
import type { IKVStore } from "@kb-labs/core-platform/adapters";
import { createRegistry } from "@kb-labs/core-registry";
import { loadGatewayConfig } from "./config.js";
import { resolveAccess, resolveBootstrapTenantId } from "./access.js";
import { createServer, type UserAuthServerDeps } from "./server.js";
import { HostRegistry } from "./hosts/registry.js";
import { registerPressureLimits } from "./pressure/index.js";
import type { WebhookManifestEntry } from "./webhook/router.js";

export async function bootstrap(
  repoRoot: string = process.cwd(),
): Promise<void> {
  await runService({
    appId: "gateway",
    startDir: repoRoot,
    defaultPort: 4000,
    portEnvVar: "GATEWAY_PORT",
    defaultHost: "0.0.0.0",
    hostEnvVar: "GATEWAY_HOST",
    platform: {
      assemblyHook: makeAssemblyHook(),
    },
    setup,
  });
}

/**
 * Gateway service body. Importable and side-effect-free: it only starts work
 * when called with a resolved {@link ServiceContext}. The listen port comes
 * from `ctx.port` (transport address or env + KB_NET_OFFSET, resolved once by
 * the launcher); the gateway never reads KB_NET_OFFSET itself.
 */
export async function setup({
  platform,
  projectRoot,
  platformRoot,
  port: listenPort,
  logger: serviceLogger,
}: ServiceContext): Promise<() => Promise<void>> {
  const logger = serviceLogger
    .forComponent("gateway-bootstrap")
    .forOperation("gateway.bootstrap");
  logger.info("Platform initialized", { projectRoot, platformRoot });

  // 2. Load gateway config — reads platform baseline + project layer +
  // `.kb/overlays/*.jsonc`. Use the resolved roots from core-runtime
  // (which honour KB_PROJECT_ROOT and the platform.dir override) rather
  // than process.cwd() — in installed mode the gateway process is
  // spawned with cwd at the platform root, and we MUST not conflate
  // that with the project root.
  const config = await loadGatewayConfig(projectRoot, platformRoot);
  const access = resolveAccess(config);
  logger.info("Gateway config loaded", {
    port: listenPort,
    upstreams: Object.keys(config.upstreams),
    projectRoot,
    platformRoot,
    configProviderIds: config.auth?.providers
      ? Object.keys(config.auth.providers)
      : [],
  });

  // 3. Create persistent host store backed by the platform document database.
  // Falls back to an in-memory implementation so user auth works without a
  // configured adapter (dev / CI environments with no external DB).
  // The same code runs on sqlite locally and on postgres/mongo in prod — the
  // gateway has no business knowing which driver is wired underneath.
  let hostStore: IHostStore | undefined;
  const configuredDocs =
    platform.getAdapter<IDocumentDatabase>("documentDatabase");
  const docs: IDocumentDatabase =
    configuredDocs ?? createInMemoryDocumentDatabase();
  if (configuredDocs) {
    hostStore = new HostStore(docs);
    logger.info("Host store: documentDatabase-backed (persistent)");
  } else {
    hostStore = new HostStore(docs);
    logger.warn("documentDatabase: in-memory fallback (data lost on restart)");
    logger.warn("Host store: in-memory (hosts will be lost on restart)");
  }

  // 3b. User auth infrastructure (ADR-0020). Always available — uses in-memory
  //     documentDatabase when no persistent adapter is configured.
  let userAuth: UserAuthServerDeps | undefined;
  {
    const {
      accessTtlSec,
      refreshTtlSec,
      graceWindowMs,
      bcryptCost,
      cookieSecure,
    } = resolveAuthRuntimeConfig(config.auth, process.env);
    const tenantPattern = config.tenants?.pattern ?? "{tenant}.kblabs.ru";
    const bootstrapTenantId = resolveBootstrapTenantId(config, process.env);

    const users = new UsersStore(docs);
    const credentials = new CredentialsStore(docs);
    const memberships = new MembershipsStore(docs);
    const sessions = new SessionsStore(docs, {
      refreshTtlMs: refreshTtlSec * 1000,
      graceWindowMs,
    });
    const invites = new InvitesStore(docs);

    // Identity providers are loaded from config (ADR-0020, DD-3). An
    // empty/absent `auth.providers` registers the built-in email-password
    // door; configured providers (built-in `oidc` or third-party packages)
    // load through the same factory path. Fail-fast on any load error.
    const providers = await loadIdentityProviders(config.auth?.providers, {
      users,
      credentials,
      tenantId: bootstrapTenantId,
      bcryptCost,
      logger,
    });

    const passwordPolicy = createPasswordPolicy({
      minLength: config.auth?.passwordPolicy?.minLength ?? 8,
      maxLength: config.auth?.passwordPolicy?.maxLength ?? 256,
      hibpEnabled: config.auth?.passwordPolicy?.hibpEnabled ?? true,
    });

    const pdp = createStubPDP({ memberships });

    const tenantResolver = createTenantResolver({ pattern: tenantPattern });

    const userAuthService = createUserAuthService({
      users,
      credentials,
      memberships,
      sessions,
      invites,
      providers,
      passwordPolicy,
      jwtConfig: {
        secret:
          process.env.GATEWAY_JWT_SECRET ?? "dev-insecure-secret-change-me",
      },
      accessTtlSec,
      refreshTtlSec,
      bcryptCost,
    });

    // Seed bootstrap admin account (step 1.14). Idempotent.
    const adminEmail =
      config.auth?.bootstrap?.adminEmail ??
      process.env.GATEWAY_BOOTSTRAP_ADMIN_EMAIL;
    const adminPassword = process.env.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD;
    const bootstrapStatus: BootstrapStatus = await ensureBootstrapAdmin({
      bootstrap:
        adminEmail && adminPassword
          ? { adminEmail, adminPassword, tenantId: bootstrapTenantId }
          : undefined,
      users,
      credentials,
      memberships,
      bcryptCost,
      logger,
    }).catch((err): BootstrapStatus => {
      logger.error(
        "Bootstrap admin seed failed (non-fatal)",
        err instanceof Error ? err : new Error(String(err)),
        { tenantId: bootstrapTenantId },
      );
      return "failed";
    });

    // AUTH_INVITE_TTL_MS env var overrides config (used in E2E to test short-lived invites).
    const inviteTtlMs = process.env.AUTH_INVITE_TTL_MS
      ? parseInt(process.env.AUTH_INVITE_TTL_MS, 10)
      : (config.auth?.inviteTtlMs ?? 7 * 24 * 60 * 60 * 1000);

    // Rate limiter — uses kvStore if available; falls back to in-memory.
    // In-memory is sufficient for single-process deployments (E2E, dev) and
    // ensures rate limiting is always active. Production deployments with a
    // persistent kvStore get cross-restart counters automatically.
    const kv =
      platform.getAdapter<IKVStore>("kvStore") ?? createInMemoryKVStore();
    const rateLimiter = createRateLimiter(kv);
    if (!platform.getAdapter<IKVStore>("kvStore")) {
      logger.warn(
        "kvStore adapter not configured — auth rate limiting using in-memory KV (counters reset on restart)",
      );
    }

    // AUTH_LOGIN_RATE_LIMIT_PER_IP / AUTH_LOGIN_RATE_LIMIT_PER_EMAIL env vars override
    // config (used in E2E where many specs call /auth/login from the same IP in rapid
    // succession — the production defaults of 10/m and 5/m would trigger false 429s).
    const loginPerIpPerMinute = process.env.AUTH_LOGIN_RATE_LIMIT_PER_IP
      ? parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_PER_IP, 10)
      : (config.auth?.rateLimit?.loginPerIpPerMinute ?? 10);
    const loginPerEmailPerMinute = process.env.AUTH_LOGIN_RATE_LIMIT_PER_EMAIL
      ? parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_PER_EMAIL, 10)
      : (config.auth?.rateLimit?.loginPerEmailPerMinute ?? 5);

    // OAuth state store (ADR-0020, DD-5). Shares the same KV as the rate
    // limiter via a namespaced key prefix. The redirect/OAuth routes register
    // only when this is present.
    const oauthState = new OAuthStateStore(kv);

    // Step 4b shared-KV requirement: in a multi-process / HA deployment the
    // callback may land on a different worker than the one that minted the
    // state, so an in-memory KV silently breaks OAuth. Warn when a redirect
    // provider is configured against a non-shared KV.
    const hasRedirectProvider = providers
      .list()
      .some((p) => p.kind === "redirect");
    if (hasRedirectProvider && !platform.getAdapter<IKVStore>("kvStore")) {
      logger.warn(
        "OAuth requires a shared kvStore (Redis) in multi-process/HA; in-memory state is per-process and callbacks may land on a different worker",
      );
    }

    const authReadiness = () =>
      evaluateAuthReadiness({
        authEnabled: access.authEnabled,
        loopbackOnly: isLoopbackHost(access.bindHost),
        tenantId: bootstrapTenantId,
        jwtSecretIsDefault: !process.env.GATEWAY_JWT_SECRET,
        bootstrap: { status: bootstrapStatus, email: adminEmail },
        users,
        memberships,
      });
    await logAuthReadiness(authReadiness, logger);

    userAuth = {
      userAuthService,
      users,
      sessions,
      invites,
      providers,
      pdp,
      tenantResolver,
      bootstrapTenantId,
      cookieSecure,
      accessTtlSec,
      refreshTtlSec,
      inviteTtlMs,
      rateLimiter,
      authRateLimit: { loginPerIpPerMinute, loginPerEmailPerMinute },
      oauthState,
      authReadiness,
    };

    logger.info("User auth infrastructure initialised", {
      tenantPattern,
      bootstrapTenantId,
      cookieSecure,
      persistent: !!configuredDocs,
    });
  }

  // 4. Create host registry with cache + store
  // Capture once so registry and server share the exact same cache instance.
  const cache = platform.cache;
  const registry = new HostRegistry(cache, hostStore);

  // 5. Restore persisted hosts into cache (best-effort — cache may be unavailable on cold start)
  let restoredCount = 0;
  try {
    restoredCount = await registry.restore();
  } catch (error) {
    logDiagnosticEvent(platform.logger, {
      domain: "registry",
      event: "gateway.hosts.restore",
      level: "error",
      reasonCode: "registry_restore_failed",
      message: "Failed to restore gateway host registry",
      outcome: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
      serviceId: "gateway",
      evidence: {
        persistentStore: !!hostStore,
      },
    });
    // Non-fatal: gateway can start without restored state; hosts will re-register on reconnect
  }
  if (restoredCount > 0) {
    logger.info("Restored hosts from store", { count: restoredCount });
  }

  // 5b. Discover plugin manifests for webhook route registration.
  //     Uses snapshot().manifests — PluginBrief from listPlugins() lacks manifest/pluginRoot.
  //     Graceful: failure disables webhook routes but does not block gateway startup.
  let webhookManifests: WebhookManifestEntry[] = [];
  try {
    const pluginRegistry = await createRegistry({
      root: projectRoot,
      platformRoot: platformRoot !== projectRoot ? platformRoot : undefined,
      cache: { ttlMs: 600_000, adapter: cache },
    });
    const snapshot = pluginRegistry.snapshot();
    webhookManifests = snapshot.manifests
      .filter((entry) => (entry.manifest.webhooks?.handlers?.length ?? 0) > 0)
      .map((entry) => ({
        pluginId: entry.pluginId,
        manifest: entry.manifest,
        pluginRoot: entry.pluginRoot,
      }));
    if (webhookManifests.length > 0) {
      logger.info("Webhook manifests discovered", {
        count: webhookManifests.length,
      });
    }
  } catch (err) {
    logger.warn("Webhook manifest discovery failed — webhook routes disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    webhookManifests = [];
  }

  // 6. Build JWT config — secret required; no fallback in production.
  const DEV_JWT_SECRET = "dev-insecure-secret-change-me";
  const jwtSecret = process.env.GATEWAY_JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";
  if (!jwtSecret && isProduction) {
    throw new Error(
      "GATEWAY_JWT_SECRET must be set in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"",
    );
  }
  if (!jwtSecret) {
    logger.warn(
      "GATEWAY_JWT_SECRET not set — using insecure default (dev only, never use in production!)",
    );
  }
  const jwtConfig = { secret: jwtSecret ?? DEV_JWT_SECRET };

  // 7. Auto-provision the CLI's first credential for non-local installs (#271).
  // Opt-in via config.auth.bootstrap.provisionCliCredentials (set by kb-create
  // for --yes/server-mode installs). Mints a fixed-handle machine service
  // account in-process (no HTTP round-trip, so MACHINE_REGISTER never applies)
  // and writes ~/.kb/credentials.json so `kb` commands work with zero manual
  // `kb auth login`. Idempotent — see ensureBootstrapCliCredentials.
  if (config.auth?.bootstrap?.provisionCliCredentials === true) {
    const bootstrapAuthService = new AuthService(cache, jwtConfig);
    await ensureBootstrapCliCredentials({
      enabled: true,
      authService: bootstrapAuthService,
      gatewayUrl: `http://127.0.0.1:${listenPort}`,
      logger,
    }).catch((err: unknown) => {
      logger.warn("Bootstrap CLI credentials provisioning failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // 8. Register HTTP pressure-control limits (ADR-0056). No-op when
  //    `gateway.pressure` is absent or disabled in config.
  if (platform.hasResourceBroker) {
    registerPressureLimits(
      platform.resourceBroker,
      config.pressure,
      platform.logger,
    );
  } else {
    logger.warn("Resource broker unavailable — pressure control disabled");
  }

  // 9. Get service transport from platform adapter.
  //    Configured via platform.adapters.serviceTransport in kb.config.json.
  //    kb-create installs @kb-labs/adapters-service-transport-http by default
  //    and writes adapterOptions.serviceTransport.services with TCP URLs.
  const serviceTransport =
    platform.getAdapter<IServiceTransport>("serviceTransport");
  if (!serviceTransport) {
    throw new Error(
      "Gateway requires the serviceTransport adapter. " +
        "Configure it in kb.config.json:\n" +
        '  "adapters": { "serviceTransport": "@kb-labs/adapters-service-transport-http" },\n' +
        '  "adapterOptions": { "serviceTransport": { "services": { "rest": { "url": "http://127.0.0.1:5050" }, ... } } }',
    );
  }

  // 10. Create server with injected registry, transport and optional user auth deps
  const server = await createServer(
    { ...config, port: listenPort },
    cache,
    platform.logger,
    jwtConfig,
    registry,
    serviceTransport,
    userAuth,
    webhookManifests,
  );

  // 11. Listen
  const { authEnabled, bindHost } = access;

  // Safety guardrail (B-023): a platform with auth disabled must never be
  // reachable off the local machine. If auth is off, the bind host MUST be a
  // loopback address — otherwise refuse to start with a clear, actionable error.
  if (!authEnabled && !isLoopbackHost(bindHost)) {
    throw new Error(
      `Refusing to start: auth is disabled but the gateway binds to "${bindHost}" ` +
        `(not loopback). A no-auth platform reachable on the network grants full ` +
        `access to anyone. Either set gateway.auth.enabled = true, or bind to ` +
        `127.0.0.1 (gateway.host) for solo/local use.`,
    );
  }

  const address = await server.listen({ port: listenPort, host: bindHost });
  logger.info("Gateway listening", {
    address,
    authEnabled,
  });

  return async () => {
    await server.close();
    logger.info("Gateway service resources closed");
  };
}

/**
 * Resolves the user-auth runtime knobs (TTLs, cookie security, bcrypt cost,
 * refresh grace window) from config + environment.
 *
 * `config.auth` is optional in the raw JSON, but once the `auth` object is
 * present at all — which it now always is, since kb-create writes
 * gateway.auth.bootstrap on every non-local install — zod applies its own
 * schema defaults (sessionAccessTtlSec: 900, cookieSecure: true, etc.) to
 * every field, not just the ones actually set in the raw config. That means
 * `config.auth?.X ?? envFallback` NEVER reaches the env fallback once `auth`
 * exists at all, even for fields the user never explicitly configured.
 *
 * AUTH_ACCESS_TTL_SEC / AUTH_REFRESH_TTL_SEC / AUTH_COOKIE_SECURE are meant
 * to be a CI-only override "without touching the config file" (e.g.
 * AUTH_ACCESS_TTL_SEC=5 for session-lifecycle E2E tests, AUTH_COOKIE_SECURE=
 * false for HTTP-only CI environments) — so they must be checked BEFORE the
 * (possibly zod-defaulted) config value, not after.
 */
export function resolveAuthRuntimeConfig(
  authConfig: AuthConfig | undefined,
  env: NodeJS.ProcessEnv,
): {
  accessTtlSec: number;
  refreshTtlSec: number;
  graceWindowMs: number;
  bcryptCost: number;
  cookieSecure: boolean;
} {
  const accessTtlSec = env.AUTH_ACCESS_TTL_SEC
    ? parseInt(env.AUTH_ACCESS_TTL_SEC, 10)
    : (authConfig?.sessionAccessTtlSec ?? 900);
  const refreshTtlSec = env.AUTH_REFRESH_TTL_SEC
    ? parseInt(env.AUTH_REFRESH_TTL_SEC, 10)
    : (authConfig?.sessionRefreshTtlSec ?? 30 * 24 * 3600);
  const graceWindowMs = (authConfig?.refreshGraceWindowSec ?? 5) * 1000;
  const bcryptCost = authConfig?.bcryptCost ?? 12;
  // AUTH_COOKIE_SECURE=false disables Secure flag for HTTP-only CI environments.
  // In production (HTTPS) leave unset or set to true.
  const cookieSecure =
    env.AUTH_COOKIE_SECURE === "false"
      ? false
      : (authConfig?.cookieSecure ?? true);

  return {
    accessTtlSec,
    refreshTtlSec,
    graceWindowMs,
    bcryptCost,
    cookieSecure,
  };
}

/**
 * True when the bind host is a loopback address (only reachable from the local
 * machine). Used by the auth-disabled startup guardrail (B-023).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]" ||
    h.startsWith("127.")
  );
}

/**
 * Log auth readiness once at startup so a locked-out install (auth on, no
 * active admin) is visible in the logs, not just as identical 401s. Never
 * throws: diagnostics must not be able to stop the gateway from starting.
 */
export async function logAuthReadiness(
  evaluate: () => Promise<AuthReadiness>,
  logger: IContextLogger,
): Promise<void> {
  try {
    const readiness = await evaluate();
    for (const issue of readiness.issues) {
      const meta = { code: issue.code, hint: issue.hint };
      if (issue.severity === "error") {
        logger.error(`auth-readiness: ${issue.message}`, undefined, meta);
      } else {
        logger.warn(`auth-readiness: ${issue.message}`, meta);
      }
    }
    if (readiness.ok && readiness.issues.length === 0) {
      logger.info("auth-readiness: ok", {
        authEnabled: readiness.authEnabled,
        activeAdmins: readiness.activeAdmins,
      });
    }
  } catch (err) {
    logger.warn("auth-readiness: check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
