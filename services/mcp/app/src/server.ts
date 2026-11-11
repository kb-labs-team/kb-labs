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
 *  - The gateway resolves the bearer token, current user/session state, tenant,
 *    and permissions before proxying. It forwards AuthContext over the internal
 *    secret channel; the runtime verifies that channel and consumes that context.
 *  - Anonymous callers are rejected in secured mode before tool dispatch.
 *  - tenantId flows end-to-end from AuthContext.namespaceId into executeCommandV3
 *    via the resolvePlatform seam — ready for per-tenant isolation without code
 *    changes here.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { can, type Policy, type Identity } from '@kb-labs/core-policy';
import { PlatformAuditStore, isErrorCode, type ICache, type ILogger, type IServiceTransport } from '@kb-labs/core-platform';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { IEntityRegistry, ServiceManifest } from '@kb-labs/plugin-contracts';
import { createDaemonServer, getListenOptions, type ObservabilityCollectorLike } from '@kb-labs/shared-http';
import { readForwardedIdentity } from '@kb-labs/gateway-contracts';
import { toIdentity, actionForOperation, type Permits } from './mcp/authz.js';
import { buildServiceTools, validateManifests, type McpServiceTool } from './mcp/tool-builder.js';
import { callServiceTool } from './mcp/service-tool-router.js';
import { type PlatformResolver } from './mcp/tool-router.js';
import { resolveVisibleTools, executeToolCall, invalidMcpToolArguments, mcpToolError, mcpToolSuccess, unexpectedMcpResult, validateToolArguments } from './mcp/request-handler.js';
import { McpObservabilityCollector } from './observability/collector.js';
import type { ToolBuildDiagnostic } from './mcp/tool-builder.js';
import { isMcpCorsPreflight, mcpCorsPreflightResponse, mcpUnauthenticatedResponse, rejectsUnauthenticatedRequest, type McpAuthMode } from './mcp/auth-mode.js';

/** Built-in diagnostic tool: always visible to authenticated callers, never
 * derived from a plugin manifest — reports which plugin commands failed to
 * load as MCP tools so a caller can self-diagnose without SSHing into the box. */
const DIAGNOSTICS_TOOL = {
  name: 'kb-labs__mcp_diagnostics',
  description:
    'List plugin commands that failed to load as MCP tools (malformed manifests), with the reason for each.',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
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
  catalog: IEntityRegistry;
  /** Default global platform container — used as the resolvePlatform fallback. */
  platform: PlatformContainer;
  /** Tenant → platform container seam. Defaults to always returning `platform`. */
  resolvePlatform?: PlatformResolver;
  /** Workspace root used to initialize the entity registry. */
  projectRoot: string;
  /** Platform installation root (installed mode); merges platform-level plugins. */
  platformRoot?: string;
  /** Authorization policy. Permit-all default until the platform supplies a real one. */
  policy: Policy;
  /** Project runtime exposes MCP at its project-scoped root path. */
  endpointPath?: string;
  /** Local gateway mode has no login; secured mode requires a valid gateway token. */
  authMode?: McpAuthMode;
  /** Public Gateway URL included in catalogued authentication hints when known. */
  gatewayUrl?: string;
  serviceManifests?: readonly ServiceManifest[];
  serviceTransport?: IServiceTransport;
}

export class McpDaemonServer {
  private readonly opts: McpDaemonServerOptions;
  private readonly resolvePlatform: PlatformResolver;
  private readonly collector: McpObservabilityCollector;
  private readonly audit: PlatformAuditStore;
  private app: FastifyInstance | undefined;
  private registry: IEntityRegistry | undefined;
  private serviceTools: McpServiceTool[] = [];

  constructor(opts: McpDaemonServerOptions) {
    this.opts = opts;
    this.resolvePlatform = opts.resolvePlatform ?? (() => opts.platform);
    this.collector = new McpObservabilityCollector();
    this.audit = new PlatformAuditStore(opts.platform.documentDatabase);
  }

