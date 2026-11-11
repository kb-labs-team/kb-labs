import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ICache, ILogger } from '@kb-labs/core-platform';
import type { ErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import type { IEntityRegistry, RegistrySnapshot } from '@kb-labs/plugin-contracts';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { ManifestV3, CliCommandDecl } from '@kb-labs/plugin-contracts';
import type { Permits } from '../mcp/authz.js';
import { createPermits } from '../mcp/authz.js';
import type { Policy } from '@kb-labs/core-policy';
import type { AuthContext } from '@kb-labs/gateway-contracts';
import type { McpTool } from '../mcp/tool-builder.js';
import { callOutput } from '../mcp/output-capture.js';
import { uiOutputContractCases, renderUIOutputText } from '@kb-labs/plugin-contracts';
import resultSchema from '@kb-labs/core-platform/contracts/ux-result/machine-result.schema.json';
import successFixture from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/success.json';
import failureFixture from '@kb-labs/core-platform/contracts/ux-result/fixtures/valid/failure.json';
import { filterTools } from '../mcp/tool-builder.js';

// Mock the command runtime boundary so executeToolCall exercises the real
// gate + tool-router without spawning a plugin process.
const executeCommandV3 = vi.fn();
vi.mock('@kb-labs/cli-runtime', () => ({
  executeCommandV3: (...args: unknown[]) => executeCommandV3(...args),
}));

const { toolsCacheKey, resolveVisibleTools, executeToolCall, TOOLS_CACHE_TTL_MS } = await import(
  '../mcp/request-handler.js'
);

type MachineResult =
  | { ok: true; data: unknown; meta?: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

function expectSharedMachineResult(value: unknown): asserts value is MachineResult {
  expect(resultSchema.oneOf).toHaveLength(2);
  expect(value).toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    throw new Error('Expected a machine result object');
  }
  if (value.ok === true) {
    expect(value).toMatchObject({ ok: true, data: expect.anything() });
    expect(Object.keys(value).every((key) => ['ok', 'data', 'meta'].includes(key))).toBe(true);
  } else {
    expect(value).toMatchObject({ ok: false, error: {
      code: expect.stringMatching(/^KB_/),
      message: expect.any(String),
      hint: expect.any(String),
      correlationId: expect.any(String),
    } });
    expect(Object.keys(value).sort()).toEqual(['error', 'ok']);
  }
}

const allow: Permits = () => true;
const deny: Permits = () => false;

/** Extract the first text block from an MCP tool result (content is a union). */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  return block?.type === 'text' ? (block.text ?? '') : '';
}

// ── Test doubles ────────────────────────────────────────────────────────────

/** In-memory ICache exposing the underlying map and spies for assertions. */
function makeCache(): ICache & { store: Map<string, unknown>; get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  const store = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null));
  const set = vi.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  return { store, get, set, del } as unknown as ICache & {
    store: Map<string, unknown>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
}

function cmd(path: string, operationType: CliCommandDecl['operationType']): CliCommandDecl {
  return { path, describe: `does ${path}`, handler: `dist/commands/${path.replace(/\s+/g, '-')}.js`, operationType };
}

function makeRegistry(commands: CliCommandDecl[]): IEntityRegistry & { snapshot: ReturnType<typeof vi.fn> } {
  const manifest: ManifestV3 = { schema: 'kb.plugin/3', id: 'mind', version: '1.0.0', cli: { commands } };
  const snap = {
    manifests: [{ pluginId: 'mind', manifest, pluginRoot: '/plugins/mind', source: { kind: 'local', path: '/plugins/mind' } }],
  } as unknown as RegistrySnapshot;
  const snapshot = vi.fn(() => snap);
  return { snapshot } as unknown as IEntityRegistry & { snapshot: ReturnType<typeof vi.fn> };
}

const tool: McpTool = {
  name: 'mind__mind_search',
  description: 'search',
  inputSchema: { type: 'object' },
  pluginId: 'mind',
  pluginRoot: '/plugins/mind',
  handlerPath: 'dist/commands/mind-search.js',
  version: '1.0.0',
  operationType: 'read',
  permissions: {},
};

const container = { logger: {} } as unknown as PlatformContainer;
const resolvePlatform = () => container;
const requestLogger = { error: vi.fn() } as unknown as ILogger;

// ── toolsCacheKey ─────────────────────────────────────────────────────────

