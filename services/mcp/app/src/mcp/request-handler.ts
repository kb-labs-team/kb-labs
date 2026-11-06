/**
 * Request handler logic for the MCP endpoint, extracted from the Fastify/MCP-SDK
 * shell so every authorization and caching branch is unit-testable without
 * spinning up an HTTP server or a transport.
 *
 * server.ts wires these pure(ish) functions to the MCP SDK request handlers;
 * the SDK/transport plumbing itself is exercised by the e2e suite.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createCatalogErrorEnvelope, type CatalogErrorRequest, type ICache, type IAnalytics, type ILogger } from '@kb-labs/core-platform';
import type { ErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { createUxFailureResult, createUxSuccessResult } from '@kb-labs/core-platform/ux-result';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import { filterTools, type McpTool } from './tool-builder.js';
import { callTool, type PlatformResolver } from './tool-router.js';
import { actionForOperation, type Permits } from './authz.js';
import type { McpObservabilityCollector } from '../observability/collector.js';
import type { PlatformErrorCode } from '@kb-labs/core-platform/error-envelope';
import type { UIOutput } from '@kb-labs/plugin-contracts';

/** How long a per-identity tool listing stays cached. */
export const TOOLS_CACHE_TTL_MS = 60_000;

/** Build a successful MCP tool result with shared machine data and readable text. */
export function mcpToolSuccess(data: string, ui: UIOutput[] = []): CallToolResult {
  const machineResult = ui.length > 0
    ? createUxSuccessResult(data, { ui })
    : createUxSuccessResult(data);
  return {
    content: [{ type: 'text', text: data }],
    structuredContent: { ...machineResult },
    isError: false,
  };
}

function errorResult(envelope: ErrorEnvelope): CallToolResult {
  const correlation = envelope.correlationId ? ` (correlationId: ${envelope.correlationId})` : '';
  return {
    content: [{ type: 'text', text: `${envelope.code}: ${envelope.message} — ${envelope.hint}${correlation}` }],
    structuredContent: { ...createUxFailureResult(envelope) },
    isError: true,
  };
}

export function mcpToolError(request: CatalogErrorRequest): CallToolResult {
  return errorResult(createCatalogErrorEnvelope({ ...request, correlationId: randomUUID() }));
}

/** Convert an unexpected MCP boundary failure to one safe, correlated result. */
export function unexpectedMcpResult(error: unknown, logger: ILogger): CallToolResult {
  const correlationId = randomUUID();
  const stackError = error instanceof Error ? error : new Error(String(error));
  logger.error('Unexpected MCP request failure', stackError, { correlationId });
  return errorResult(createCatalogErrorEnvelope({ code: 'KB_RUNTIME_UNEXPECTED', correlationId }));
}

interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean;
}

function matchesSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'null': return value === null;
    default: return true;
  }
}

function argumentError(schema: JsonSchema, value: unknown, path = ''): { path: string; expected: string } | null {
  if (schema.type && !matchesSchemaType(value, schema.type)) {
    return { path: path || 'arguments', expected: schema.type };
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in objectValue)) {
        return { path: path ? `${path}.${required}` : required, expected: 'required' };
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) {
        const error = argumentError(propertySchema, objectValue[key], path ? `${path}.${key}` : key);
        if (error) {return error;}
      }
    }
    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(objectValue)) {
        if (!declared.has(key)) {
          return { path: path ? `${path}.${key}` : key, expected: 'not allowed' };
        }
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      const error = argumentError(schema.items, item, `${path}[${index}]`);
      if (error) {return error;}
    }
  }
  return null;
}

export function validateToolArguments(schema: object, args: Record<string, unknown>): { path: string; expected: string } | null {
  return argumentError(schema as JsonSchema, args);
}

export function invalidMcpToolArguments(error: { path: string; expected: string }): CallToolResult {
  const expected = error.expected === 'required' ? 'a required value' : error.expected;
  return mcpToolError({ code: 'KB_RUNTIME_MCP_INVALID_ARGUMENTS', details: { argument: error.path, expected } });
}

/**
 * Cache key for an identity's visible tool list. Authenticated identities are
 * keyed by project scope and a hash of their Authorization header; anonymous
 * callers share a bucket only within the same project scope.
 */
