/**
 * MCP Daemon HTTP server.
 *
 * Exposes a single JSON-RPC endpoint (`/api/v1/mcp`) speaking the Model Context
 * Protocol over Streamable HTTP, plus the standard platform observability endpoints:
 *
 *   GET /health                 → McpObservabilityCollector.buildHealth()
 *   GET /ready                  → 200/503 based on registry readiness
 *   GET /metrics                → Prometheus text format
 *   GET /observability/describe → service identity + capabilities
 *   GET /observability/health   → full snapshot with checks and top operations
 *
 * Design notes:
 *  - The entity registry is initialized ONCE at start() and reused for every
 *    request; only the cheap, pure filterTools() runs per request.
 *  - This endpoint sits in front of the gateway's auth scope (the gateway proxies
 *    it as a dumb upstream), so the daemon validates the Bearer token itself via
 *    the shared GATEWAY_JWT_SECRET — exactly mirroring the gateway's AuthService.
 *  - Anonymous callers (no/invalid token) get an empty tool list and can never
 *    reach callTool/executeCommandV3.
 *  - tenantId flows end-to-end from AuthContext.namespaceId into executeCommandV3
 *    via the resolvePlatform seam — ready for per-tenant isolation without code
 *    changes here.
 */

import type { FastifyInstance } from 'fastify';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { can, type Policy, type Identity } from '@kb-labs/core-policy';
import type { ICache, ILogger } from '@kb-labs/core-platform';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { IEntityRegistry } from '@kb-labs/core-registry';
import type { AuthContext } from '@kb-labs/gateway-contracts';
import { createDaemonServer, getListenOptions, type ObservabilityCollectorLike } from '@kb-labs/shared-http';
import { extractBearer, resolveMcpCallerContext } from './mcp/auth.js';
import { toIdentity, actionForOperation, type Permits } from './mcp/authz.js';
import { createToolRegistry, filterTools, toMcpToolDescriptor, validateManifests } from './mcp/tool-builder.js';
import { type PlatformResolver } from './mcp/tool-router.js';
import { resolveVisibleTools, executeToolCall } from './mcp/request-handler.js';
import { issueAgentLease, revokeAgentLease, AgentLeaseError, type AgentLeaseInputConstraints, type AgentLeaseRecord } from './mcp/agent-leases.js';
import { McpObservabilityCollector } from './observability/collector.js';
import type { ToolBuildDiagnostic } from './mcp/tool-builder.js';

