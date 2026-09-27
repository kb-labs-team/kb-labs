import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ICache } from '@kb-labs/core-platform';
import type { IEntityRegistry, RegistrySnapshot } from '@kb-labs/core-registry';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { ManifestV3, CliCommandDecl } from '@kb-labs/plugin-contracts';
import type { Permits } from '../mcp/authz.js';
import type { AgentLeaseRecord } from '../mcp/agent-leases.js';
import type { McpTool } from '../mcp/tool-builder.js';
import { callOutput } from '../mcp/output-capture.js';

// Mock the command runtime boundary so executeToolCall exercises the real
// gate + tool-router without spawning a plugin process.
const executeCommandV3 = vi.fn();
vi.mock('@kb-labs/cli-runtime', () => ({
  executeCommandV3: (...args: unknown[]) => executeCommandV3(...args),
}));

const { toolsCacheKey, resolveVisibleTools, executeToolCall, TOOLS_CACHE_TTL_MS } = await import(
  '../mcp/request-handler.js'
);

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

const container = { logger: {}, getSocketPath: () => '/tmp/s' } as unknown as PlatformContainer;
const resolvePlatform = () => container;

// ── toolsCacheKey ─────────────────────────────────────────────────────────

describe('toolsCacheKey', () => {
  it('returns the shared anonymous bucket for no header', () => {
    expect(toolsCacheKey(null)).toBe('mcp:tools:anonymous');
    expect(toolsCacheKey(undefined)).toBe('mcp:tools:anonymous');
  });

  it('derives a stable hashed key per token', () => {
    const k1 = toolsCacheKey('Bearer abc');
    const k2 = toolsCacheKey('Bearer abc');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^mcp:tools:[0-9a-f]{16}$/);
  });

  it('gives different tokens different keys (no cross-token leakage)', () => {
    expect(toolsCacheKey('Bearer abc')).not.toBe(toolsCacheKey('Bearer xyz'));
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

  it('anonymous uses the anonymous bucket even when an (invalid) header is present', async () => {
    const registry = makeRegistry([cmd('mind search', 'read')]);
    await resolveVisibleTools({ permits: null, authHeader: 'Bearer junk', registry, cache });
    expect(cache.set).toHaveBeenCalledWith('mcp:tools:anonymous', [], TOOLS_CACHE_TTL_MS);
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

  it('filters a lease listing to its explicit tool allowlist', async () => {
    const registry = makeRegistry([cmd('mind search', 'read'), cmd('mind deploy', 'execute')]);
    const lease = {
      allowedTools: ['mind__mind_search'], inputEquals: {}, expiresAt: Date.now() + 60_000,
    } as unknown as AgentLeaseRecord;
    const tools = await resolveVisibleTools({ permits: allow, lease, authHeader: 'Bearer lease', registry, cache });
    expect(tools.map((item) => item.name)).toEqual(['mind__mind_search']);
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

  it('reports an error for an unknown tool and never executes', async () => {
    const result = await executeToolCall({
      name: 'ghost__nope',
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool');
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
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Not authorized');
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  it('blocks a visible tool when the lease resource constraint does not match', async () => {
    const lease = {
      allowedTools: [tool.name], inputEquals: { [tool.name]: { server: 'staging' } },
      expiresAt: Date.now() + 60_000,
    } as unknown as AgentLeaseRecord;
    const result = await executeToolCall({
      name: tool.name, args: { server: 'production' }, visibleTools: [tool], permits: allow,
      lease, tenantId: 't1', resolvePlatform,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Not authorized by agent lease');
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  it('blocks an expired lease even if the MCP listing still contains the tool', async () => {
    const lease = {
      allowedTools: [tool.name], inputEquals: {}, expiresAt: Date.now() - 1,
    } as AgentLeaseRecord;
    const result = await executeToolCall({
      name: tool.name, args: {}, visibleTools: [tool], permits: allow,
      lease, tenantId: 't1', resolvePlatform,
    });
    expect(result.isError).toBe(true);
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
    });
    expect(result.isError).toBe(true);
    expect(executeCommandV3).not.toHaveBeenCalled();
  });

  it('executes an allowed tool and maps a success exit code', async () => {
    // Simulate what the execution backend's uiProvider does: write into callOutput store.
    executeCommandV3.mockImplementation(async () => {
      callOutput.getStore()?.push('[info] ran');
      return 0;
    });
    const result = await executeToolCall({
      name: tool.name,
      args: { q: 'x' },
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('ran');
    expect(executeCommandV3).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'mind', flags: { q: 'x' }, tenantId: 't1' }),
    );
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
      collector,
    });
    expect(recordOp).toHaveBeenCalledWith('mcp.tool.call', expect.any(Number), true);
  });

  it('maps a non-zero exit code to isError', async () => {
    executeCommandV3.mockResolvedValue(1);
    const result = await executeToolCall({
      name: tool.name,
      args: {},
      visibleTools: [tool],
      permits: allow,
      tenantId: 't1',
      resolvePlatform,
    });
    expect(result.isError).toBe(true);
  });
});