export function toolsCacheKey(
  authHeader: string | null | undefined,
  cacheScope = 'default',
): string {
  const scope = createHash('sha256').update(cacheScope).digest('hex').slice(0, 16);
  if (!authHeader) {
    return `mcp:tools:${scope}:anonymous`;
  }
  return `mcp:tools:${scope}:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
}

export interface ResolveVisibleToolsArgs {
  /** Identity-bound authorization predicate, or null for anonymous callers. */
  permits: Permits | null;
  /** Raw Authorization header — only used to derive the per-token cache key. */
  authHeader: string | null | undefined;
  /** Unique project scope for cache isolation across project runtimes. */
  cacheScope?: string;
  registry: IEntityRegistry;
  cache: ICache;
  /** Platform analytics — emits mcp.tools.list event. Optional for tests. */
  analytics?: IAnalytics | null;
  /** Observability collector — records mcp.tools.list operation. Optional for tests. */
  collector?: McpObservabilityCollector;
  /** Tenant ID for analytics context. */
  tenantId?: string;
}

/**
 * Resolve the tools an identity may see. Cached per identity for 60s; the cache
 * is a LISTING optimization only — it is never the authority for execution
 * (executeToolCall re-checks the live policy). Anonymous callers (permits=null)
 * always get an empty list and never touch the registry.
 */
export async function resolveVisibleTools(args: ResolveVisibleToolsArgs): Promise<McpTool[]> {
  const { permits, authHeader, registry, cache, analytics, collector, tenantId = 'anonymous' } =
    args;
  const t0 = Date.now();

  // Anonymous identities share one bucket regardless of any (invalid) header.
  const cacheKey = toolsCacheKey(permits ? authHeader : null, args.cacheScope ?? 'default');

  const cached = await cache.get<McpTool[]>(cacheKey).catch(() => null);
  if (cached) {
    const durationMs = Date.now() - t0;
    collector?.recordOp('mcp.tools.list', durationMs, true);
    analytics?.track('mcp.tools.list', {
      tenantId,
      toolCount: cached.length,
      cached: true,
      durationMs,
    }).catch(() => {});
    return cached;
  }

  const tools = permits ? filterTools(registry.snapshot(), permits) : [];
  await cache.set(cacheKey, tools, TOOLS_CACHE_TTL_MS).catch(() => {});

  const durationMs = Date.now() - t0;
  collector?.recordOp('mcp.tools.list', durationMs, true);
  analytics?.track('mcp.tools.list', {
    tenantId,
    toolCount: tools.length,
    cached: false,
    durationMs,
  }).catch(() => {});

  return tools;
}

export interface ExecuteToolCallArgs {
  name: string;
  args: Record<string, unknown>;
  visibleTools: McpTool[];
  /** Identity-bound predicate, or null for anonymous. */
  permits: Permits | null;
  tenantId: string;
  resolvePlatform: PlatformResolver;
  /** Request logger receives unexpected stacks with their correlation ID. */
  logger: ILogger;
  /** Platform analytics — emits mcp.tool.call events. Optional for tests. */
  analytics?: IAnalytics | null;
  /** Observability collector — records mcp.tool.call operation. Optional for tests. */
  collector?: McpObservabilityCollector;
  gatewayUrl?: string;
}

/**
 * Execute a tool call. Two independent gates protect execution:
 *   1. the tool must be in the caller's visible set, and
 *   2. the LIVE policy must still permit it (re-checked here, not trusted from
 *      the possibly-stale cached listing).
 * Only then is the command run via executeCommandV3.
 */
export async function executeToolCall(args: ExecuteToolCallArgs): Promise<CallToolResult> {
  const { name, visibleTools, permits, tenantId, resolvePlatform, analytics, collector, logger, gatewayUrl } = args;
  const t0 = Date.now();

  if (!permits) {
  return mcpToolError({ code: 'KB_AUTH_REQUIRED', details: { gatewayUrl: gatewayUrl ?? '<url>' } });
  }

  const tool = visibleTools.find((t) => t.name === name);
  if (!tool) {
    return mcpToolError({ code: 'KB_RUNTIME_MCP_UNKNOWN_TOOL', details: { tool: name } });
  }

  // Authoritative gate — independent of the cached visibility list. When the
  // platform supplies a real policy, a tool that became forbidden after it was
  // cached is rejected here with no server code change.
  if (!permits(tool.operationType, tool.pluginId)) {
    return mcpToolError({ code: 'KB_AUTH_FORBIDDEN', details: { permission: actionForOperation(tool.operationType) } });
  }

  const validationError = validateToolArguments(tool.inputSchema, args.args);
  if (validationError) {
    return invalidMcpToolArguments(validationError);
  }

  analytics?.track('mcp.tool.call.started', {
    toolName: name,
    tenantId,
    pluginId: tool.pluginId,
  }).catch(() => {});

  let result: Awaited<ReturnType<typeof callTool>>;
  try {
    result = await callTool(tool, args.args, tenantId, resolvePlatform);
  } catch (error) {
    const durationMs = Date.now() - t0;
    collector?.recordOp('mcp.tool.call', durationMs, false);
    analytics?.track('mcp.tool.call.completed', {
      toolName: name,
      tenantId,
      pluginId: tool.pluginId,
      success: false,
      durationMs,
    }).catch(() => {});
    return unexpectedMcpResult(error, logger);
  }

  const durationMs = Date.now() - t0;
  collector?.recordOp('mcp.tool.call', durationMs, result.success);
  analytics?.track('mcp.tool.call.completed', {
    toolName: name,
    tenantId,
    pluginId: tool.pluginId,
    success: result.success,
    exitCode: result.exitCode,
    outputLength: result.output.length,
    durationMs,
  }).catch(() => {});

  if (!result.success) {
    return errorResult(result.error);
  }
  return mcpToolSuccess(result.output, result.structured);
}
