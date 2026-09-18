import { z } from 'zod';

export const UpstreamConfigSchema = z.object({
  /** Key into the transport services map — identifies which service to proxy to */
  serviceId: z.string().min(1),
  prefix: z.string().startsWith('/'),
  /** Strip prefix before forwarding. Default: keep prefix as-is. Use "" to strip. */
  rewritePrefix: z.string().optional(),
  /** Enable WebSocket proxying for this upstream. Default: false. */
  websocket: z.boolean().optional(),
  /** Paths under this prefix that are NOT proxied (handled by gateway itself). */
  excludePaths: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const StaticTokenEntrySchema = z.object({
  hostId: z.string(),
  namespaceId: z.string(),
});

// ── Pressure control (HTTP rate limiting via core ResourceBroker) ───────────
// See ADR-0056. Two layers: per-service (in onRequest, before auth) and
// per-tenant (in preHandler, after auth). Limit-only resources are registered
// at gateway boot via broker.registerLimit and queried via broker.tryAcquire.

export const RateLimitConfigSchema = z.object({
  tokensPerMinute: z.number().int().positive().optional(),
  requestsPerMinute: z.number().int().positive().optional(),
  requestsPerSecond: z.number().int().positive().optional(),
  maxConcurrentRequests: z.number().int().positive().optional(),
  /** 0..1, default 0.9 in core. Set to 1 to disable the safety cushion. */
  safetyMargin: z.number().min(0).max(1).optional(),
});

export const PressureRouteOverrideSchema = z.object({
  /** Resource id used in the broker, e.g. "gateway:route:webhooks-github". */
  resource: z.string().min(1),
  /** Path prefix matched against request.url (first match wins). */
  pathPrefix: z.string().startsWith('/'),
  /** HTTP methods this override applies to. Omit to match any method. */
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).optional(),
  limits: RateLimitConfigSchema,
});

export const PressureTenantConfigSchema = z.object({
  /** When true, applies per-tenant limits keyed by AuthContext.namespaceId. */
  enabled: z.boolean().default(false),
  /** Limits applied to each tenant. Resource id = "gateway:tenant:<namespaceId>". */
  limits: RateLimitConfigSchema,
});

export const PressureConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Per-upstream limits. Resource id = "gateway:service:<name>". */
  perService: z.record(z.string(), RateLimitConfigSchema).default({}),
  /** Per-path-prefix overrides (checked before service-level resolution). */
  perRoute: z.array(PressureRouteOverrideSchema).default([]),
  /** Optional per-tenant layer (requires JWT). */
  perTenant: PressureTenantConfigSchema.optional(),
});

// ── Auth config (ADR-0020) ─────────────────────────────────────────────────

const AuthPasswordPolicySchema = z.object({
  minLength: z.number().int().min(1).default(8),
  maxLength: z.number().int().min(1).default(256),
  /** When true, new passwords are checked against the HaveIBeenPwned API. */
  hibpEnabled: z.boolean().default(true),
});

const AuthRateLimitSchema = z.object({
  /** Max failed login attempts per IP per minute before 429. */
  loginPerIpPerMinute: z.number().int().positive().default(10),
  /** Max failed login attempts for a single email per minute (across all IPs). */
  loginPerEmailPerMinute: z.number().int().positive().default(5),
  /** Max activation attempts per IP per hour. */
  activatePerIpPerHour: z.number().int().positive().default(20),
});

const AuthBootstrapSchema = z.object({
  /**
   * Tenant ID for the bootstrap admin account (used in subdomain routing).
   * Optional: when omitted the gateway falls back to GATEWAY_BOOTSTRAP_TENANT_ID
   * and then `kblabs-cloud`. Config wins over the env, so an installer must NOT
   * write a default here — it would silently shadow the operator's env.
   */
  tenantId: z.string().min(1).optional(),
  /** Admin email — also readable from env GATEWAY_BOOTSTRAP_ADMIN_EMAIL. */
  adminEmail: z.string().email().optional(),
  /**
   * When true, the gateway mints a bootstrap CLI machine credential on first
   * start and writes it to ~/.kb/credentials.json (kb-create --yes flow, #271).
   */
  provisionCliCredentials: z.boolean().optional(),
}).optional();