function createAuthorizedToolNameSet(
  registry: IEntityRegistry,
  permits: Permits,
  lease: AgentLeaseRecord | null,
): Set<string> {
  const parentTools = lease ? new Set(lease.allowedTools) : null;
  return new Set(
    filterTools(registry.snapshot(), (operationType, resource, toolName) =>
      permits(operationType, resource, toolName)
      && (!parentTools || parentTools.has(toolName ?? '')),
    ).map((tool) => tool.name),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Built-in diagnostic tool: always visible to authenticated callers, never
 * derived from a plugin manifest — reports which plugin commands failed to
 * load as MCP tools so a caller can self-diagnose without SSHing into the box. */
const DIAGNOSTICS_TOOL = {
  name: 'kb-labs__mcp_diagnostics',
  description:
    'List plugin commands that failed to load as MCP tools (malformed manifests), with the reason for each.',
  inputSchema: { type: 'object' as const, properties: {} },
};

const DEVELOPMENT_PDP_STUB_IDENTITY: AuthContext = {
  type: 'user', userId: 'local-development-pdp-stub', namespaceId: 'local-development',
  tier: 'pro', permissions: ['*'],
};

function renderManifestDiagnostics(diagnostics: ToolBuildDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return 'All plugin commands loaded cleanly — no manifest issues.';
  }
  return diagnostics.map((d) => `[${d.pluginId}] ${d.commandId}: ${d.error}`).join('\n');
}

export interface McpDaemonServerOptions {
  port: number;
  host: string;
  logger: ILogger;
  cache: ICache;
  /** Default global platform container — used as the resolvePlatform fallback. */
  platform: PlatformContainer;
  /** Tenant → platform container seam. Defaults to always returning `platform`. */
  resolvePlatform?: PlatformResolver;
  /** Workspace root used to initialize the entity registry. */
  projectRoot: string;
  /** Platform installation root (installed mode); merges platform-level plugins. */
  platformRoot?: string;
  jwtConfig: JwtConfig;
  /** Authorization policy. Permit-all default until the platform supplies a real one. */
  policy: Policy;
  /** Explicit local-only anonymous lease issuer; must never be enabled in production. */
  developmentPdpStub?: boolean;
}

export class McpDaemonServer {
  private readonly opts: McpDaemonServerOptions;
  private readonly resolvePlatform: PlatformResolver;
  private readonly collector: McpObservabilityCollector;
  private app: FastifyInstance | undefined;
  private registry: IEntityRegistry | undefined;

  constructor(opts: McpDaemonServerOptions) {
    this.opts = opts;
    this.resolvePlatform = opts.resolvePlatform ?? (() => opts.platform);
    this.collector = new McpObservabilityCollector();
  }

  /** Build a per-request permits predicate bound to the identity (PDP seam). */
  private permitsFor(identity: Identity): Permits {
    if (this.opts.developmentPdpStub && identity.user === DEVELOPMENT_PDP_STUB_IDENTITY.userId) {
      return () => true;
    }
    return (operationType, resource) =>
      can(this.opts.policy, identity, actionForOperation(operationType), resource);
  }

  private get toolCount(): number {
    return (
      this.registry
        ?.snapshot()
        .manifests.flatMap((m) => m.manifest.cli?.commands ?? []).length ?? 0
    );
  }

  async start(): Promise<string> {
    // Initialize the registry ONCE; snapshot() is reused per request.
    this.registry = await createToolRegistry({
      root: this.opts.projectRoot,
      platformRoot: this.opts.platformRoot,
      cache: this.opts.cache,
    });

    // Structural manifest validation runs ONCE here, independent of any
    // identity's permissions — so broken manifests are visible in logs and
    // via /observability/diagnostics from boot, not only once someone with
    // access to the offending plugin happens to call tools/list.
    const manifestDiagnostics = validateManifests(this.registry.snapshot());
    this.collector.setManifestDiagnostics(manifestDiagnostics);
    if (this.opts.developmentPdpStub) {
      this.opts.logger.warn('MCP anonymous agent lease PDP stub is enabled; this mode grants all MCP commands and is for local testing only');
    }
    for (const diag of manifestDiagnostics) {
      this.opts.logger.warn('MCP tool skipped — invalid manifest command', {
        pluginId: diag.pluginId,
        commandId: diag.commandId,
        error: diag.error,
      });
    }

    const execMode = process.env.KB_MCP_EXECUTION_MODE ?? 'subprocess';

    // Adapter: wraps McpObservabilityCollector to match ObservabilityCollectorLike.
    // Arrow functions capture `this` so the live registry/toolCount state is always current.
    const observabilityAdapter: ObservabilityCollectorLike = {
      register: (server: FastifyInstance) => this.collector.register(server),
      buildDescribe: () => this.collector.buildDescribe(!!this.registry, this.toolCount),
      buildHealth: () => this.collector.buildHealth(!!this.registry, this.toolCount, execMode),
      renderPrometheusMetrics: (_status: string) => this.collector.renderPrometheusMetrics(this.toolCount),
    };

    this.app = await createDaemonServer({
      serviceId: 'mcp-daemon',
      logger: this.opts.logger,
      observability: observabilityAdapter,
      readyCheck: () => ({ ready: !!this.registry, service: 'mcp-daemon' }),
      registerRoutes: async (server) => this.registerMcpRoutes(server),
    });

    const listenOptions = getListenOptions(this.opts.port, this.opts.host);
    const address = await this.app.listen(listenOptions);

    this.opts.logger.info('MCP daemon listening', { address });
    return address;
  }

  async stop(): Promise<void> {
    await this.app?.close();
  }

  private async registerMcpRoutes(server: FastifyInstance): Promise<void> {
    const { cache, logger, jwtConfig } = this.opts;

    // ── Scoped agent leases ──────────────────────────────────────────────
    // A user (or parent lease) may delegate only a subset of currently
    // authorized commands. The returned opaque bearer is all the child needs.
    server.delete('/api/v1/mcp/leases/current', async (request, reply) => {
      const caller = await resolveMcpCallerContext(request.headers.authorization, cache, jwtConfig);
      if (!caller) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!caller.lease) {
        return reply.code(400).send({ error: 'only an agent lease can revoke itself' });
      }
      const token = extractBearer(request.headers.authorization);
      if (token) { await revokeAgentLease(cache, token); }
      return reply.code(204).send();
    });

    server.post('/api/v1/mcp/leases', async (request, reply) => {
      const caller = await resolveMcpCallerContext(request.headers.authorization, cache, jwtConfig);
      const stubIdentity = !caller && this.opts.developmentPdpStub
        ? DEVELOPMENT_PDP_STUB_IDENTITY
        : null;
      const identity = caller?.auth ?? stubIdentity;
      if (!identity) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!this.registry) {
        return reply.code(503).send({ error: 'MCP registry is not ready' });
      }

      const body = request.body as Record<string, unknown> | null;
      const executionId = body?.['executionId'];
      const allowedTools = body?.['allowedTools'];
      const allAuthorizedTools = body?.['allAuthorizedTools'] === true;
      const ttlSeconds = body?.['ttlSeconds'];
      const inputEquals = body?.['inputEquals'];
      if (typeof executionId !== 'string'
        || (body?.['allAuthorizedTools'] !== undefined && typeof body['allAuthorizedTools'] !== 'boolean')
        || (allAuthorizedTools
          ? (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.length > 0))
          : (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.some((item) => typeof item !== 'string')))) {
        return reply.code(400).send({ error: 'executionId and either allowedTools[] or allAuthorizedTools=true are required' });
      }
      if (ttlSeconds !== undefined && typeof ttlSeconds !== 'number') {
        return reply.code(400).send({ error: 'ttlSeconds must be a number' });
      }

      if (inputEquals !== undefined && (!isRecord(inputEquals)
        || Object.values(inputEquals).some((constraints) => !isRecord(constraints)))) {
        return reply.code(400).send({ error: 'inputEquals must be an object' });
      }
      const leaseParent = caller?.lease ?? null;
      const basePermits = this.permitsFor(toIdentity(identity));
      const authorizedTools = createAuthorizedToolNameSet(this.registry, basePermits, leaseParent);
      const requestedTools = allAuthorizedTools ? [...authorizedTools] : allowedTools as string[];
      if (requestedTools.length === 0) {
        return reply.code(403).send({ error: 'caller has no authorized MCP tools' });
      }
      const unavailable = requestedTools.filter((name) => !authorizedTools.has(name));
      if (unavailable.length > 0) {
        return reply.code(403).send({ error: 'requested tools exceed caller authority', unavailable });
      }

      try {
        const requestedConstraints = (inputEquals ?? {}) as AgentLeaseInputConstraints;
        const effectiveConstraints: AgentLeaseInputConstraints = { ...requestedConstraints };
        if (leaseParent) {
          for (const toolName of requestedTools) {
            const inherited = leaseParent.inputEquals[toolName];
            if (inherited) {
              effectiveConstraints[toolName] = {
                ...inherited,
                ...(effectiveConstraints[toolName] ?? {}),
              };
            }
          }
        }
        const issued = await issueAgentLease(cache, {
          executionId,
          identity,
          allowedTools: requestedTools,
          inputEquals: effectiveConstraints,
          ttlSeconds: ttlSeconds as number | undefined,
          parent: leaseParent ?? undefined,
        });
        return reply.code(201).send({
          tokenType: 'Bearer',
          accessToken: issued.token,
          executionId: issued.record.executionId,
          allowedTools: issued.record.allowedTools,
          expiresAt: new Date(issued.record.expiresAt).toISOString(),
        });
      } catch (error) {
        if (error instanceof AgentLeaseError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        request.kbLogger?.error('Agent lease creation failed', error as Error);
        return reply.code(500).send({ error: 'failed to create agent lease' });
      }
    });

    // ── Diagnostics ──────────────────────────────────────────────────────
    // Same visibility as /health — no per-tenant data, just which manifest
    // commands failed to load. Mirrors the kb-labs__mcp_diagnostics MCP tool.
    server.get('/observability/diagnostics', async () => ({
      diagnostics: this.collector.getManifestDiagnostics(),
    }));

    // ── MCP JSON-RPC endpoint ──────────────────────────────────────────────

    // CORS headers for all MCP responses (including preflight OPTIONS).
    // fastify.all() covers every method including OPTIONS, so no separate
    // fastify.options() is needed — that would cause a duplicate-route error.
    server.all('/api/v1/mcp', async (request, reply) => {
      reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');

      // Short-circuit preflight immediately — no auth or MCP processing needed.
      if (request.method === 'OPTIONS') {
        return reply.code(204).send();
      }

      const reqLogger = request.kbLogger ?? logger;

      // 1. Authenticate. Invalid/absent token → anonymous (no throw, no 401).
      const authHeader = request.headers.authorization;
      const caller = await resolveMcpCallerContext(authHeader, cache, jwtConfig).catch(
        () => null,
      );
      const authCtx = caller?.auth ?? null;
      const tenantId = authCtx?.namespaceId ?? 'anonymous';

      // Bind the authorization predicate to the identity once per request.
      // Anonymous callers get no predicate → they can neither list nor call tools.
      const permits = authCtx ? this.permitsFor(toIdentity(authCtx)) : null;

      // 2. Resolve the visible tool list (cached per identity). The cache is a
      //    listing optimization ONLY — executeToolCall re-checks the live policy.
      const visibleTools = await resolveVisibleTools({
        permits,
        lease: caller?.lease,
        authHeader,
        registry: this.registry!,
        cache,
        analytics: this.opts.platform.analytics,
        collector: this.collector,
        tenantId,
      });

      // 3. Build a stateless per-request MCP server.
      const mcp = new McpServer(
        { name: 'kb-labs', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );

      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...visibleTools.map(toMcpToolDescriptor),
          // Authenticated callers only — mirrors the visibility gate above.
          ...(permits && !caller?.lease ? [DIAGNOSTICS_TOOL] : []),
        ],
      }));

      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        if (params.name === DIAGNOSTICS_TOOL.name) {
          if (!permits || caller?.lease) {
            return { content: [{ type: 'text' as const, text: `Not authorized: ${params.name}` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: renderManifestDiagnostics(this.collector.getManifestDiagnostics()) }], isError: false };
        }
        return executeToolCall({
          name: params.name,
          args: (params.arguments ?? {}) as Record<string, unknown>,
          visibleTools,
          permits,
          lease: caller?.lease,
          tenantId,
          resolvePlatform: this.resolvePlatform,
          analytics: this.opts.platform.analytics,
          collector: this.collector,
        });
      });

      // 4. Streamable HTTP transport (stateless). Pass Fastify's parsed body —
      //    the raw stream is already consumed, so the SDK must not re-read it.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        reqLogger.error('MCP request handling failed', error as Error);
        if (!reply.raw.headersSent) {
          reply.code(500).send({ error: 'internal_error' });
        }
      } finally {
        // Closing may reject if the transport is already torn down — swallow it
        // so it can never surface as an unhandled rejection after the response.
        await mcp.close().catch(() => {});
      }
    });
  }
}