describe('toolsCacheKey', () => {
  it('isolates catalogs by project scope, including anonymous requests', () => {
    expect(toolsCacheKey(null, '/projects/a')).not.toBe(toolsCacheKey(null, '/projects/b'));
    expect(toolsCacheKey(undefined, '/projects/a')).toBe(toolsCacheKey(null, '/projects/a'));
  });

  it('derives a stable hashed key per token', () => {
    const k1 = toolsCacheKey('Bearer abc', '/projects/a');
    const k2 = toolsCacheKey('Bearer abc', '/projects/a');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^mcp:tools:[0-9a-f]{16}:[0-9a-f]{16}$/);
  });

  it('gives different tokens different keys (no cross-token leakage)', () => {
    expect(toolsCacheKey('Bearer abc', '/projects/a')).not.toBe(toolsCacheKey('Bearer xyz', '/projects/a'));
  });
});

// ── resolveVisibleTools ─────────────────────────────────────────────────────

describe('resolveVisibleTools', () => {
  let cache: ReturnType<typeof makeCache>;
  beforeEach(() => {
    cache = makeCache();
  });

  it('returns an empty list for anonymous (no permits) without touching the registry', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    const tools = await resolveVisibleTools({ permits: null, authHeader: 'Bearer junk', registry, cache });
    expect(tools).toEqual([]);
    expect(registry.snapshot).not.toHaveBeenCalled();
  });

  // case: S-045.4
  it('does not reuse a tokenless catalog from another project runtime', async () => {
    const projectA = makeRegistry([cmd('workflow run', 'execute')]);
    const projectB = makeRegistry([cmd('commit plan apply', 'execute')]);
    const toolsA = await resolveVisibleTools({
      permits: allow, authHeader: null, cacheScope: '/projects/a', registry: projectA, cache,
    });
    const toolsB = await resolveVisibleTools({
      permits: allow, authHeader: null, cacheScope: '/projects/b', registry: projectB, cache,
    });
    expect(toolsA.map((item) => item.name)).toEqual(['mind__workflow_run']);
    expect(toolsB.map((item) => item.name)).toEqual(['mind__commit_plan_apply']);
    expect(projectB.snapshot).toHaveBeenCalledOnce();
  });

  it('anonymous uses the anonymous bucket even when an (invalid) header is present', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    await resolveVisibleTools({ permits: null, authHeader: 'Bearer junk', registry, cache });
    expect(cache.set).toHaveBeenCalledWith(toolsCacheKey(null), [], TOOLS_CACHE_TTL_MS);
  });

  it('filters from the registry snapshot on a cache miss and caches the result with TTL', async () => {
    const registry = makeRegistry([cmd('mind search', 'read'), cmd('mind deploy', 'execute')]);
    const tools = await resolveVisibleTools({ permits: allow, authHeader: 'Bearer t', registry, cache });
    expect(tools.map((t) => t.name)).toEqual(['mind__mind_search', 'mind__mind_deploy']);
    expect(registry.snapshot).toHaveBeenCalledOnce();
    const key = toolsCacheKey('Bearer t');
    expect(cache.set).toHaveBeenCalledWith(key, tools, TOOLS_CACHE_TTL_MS);
  });

  it('honours the per-identity permits predicate when filtering', async () => {
    const onlyRead: Permits = (op) => op === 'read';
    const registry = makeRegistry([cmd('mind search', 'read'), cmd('mind deploy', 'execute')]);
    const tools = await resolveVisibleTools({ permits: onlyRead, authHeader: 'Bearer t', registry, cache });
    expect(tools.map((t) => t.name)).toEqual(['mind__mind_search']);
  });

  it('returns the cached list on a hit without re-reading the registry', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    const key = toolsCacheKey('Bearer t');
    cache.store.set(key, [tool]);
    const tools = await resolveVisibleTools({ permits: allow, authHeader: 'Bearer t', registry, cache });
    expect(tools).toEqual([tool]);
    expect(registry.snapshot).not.toHaveBeenCalled();
  });

  it('tolerates a cache.get failure and falls back to filtering', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    cache.get.mockRejectedValueOnce(new Error('cache down'));
    const tools = await resolveVisibleTools({ permits: allow, authHeader: 'Bearer t', registry, cache });
    expect(tools.map((t) => t.name)).toEqual(['mind__mind_search']);
  });

  it('tolerates a cache.set failure and still returns the tools', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    cache.set.mockRejectedValueOnce(new Error('cache down'));
    const tools = await resolveVisibleTools({ permits: allow, authHeader: 'Bearer t', registry, cache });
    expect(tools.map((t) => t.name)).toEqual(['mind__mind_search']);
  });

  it('emits analytics event for tools list', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    const track = vi.fn().mockResolvedValue(undefined);
    const analytics = { track } as unknown as Parameters<typeof resolveVisibleTools>[0]['analytics'];
    await resolveVisibleTools({ permits: allow, authHeader: 'Bearer t', registry, cache, analytics, tenantId: 'tenant1' });
    expect(track).toHaveBeenCalledWith('mcp.tools.list', expect.objectContaining({
      tenantId: 'tenant1', cached: false,
    }));
  });
});