  /** Build a per-request permits predicate bound to the identity (PDP seam). */
  private permitsFor(identity: Identity): Permits {
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
    this.registry = this.opts.catalog;
    this.serviceTools = buildServiceTools(this.opts.serviceManifests ?? []);

    // Structural manifest validation runs ONCE here, independent of any
    // identity's permissions — so broken manifests are visible in logs and
    // via /observability/diagnostics from boot, not only once someone with
    // access to the offending plugin happens to call tools/list.
    const manifestDiagnostics = validateManifests(this.registry.snapshot());
    this.collector.setManifestDiagnostics(manifestDiagnostics);
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
    const { logger } = this.opts;
    const { cache } = this.opts;

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
    server.all(this.opts.endpointPath ?? '/api/v1/mcp', async (request, reply) => {
      const corsHeaders = mcpCorsPreflightResponse().headers;
      reply.headers(corsHeaders);

      if (isMcpCorsPreflight(request.method, request.headers)) {
        const preflight = mcpCorsPreflightResponse();
        return reply.code(preflight.statusCode).send();
      }

      const reqLogger = request.kbLogger ?? logger;

      // 1. Accept only the gateway-resolved identity on the authenticated
      // internal channel. Local mode permits tokenless requests; secured mode
      // rejects absent or invalid internal identity with HTTP 401.
      const authHeader = request.headers.authorization;
      const forwardedIdentity = readForwardedIdentity(request.headers, process.env.GATEWAY_INTERNAL_SECRET);
      const authCtx = forwardedIdentity.kind === 'identity' ? forwardedIdentity.auth : null;
      const securedTokenIdentity = (this.opts.authMode ?? 'secured') === 'local' || Boolean(authCtx?.tokenId);
      if (rejectsUnauthenticatedRequest(this.opts.authMode ?? 'secured', securedTokenIdentity)) {
        const unauthenticated = mcpUnauthenticatedResponse(
          this.opts.gatewayUrl ?? process.env.GATEWAY_PUBLIC_URL ?? process.env.KB_GATEWAY_URL ?? '<url>',
          authCtx ? 'unsupported-credential' : 'missing-identity',
        );
        return reply.code(unauthenticated.statusCode).send(unauthenticated.body);
      }

      // Non-preflight OPTIONS requests still pass through the secured gate.
      if (request.method === 'OPTIONS') {
        return reply.code(204).send();
      }
      const tenantId = authCtx?.namespaceId ?? 'anonymous';

      // Bind the authorization predicate to the identity once per request.
      // Local mode uses the local operator identity; secured requests use the
      // identity from the gateway token.
      const permits = authCtx
        ? this.permitsFor(toIdentity(authCtx))
        : this.opts.authMode === 'local'
          ? () => true
          : null;

      // 2. Resolve the visible tool list (cached per identity). The cache is a
      //    listing optimization ONLY — executeToolCall re-checks the live policy.
      const visibleTools = await resolveVisibleTools({
        permits,
        authHeader,
        cacheScope: this.opts.projectRoot,
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
          ...visibleTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as { type: 'object' },
          })),
          ...this.serviceTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: 'object' } })),
          // Authenticated callers only — mirrors the visibility gate above.
          ...(permits ? [DIAGNOSTICS_TOOL] : []),
        ],
      }));

      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        let result: CallToolResult;
        try {
          if (params.name === DIAGNOSTICS_TOOL.name) {
            if (!permits) {
              result = mcpToolError({ code: 'KB_AUTH_REQUIRED', details: {
                gatewayUrl: this.opts.gatewayUrl ?? process.env.GATEWAY_PUBLIC_URL ?? process.env.KB_GATEWAY_URL ?? '<url>',
              } });
            } else {
              const validationError = validateToolArguments(
                DIAGNOSTICS_TOOL.inputSchema,
                (params.arguments ?? {}) as Record<string, unknown>,
              );
              result = validationError
                ? invalidMcpToolArguments(validationError)
                : mcpToolSuccess(renderManifestDiagnostics(this.collector.getManifestDiagnostics()));
            }
          } else {
            const serviceTool = this.serviceTools.find((tool) => tool.name === params.name);
            if (serviceTool) {
              if (!permits) {
                result = mcpToolError({ code: 'KB_AUTH_REQUIRED', details: {
                  gatewayUrl: this.opts.gatewayUrl ?? process.env.GATEWAY_PUBLIC_URL ?? process.env.KB_GATEWAY_URL ?? '<url>',
                } });
              } else if (!permits('execute', serviceTool.serviceId)) {
                result = mcpToolError({ code: 'KB_AUTH_FORBIDDEN', details: { permission: 'execute' } });
              } else if (!this.opts.serviceTransport) {
                result = unexpectedMcpResult(new Error(`Service transport is unavailable for ${serviceTool.serviceId}.`), reqLogger);
              } else {
                const args = (params.arguments ?? {}) as Record<string, unknown>;
                const validationError = validateToolArguments(serviceTool.inputSchema, args);
                if (validationError) {
                  result = invalidMcpToolArguments(validationError);
                } else {
                  result = await callServiceTool(serviceTool, args, this.opts.serviceTransport, reqLogger);
                }
              }
            } else {result = await executeToolCall({
              name: params.name,
              args: (params.arguments ?? {}) as Record<string, unknown>,
              visibleTools,
              permits,
              tenantId,
              resolvePlatform: this.resolvePlatform,
              analytics: this.opts.platform.analytics,
              collector: this.collector,
              logger: reqLogger,
              gatewayUrl: this.opts.gatewayUrl ?? process.env.GATEWAY_PUBLIC_URL ?? process.env.KB_GATEWAY_URL,
            });}
          }
        } catch (error) {
          result = unexpectedMcpResult(error, reqLogger);
        }

        const errorContent = result.structuredContent?.error;
        const errorCode = typeof errorContent === 'object' && errorContent !== null
          && 'code' in errorContent && typeof errorContent.code === 'string' && isErrorCode(errorContent.code)
          ? errorContent.code
          : undefined;
        const correlationId = typeof errorContent === 'object' && errorContent !== null
          && 'correlationId' in errorContent && typeof errorContent.correlationId === 'string'
          ? errorContent.correlationId
          : randomUUID();

        try {
          await this.audit.record({
            kind: 'mcp.tool.call',
            actorUserId: authCtx?.userId ?? null,
            tokenId: authCtx?.tokenId ?? null,
            tenantId,
            project: this.opts.projectRoot,
            tool: params.name,
            outcome: result.isError ? errorCode ?? 'KB_RUNTIME_UNEXPECTED' : 'success',
            correlationId,
          });
        } catch (error) {
          return unexpectedMcpResult(error, reqLogger);
        }
        return result;
      });

      // 4. Streamable HTTP transport (stateless). Pass Fastify's parsed body —
      //    the raw stream is already consumed, so the SDK must not re-read it.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        const failure = unexpectedMcpResult(error, reqLogger);
        if (!reply.raw.headersSent) {
          reply.code(500).send(failure.structuredContent);
        }
      } finally {
        // Closing may reject if the transport is already torn down — swallow it
        // so it can never surface as an unhandled rejection after the response.
        await mcp.close().catch(() => {});
      }
    });
  }
}