/**
 * High-level "Studio access" choice, written by the installer (`kb-create`).
 * `local`  — solo machine: no login, and the gateway binds loopback by default.
 * `secured` — login required (same as omitting it).
 * An explicit `auth.enabled` and `host` always win over what this implies.
 */
export const AccessConfigSchema = z.object({
  mode: z.enum(['local', 'secured']),
});

export const AuthConfigSchema = z.object({
  /**
   * Whether authentication is enforced. When false (solo/local mode) the
   * gateway runs every request as a local admin and Studio opens without
   * login. The startup guardrail refuses to start with auth disabled on a
   * non-loopback bind (B-023).
   *
   * Deliberately NOT defaulted here: when omitted it is derived from
   * `gateway.access.mode` (and is enabled when that is absent too — cloud/team).
   * A schema default would make every config that merely mentions `auth`
   * (e.g. just `auth.bootstrap`) look like an explicit `enabled: true` and
   * silently override `access.mode: "local"`.
   */
  enabled: z.boolean().optional(),
  /** Whether to set Secure flag on session cookies. Set false in dev only. */
  cookieSecure: z.boolean().default(true),
  /** Access token TTL in seconds. Default 15 min. */
  sessionAccessTtlSec: z.number().int().positive().default(900),
  /** Refresh token TTL in seconds. Default 30 days. */
  sessionRefreshTtlSec: z.number().int().positive().default(30 * 24 * 3600),
  /** Grace window for refresh token reuse detection (CD-5). */
  refreshGraceWindowSec: z.number().int().nonnegative().default(5),
  /** bcrypt cost factor for password hashing. */
  bcryptCost: z.number().int().min(4).max(31).default(12),
  passwordPolicy: AuthPasswordPolicySchema.default({}),
  rateLimit: AuthRateLimitSchema.default({}),
  /** Invite link TTL in milliseconds. Default 7 days. */
  inviteTtlMs: z.number().int().positive().default(7 * 24 * 60 * 60 * 1000),
  /** Bootstrap admin account seeding. Credentials come from env vars. */
  bootstrap: AuthBootstrapSchema,
  /**
   * Identity providers to load, keyed by instance id (ADR-0020 DD-4).
   *
   * Each entry carries a discriminating `type` (built-in `email-password`
   * / `oidc`, or a package name for third-party providers). Everything
   * else passes through so each provider validates its own slice with its
   * own zod schema. Omitting `providers` registers the built-in
   * `email-password` provider as the default (DD-3).
   */
  providers: z
    .record(z.string(), z.object({ type: z.string().min(1) }).passthrough())
    .optional(),
});

export const TenantsConfigSchema = z.object({
  /**
   * Subdomain pattern used to resolve tenant from the Host header.
   * Use `{tenant}` as placeholder. E.g. `"{tenant}.kblabs.ru"`.
   */
  pattern: z.string().default('{tenant}.kblabs.ru'),
});

export const GatewayConfigSchema = z.object({
  port: z.number().default(4000),
  /**
   * Bind host. Defaults to '0.0.0.0' (deployed platform) when omitted — the
   * fallback is applied in code. Solo/local installs set '127.0.0.1' so a
   * no-auth Studio is never reachable off the machine.
   */
  host: z.string().optional(),
  upstreams: z.record(z.string(), UpstreamConfigSchema).default({}),
  /** Static tokens seeded into ICache at bootstrap — for dev/service tokens before full auth */
  staticTokens: z.record(z.string(), StaticTokenEntrySchema).default({}),
  /** HTTP pressure control (rate limiting via ResourceBroker). */
  pressure: PressureConfigSchema.optional(),
  /** Installer-facing access mode; see AccessConfigSchema. */
  access: AccessConfigSchema.optional(),
  /** User auth configuration (ADR-0020). */
  auth: AuthConfigSchema.optional(),
  /** Tenant routing configuration. */
  tenants: TenantsConfigSchema.optional(),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type PressureRouteOverride = z.infer<typeof PressureRouteOverrideSchema>;
export type PressureTenantConfig = z.infer<typeof PressureTenantConfigSchema>;
export type PressureConfig = z.infer<typeof PressureConfigSchema>;
export type UpstreamConfig = z.infer<typeof UpstreamConfigSchema>;
export type AccessConfig = z.infer<typeof AccessConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type TenantsConfig = z.infer<typeof TenantsConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