// ── executeToolCall ─────────────────────────────────────────────────────────

describe('executeToolCall', () => {
  beforeEach(() => {
    executeCommandV3.mockReset();
  });

  // case: S-140.3
  it('reports an error for an unknown tool and never executes', async () => {
    const result = await executeToolCall({
      name: 'ghost__nope',
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_MCP_UNKNOWN_TOOL', message: expect.stringContaining('ghost__nope') } });
    expect(textOf(result)).toContain('KB_RUNTIME_MCP_UNKNOWN_TOOL:');
    expect(textOf(result)).toContain('tools/list');
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  it('blocks execution when the live policy denies a still-visible tool', async () => {
    // Tool is in the visible (cached) list, but policy now denies it.
    const result = await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: deny,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN' } });
    expect(textOf(result)).toContain('KB_AUTH_FORBIDDEN:');
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  it('blocks execution for an anonymous caller (permits=null)', async () => {
    const result = await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: null,
      tenantId: 'anonymous',
      resolvePlatform,
      logger: requestLogger,
      gatewayUrl: 'https://gateway.example.test',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: {
      code: 'KB_AUTH_REQUIRED',
      hint: 'Run "kb auth login --gateway-url https://gateway.example.test --email <email>" and enter your password at the prompt, or provide it with --password-stdin.',
    } });
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  // case: S-140.4
  it('rejects arguments whose values violate the listed JSON schema', async () => {
    const typedTool = { ...tool, inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } } };
    const result = await executeToolCall({
      name: typedTool.name,
      args: { force: 'yes' },
      visibleTools: [typedTool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_MCP_INVALID_ARGUMENTS',
        message: expect.stringContaining('force'),
        details: { argument: 'force', expected: 'boolean' },
      },
    });
    expect(textOf(result)).toContain('KB_RUNTIME_MCP_INVALID_ARGUMENTS:');
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  // case: S-203.2
  it('rejects undeclared arguments for tools whose schemas have no inputs', async () => {
    const noInputTool = { ...tool, inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
    const result = await executeToolCall({
      name: noInputTool.name,
      args: { __ux_invalid_probe__: true },
      visibleTools: [noInputTool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_MCP_INVALID_ARGUMENTS', hint: expect.any(String), correlationId: expect.any(String) },
    });
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  // case: S-203.1
  it('executes an allowed registry tool and returns a shared success envelope', async () => {
    // Simulate what the execution backend's uiProvider does: write into callOutput store.
    const output = uiOutputContractCases.message.output;
    executeCommandV3.mockImplementation(async () => {
      callOutput.getStore()?.text.push(renderUIOutputText(output));
      callOutput.getStore()?.structured.push(output);
      return 0;
    });
    const result = await executeToolCall({
      name: tool.name,
      args: { q: 'x' },
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('message body');
    expectSharedMachineResult(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ ok: true, data: renderUIOutputText(output), meta: { ui: [output] } });
    expect(executeCommandV3).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'mind', flags: { q: 'x' }, tenantId: 't1' }),
    );
  });

  // case: S-255.7
  it('returns catalog auth envelopes for unauthenticated and forbidden tool calls', async () => {
    const unauthenticated = await executeToolCall({
      name: 'plugin__command', args: {}, visibleTools: [], permits: null, tenantId: 'tenant',
      resolvePlatform,
      logger: requestLogger,
      gatewayUrl: 'https://gateway.example.test',
    });
    expect(unauthenticated).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: {
        code: 'KB_AUTH_REQUIRED', message: 'Authentication is required.',
        hint: 'Run "kb auth login --gateway-url https://gateway.example.test --email <email>" and enter your password at the prompt, or provide it with --password-stdin.',
      } },
    });

    const forbidden = await executeToolCall({
      name: tool.name, args: {}, visibleTools: [tool], permits: () => false, tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(forbidden).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'KB_AUTH_FORBIDDEN' } },
    });
  });

  // PDP seam only: production MCP has no permission-gated tools yet (see HANDOFF product question).
  it('allows a permission-gated MCP tool for an admin and returns KB_AUTH_FORBIDDEN for a member', async () => {
    executeCommandV3.mockResolvedValue(0);
    const policy: Policy = {
      schemaVersion: '1.0',
      default: 'deny',
      rules: [{ action: 'mcp.read', resource: 'mind', allow: ['users:write'] }],
    };
    const admin: AuthContext = {
      type: 'user', userId: 'admin-1', namespaceId: 'tenant-1', tier: 'free', permissions: ['users:write'],
    };
    const member: AuthContext = {
      type: 'user', userId: 'member-1', namespaceId: 'tenant-1', tier: 'free', permissions: ['plugins:read'],
    };

    const allowed = await executeToolCall({
      name: tool.name, args: {}, visibleTools: [tool], permits: createPermits(policy, admin), tenantId: 'tenant-1',
      resolvePlatform, logger: requestLogger,
    });
    expect(allowed.isError).toBe(false);
    expect(executeCommandV3).toHaveBeenCalledTimes(1);

    const denied = await executeToolCall({
      name: tool.name, args: {}, visibleTools: [tool], permits: createPermits(policy, member), tenantId: 'tenant-1',
      resolvePlatform, logger: requestLogger,
    });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'KB_AUTH_FORBIDDEN' } },
    });
    expect(executeCommandV3).toHaveBeenCalledTimes(1);
  });

  it('emits analytics events for tool calls', async () => {
    executeCommandV3.mockResolvedValue(0);
    const track = vi.fn().mockResolvedValue(undefined);
    const analytics = { track } as unknown as Parameters<typeof executeToolCall>[0]['analytics'];
    await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
      analytics,
    });
    expect(track).toHaveBeenCalledWith('mcp.tool.call.started', expect.objectContaining({
      toolName: tool.name, tenantId: 't1',
    }));
    expect(track).toHaveBeenCalledWith('mcp.tool.call.completed', expect.objectContaining({
      toolName: tool.name, success: true,
    }));
  });

  it('records op in collector for tool calls', async () => {
    executeCommandV3.mockResolvedValue(0);
    const recordOp = vi.fn();
    const collector = { recordOp } as unknown as Parameters<typeof executeToolCall>[0]['collector'];
    await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
      collector,
    });
    expect(recordOp).toHaveBeenCalledWith('mcp.tool.call', expect.any(Number), true);
  });

  // case: S-203.2
  it('preserves the execution envelope and correlation ID in the MCP error result', async () => {
    const envelope: ErrorEnvelope = {
      code: 'KB_PLUGIN_COMMAND_FAILED', area: 'plugin', stage: 'run', severity: 'error', retryable: false,
      message: 'Plugin search failed unexpectedly.', hint: 'Run "kb logs query --correlation-id mcp-correlation".',
      correlationId: 'mcp-correlation',
    };
    executeCommandV3.mockImplementation(async (options: { onError?: (error: ErrorEnvelope) => void }) => {
      options.onError?.(envelope);
      return 1;
    });
    const result = await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: requestLogger,
    });
    expect(result.isError).toBe(true);
    expectSharedMachineResult(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ ok: false, error: envelope });
  });

  // case: S-203.3
  it('correlates unexpected execution failures in logs without exposing their details', async () => {
    const logger = { error: vi.fn() };
    executeCommandV3.mockRejectedValueOnce(new Error('private failure stack'));
    const result = await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
      logger: logger as unknown as Parameters<typeof executeToolCall>[0]['logger'],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED' } });
    expect(JSON.stringify(result)).not.toContain('private failure stack');
    const envelope = (result.structuredContent as { error: { correlationId: string } }).error;
    expect(envelope.correlationId).toEqual(expect.any(String));
    expect(textOf(result)).toContain(envelope.correlationId);
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected MCP request failure',
      expect.objectContaining({ message: 'private failure stack', stack: expect.stringContaining('private failure stack') }),
      { correlationId: envelope.correlationId },
    );
  });

  it('applies the shared result contract to every tool produced by the registry', async () => {
    const snapshot = makeRegistry([
      cmd('mind search', 'read'),
      cmd('mind inspect', 'read'),
      cmd('mind deploy', 'execute'),
    ]).snapshot();
    const registeredTools = filterTools(snapshot, allow);
    expect(registeredTools.length).toBeGreaterThan(0);

    for (const registeredTool of registeredTools) {
      executeCommandV3.mockResolvedValueOnce(0);
      const success = await executeToolCall({
        name: registeredTool.name,
        args: {},
        visibleTools: registeredTools,
        permits: allow,
        tenantId: 't1',
        resolvePlatform,
        logger: requestLogger,
      });
      expect(success.isError).toBe(false);
      expectSharedMachineResult(success.structuredContent);

      executeCommandV3.mockResolvedValueOnce(1);
      const failure = await executeToolCall({
        name: registeredTool.name,
        args: {},
        visibleTools: registeredTools,
        permits: allow,
        tenantId: 't1',
        resolvePlatform,
        logger: requestLogger,
      });
      expect(failure.isError).toBe(true);
      expectSharedMachineResult(failure.structuredContent);
    }

    expectSharedMachineResult(successFixture);
    expectSharedMachineResult(failureFixture);
  });
});
