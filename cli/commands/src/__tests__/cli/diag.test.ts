/**
 * Unit tests for the `diag` command.
 *
 * All external dependencies are mocked so tests run without a real workspace,
 * registry, or filesystem. Each test verifies one specific diagnostic scenario.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import type { DetailedDiscovery } from '../../registry/discover.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const discoverState = vi.hoisted(() => ({ diagnostics: [] as unknown[] }));
const catalogState = vi.hoisted(() => ({ lock: vi.fn(async () => null as unknown), diagnostics: [] as unknown[] }));

vi.mock('../../registry/discover.js', () => {
  const discoverManifests = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
  return {
    discoverManifests,
    // The trace uses the detailed variant; it shares the mocked results.
    discoverManifestsDetailed: vi.fn(async (...args: unknown[]) => ({
      results: await discoverManifests(...args),
      diagnostics: discoverState.diagnostics,
    })),
  };
});

vi.mock('../../registry/service.js', () => ({
  registry: {
    listCommands: vi.fn(() => []),
    resolve: vi.fn(() => ({ type: 'not-found', input: [], suggestions: [] })),
  },
}));

vi.mock('../../registry/register.js', () => ({
  preflightManifests: vi.fn(() => ({ valid: [], skipped: [] })),
}));

vi.mock('../../registry/schema.js', () => ({
  validateManifests: vi.fn(() => ({ success: true, data: [] })),
  normalizeManifest: vi.fn((m: unknown) => m),
}));

const mockCollectorInstance = {
  getEvents: vi.fn(() => []),
  add: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  hasErrors: vi.fn(() => false),
  countBySeverity: vi.fn(() => ({})),
};

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => undefined),
  readFile: vi.fn(async () => '{}'),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMockPlatform() {
  return {
    logger: {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
      warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    llm: {} as never, embeddings: {} as never, vectorStore: {} as never,
    cache: {} as never, storage: {} as never, analytics: {} as never,
    eventBus: { publish: vi.fn(async () => {}), subscribe: vi.fn(() => () => {}) },
    logs: {} as never,
  };
}

function makeCtx(overrides: Partial<PluginContextV3['ui']> = {}): PluginContextV3 {
  return {
    host: 'cli',
    requestId: 'test-diag',
    pluginId: '@kb-labs/system',
    pluginVersion: '1.0.0',
    cwd: '/test/workspace',
    ui: {
      ...noopUI,
      ...overrides,
    },
    platform: makeMockPlatform() as never,
    runtime: { fs: {} as never, fetch: vi.fn(), env: vi.fn() },
    api: {} as never,
    hostContext: {
      host: 'cli' as const,
      binaryName: 'kb',
      argv: [],
      flags: {},
      resolvePlatformVersion: async () => 'test',
    },
    trace: noopTraceContext,
  };
}

function readData<T>(jsonSpy: ReturnType<typeof vi.fn>): T {
  const envelope = jsonSpy.mock.calls[0]?.[0] as { ok?: boolean; data?: T };
  expect(envelope).toMatchObject({ ok: true });
  return envelope.data as T;
}

// Lazy import after mocks are set up
async function getDiag() {
  const { diag } = await import('../../commands/system/diag.js');
  return diag;
}

async function getRegistryMock() {
  const mod = await import('../../registry/service.js');
  return mod.registry as unknown as { listCommands: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };
}

async function getDiscoverMock() {
  const mod = await import('../../registry/discover.js');
  return mod as unknown as { discoverManifests: ReturnType<typeof vi.fn> };
}

async function setDiscoveryResult(results: unknown[], diagnostics = discoverState.diagnostics): Promise<void> {
  const state = await import('../../registry/discovery-state.js');
  state.setRegisteredDiscovery({ results, diagnostics } as unknown as DetailedDiscovery);
}

async function getLockMock() {
  return catalogState.lock as unknown as ReturnType<typeof vi.fn>;
}

async function setCatalog(): Promise<void> {
  const state = await import('../../registry/discovery-state.js');
  state.setResolvedCatalog({
    marketplaceLocks: async () => {
      const lock = await catalogState.lock();
      return lock ? new Map([['/test/workspace', lock]]) : new Map();
    },
    discovery: () => ({ diagnostics: mockCollectorInstance.getEvents() }),
  } as never);
}

async function getFsMock() {
  const mod = await import('node:fs/promises');
  return mod as unknown as { access: ReturnType<typeof vi.fn>; readFile: ReturnType<typeof vi.fn> };
}

// ── Tests: base diag ──────────────────────────────────────────────────────────

describe('diag — base (no --command)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    catalogState.lock = vi.fn(async () => null);
    mockCollectorInstance.getEvents.mockReturnValue([]);
    discoverState.diagnostics = [];
    await setDiscoveryResult([]);
    await setCatalog();
    const discovery = await getDiscoverMock();
    discovery.discoverManifests.mockReset();
    discovery.discoverManifests.mockResolvedValue([]);
  });

  it('exits 0 when everything is healthy', async () => {
    const diag = await getDiag();
    const jsonSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy });
    const code = await diag.run(ctx, [], { json: true });
    expect(code).toBe(0);
    expect(jsonSpy).toHaveBeenCalledOnce();
    const result = readData<{ status: string }> (jsonSpy);
    expect(result.status).toBe('degraded');
  });

  it('surfaces unavailable commands from registry with unavailableReason + hint', async () => {
    const reg = await getRegistryMock();
    reg.listCommands.mockReturnValue([
      {
        manifest: { segments: ['review', 'run'], _synthetic: false },
        available: false,
        unavailableReason: 'Missing dependency: @kb-labs/review-engine',
        hint: 'pnpm add @kb-labs/review-engine',
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/review',
      },
    ]);

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true });

    const result = readData<{ diagnostics: Array<{ code?: string; remediation?: string; status: string }> }> (jsonSpy);
    const unavailable = result.diagnostics.filter(d => d.code === 'REQUIRES_MISSING');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.remediation).toBe('pnpm add @kb-labs/review-engine');
    expect(unavailable[0]?.status).toBe('warning');
  });

  it('surfaces DiagnosticCollector error events from marketplace lock', async () => {
    mockCollectorInstance.getEvents.mockReturnValue([
      {
        severity: 'error' as const,
        code: 'INTEGRITY_MISMATCH' as never,
        message: 'Hash mismatch for @kb-labs/workflow-entry',
        remediation: 'kb marketplace plugins doctor',
        context: { pluginId: '@kb-labs/workflow-entry' },
        ts: Date.now(),
      } as never,
    ]);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({ plugins: {} });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true });

    const result = readData<{ diagnostics: Array<{ code?: string; status: string }> }> (jsonSpy);
    const lockEvents = result.diagnostics.filter(d => d.code === 'INTEGRITY_MISMATCH');
    expect(lockEvents).toHaveLength(1);
    expect(lockEvents[0]?.status).toBe('error');
  });

  it('surfaces synthetic manifests as manifest-load-failure with remediation', async () => {
    const discover = await getDiscoverMock();
    const discovered = [
      {
        packageName: '@kb-labs/quality',
        manifestPath: '/test/workspace/plugins/{plugin}/dist/manifest.js',
        pkgRoot: '/test/workspace/plugins/{plugin}',
        source: 'workspace',
        scope: 'platform',
        manifests: [
          {
            _synthetic: true,
            segments: ['quality', 'manifest:quality-entry'],
            id: 'manifest:quality-entry',
            group: 'quality',
            describe: 'Commands from @kb-labs/quality are unavailable',
            schema: 'kb.adapter/1', manifestVersion: '1.0',
            loader: async () => { throw new Error('Cannot load'); },
          },
        ],
      },
    ];
    discover.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true });

    const result = readData<{ diagnostics: Array<{ code?: string; status: string; remediation?: string }> }> (jsonSpy);
    const failures = result.diagnostics.filter(d => d.code === 'MANIFEST_LOAD_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.status).toBe('error');
    expect(failures[0]?.remediation).toMatch(/pnpm.*build/);
    expect(discover.discoverManifests).not.toHaveBeenCalled();
  });

  it('includes code and remediation on all diagnostic items in --json output', async () => {
    const reg = await getRegistryMock();
    reg.listCommands.mockReturnValue([
      {
        manifest: { segments: ['review', 'run'], _synthetic: false },
        available: false,
        unavailableReason: 'Missing dependency: @kb-labs/review-engine',
        hint: 'pnpm add @kb-labs/review-engine',
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/review',
      },
    ]);

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true });

    const result = readData<{ diagnostics: Array<{ code?: string }> }> (jsonSpy);
    const withCode = result.diagnostics.filter(d => d.code !== undefined);
    expect(withCode.length).toBeGreaterThan(0);
  });
});

// ── Tests: --command trace ────────────────────────────────────────────────────

describe('diag --command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollectorInstance.getEvents.mockReturnValue([]);
  });

  it('returns all stages ok when command is available', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'command',
      command: {
        manifest: { segments: ['commit', 'status'], _synthetic: false },
        available: true,
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/commit',
      },
      rest: [],
    });
    await setDiscoveryResult([{
      packageName: '@kb-labs/commit',
      manifestPath: '/test/node_modules/@kb-labs/commit/dist/manifest.js',
      pkgRoot: '/test/node_modules/@kb-labs/commit',
      source: 'linked',
      scope: 'platform',
      manifests: [{ _synthetic: false, group: 'commit', segments: ['commit', 'status'], id: 'list', describe: 'List plugins', schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() }],
    }]);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({
      plugins: {
        '@kb-labs/commit': { enabled: true, resolvedPath: '/test/node_modules/@kb-labs/commit' },
      },
    });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    const code = await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'commit status' });

    expect(code).toBe(0);
    const result = readData<{ status: string; stages: Array<{ code: string; status: string }>; verdict: { rootCause: string } }> (jsonSpy);
    expect(result.status).toBe('healthy');
    expect(result.verdict.rootCause).toBe('NONE');
    const registryStage = result.stages.find(s => s.code === 'REGISTRY_OK');
    expect(registryStage).toBeDefined();
  });

  it('reports when the shared discovered command is missing from the dispatch registry', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['commit', 'plan', 'show'], suggestions: [] });
    const { discoverManifestsDetailed } = await import('../../registry/discover.js');
    await setDiscoveryResult([{
        packageName: '@kb-labs/commit',
        manifestPath: '/project/.kb/plugins/commit/dist/manifest.json',
        pkgRoot: '/project/.kb/plugins/commit',
        source: 'linked',
        scope: 'project',
        manifests: [{ _synthetic: false, group: 'commit', segments: ['commit', 'plan', 'show'], id: 'show', describe: 'Show current plan', schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() }],
      }]);

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'commit plan show' });

    const result = readData<{ status: string; stages: Array<{ code: string }> }>(jsonSpy);
    expect(result.status).toBe('unhealthy');
    expect(result.stages.map(({ code }) => code)).toContain('COMMAND_REGISTRATION_MISSING');
    expect(discoverManifestsDetailed).not.toHaveBeenCalled();
  });

  it('reports REQUIRES_MISSING when command is unavailable', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'command',
      command: {
        manifest: { segments: ['review', 'run'], _synthetic: false },
        available: false,
        unavailableReason: 'Missing dependency: @kb-labs/review-engine',
        hint: 'pnpm add @kb-labs/review-engine',
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/review',
      },
      rest: [],
    });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    const code = await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'review run' });

    expect(code).toBe(0);
    const result = readData<{ status: string; stages: Array<{ code: string; status: string; remediation?: string }>; verdict: { rootCause: string; remediation?: string } }> (jsonSpy);
    expect(result.status).toBe('unhealthy');
    const stage = result.stages.find(s => s.code === 'REQUIRES_MISSING');
    expect(stage).toBeDefined();
    expect(stage?.status).toBe('error');
    expect(stage?.remediation).toBe('pnpm add @kb-labs/review-engine');
    expect(result.verdict.rootCause).toBe('REQUIRES_MISSING');
  });

  it('reports SHADOWED_BY with ownerPackage when command is shadowed', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'command',
      command: {
        manifest: { segments: ['deploy', 'run'] },
        available: true,
        shadowed: true,
        source: 'linked',
        packageName: '@kb-labs/deploy',
      },
      rest: [],
    });
    reg.listCommands.mockReturnValue([
      {
        manifest: { segments: ['deploy', 'run'] },
        available: true,
        shadowed: false,
        packageName: '@kb-labs/infra-worker',
      },
    ]);

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'deploy run' });

    const result = readData<{ stages: Array<{ code: string; details?: Record<string, unknown> }> }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'SHADOWED_BY');
    expect(stage).toBeDefined();
    expect(stage?.details?.ownerPackage).toBe('@kb-labs/infra-worker');
  });

  it('reports REGISTRY_NOT_FOUND + NOT_IN_LOCK when command is completely unknown', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['nonexistent', 'foo'], suggestions: [] });

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({ plugins: {} });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    const code = await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'nonexistent foo' });

    expect(code).toBe(0);
    const result = readData<{ stages: Array<{ code: string }> }> (jsonSpy);
    const codes = result.stages.map(s => s.code);
    expect(codes).toContain('REGISTRY_NOT_FOUND');
    expect(codes).toContain('NOT_IN_LOCK');
  });

  it('reports PLUGIN_DISABLED when lock entry is disabled', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['workflow', 'run'], suggestions: [] });

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({
      plugins: {
        '@kb-labs/workflow-entry': { enabled: false, resolvedPath: '/test/node_modules/@kb-labs/workflow-entry' },
      },
    });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    const code = await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'workflow run' });

    expect(code).toBe(0);
    const result = readData<{ stages: Array<{ code: string; remediation?: string }>; verdict: { rootCause: string; remediation?: string } }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'PLUGIN_DISABLED');
    expect(stage).toBeDefined();
    expect(stage?.remediation).toMatch(/marketplace plugins enable/);
    expect(result.verdict.rootCause).toBe('PLUGIN_DISABLED');
  });

  it('reports MANIFEST_LOAD_FAILED with distExists hint when synthetic manifest found', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['quality', 'report'], suggestions: [] });

    const discover = await getDiscoverMock();
    const discovered = [
      {
        packageName: '@kb-labs/quality',
        manifestPath: '/test/workspace/plugins/{plugin}/dist/manifest.js',
        pkgRoot: '/test/workspace/plugins/{plugin}',
        source: 'workspace',
        scope: 'platform',
        manifests: [
          {
            _synthetic: true,
            group: 'quality',
            segments: ['quality', 'manifest:quality-entry'],
            id: 'manifest:quality-entry',
            describe: 'Commands from @kb-labs/quality are unavailable',
            schema: 'kb.adapter/1', manifestVersion: '1.0',
            loader: async () => { throw new Error('Cannot load'); },
          },
        ],
      },
    ];
    discover.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({
      plugins: {
        '@kb-labs/quality': { enabled: true, resolvedPath: '/test/workspace/plugins/{plugin}' },
      },
    });

    // dist/ does NOT exist
    const fsMock = await getFsMock();
    fsMock.access.mockRejectedValueOnce(new Error('ENOENT'));

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'quality report' });

    const result = readData<{ stages: Array<{ code: string; remediation?: string; details?: Record<string, unknown> }> }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'MANIFEST_LOAD_FAILED');
    expect(stage).toBeDefined();
    expect(stage?.remediation).toMatch(/pnpm.*build/);
    expect(stage?.details?.distExists).toBe(false);
  });

  it('reports COMMAND_PATH_MISSING with available paths when leaf not in manifest', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['workflow', 'rum'], suggestions: [] });

    const discover = await getDiscoverMock();
    const discovered = [
      {
        packageName: '@kb-labs/workflow-entry',
        manifestPath: '/test/dist/manifest.js',
        pkgRoot: '/test',
        source: 'workspace',
        scope: 'platform',
        manifests: [
          { _synthetic: false, group: 'workflow', segments: ['workflow', 'run'],   id: 'run',   describe: 'Run a workflow',  schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() },
          { _synthetic: false, group: 'workflow', segments: ['workflow', 'list'],  id: 'list',  describe: 'List workflows', schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() },
          { _synthetic: false, group: 'workflow', segments: ['workflow', 'abort'], id: 'abort', describe: 'Abort workflow', schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() },
        ],
      },
    ];
    discover.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({
      plugins: { '@kb-labs/workflow-entry': { enabled: true, resolvedPath: '/test' } },
    });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'workflow rum' });

    const result = readData<{ stages: Array<{ code: string; details?: { availablePaths?: string[] } }> }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'COMMAND_PATH_MISSING');
    expect(stage).toBeDefined();
    expect(stage?.details?.availablePaths).toContain('workflow run');
    expect(stage?.details?.availablePaths).toContain('workflow list');
  });

  it('reports MANIFEST_STRUCT_INVALID with per-command reasons from preflight', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['myplug', 'go'], suggestions: [] });

    const discover = await getDiscoverMock();
    const discovered = [
      {
        packageName: '@kb-labs/myplug',
        manifestPath: '/test/dist/manifest.js',
        pkgRoot: '/test',
        source: 'workspace',
        scope: 'platform',
        manifests: [
          // Non-synthetic but structurally invalid (missing describe)
          { _synthetic: false, group: 'myplug', segments: ['myplug', 'go'], id: 'go', describe: '', schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() },
        ],
      },
    ];
    discover.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const { preflightManifests } = await import('../../registry/register.js');
    (preflightManifests as ReturnType<typeof vi.fn>).mockReturnValue({
      valid: [],
      skipped: [{ id: 'myplug go', source: 'workspace', reason: 'Missing describe in manifest myplug go' }],
    });

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({
      plugins: { '@kb-labs/myplug': { enabled: true, resolvedPath: '/test' } },
    });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'myplug go' });

    const result = readData<{
      stages: Array<{ code: string; details?: { failures?: Array<{ command: string; reason: string }> } }>;
    }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'MANIFEST_STRUCT_INVALID');
    expect(stage).toBeDefined();
    expect(stage?.details?.failures?.[0]?.reason).toContain('Missing describe');
  });

  it('reports PLUGIN_BLOCKLISTED when discovery blocked the plugin by plugins.block', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['blocked', 'cmd'], suggestions: [] });

    const discover = await getDiscoverMock();
    discover.discoverManifests.mockResolvedValue([]);
    discoverState.diagnostics = [{
      severity: 'info',
      code: 'PLUGIN_BLOCKED',
      message: 'Plugin "@x/blocked" is blocked by plugins.block',
      context: { pluginId: '@x/blocked', entityId: '@x/blocked' },
      remediation: 'Remove it from plugins.block in .kb/kb.config.json',
      ts: 0,
    }];
    await setDiscoveryResult([], discoverState.diagnostics);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({ plugins: {} });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    try {
      await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'blocked cmd' });
    } finally {
      discoverState.diagnostics = [];
    }

    const result = readData<{ stages: Array<{ code: string }> }> (jsonSpy);
    expect(result.stages.find(s => s.code === 'PLUGIN_BLOCKLISTED')).toBeDefined();
  });

  it('reports PATH_MISSING when resolvedPath does not exist on filesystem', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['state', 'get'], suggestions: [] });

    const discover = await getDiscoverMock();
    const discovered = [
      {
        packageName: '@kb-labs/state',
        manifestPath: '/missing/dist/manifest.js',
        pkgRoot: '/missing',
        source: 'workspace',
        scope: 'platform',
        manifests: [
          { _synthetic: false, group: 'state', segments: ['state', 'get'], id: 'get', describe: 'Get state', schema: 'kb.adapter/1', manifestVersion: '1.0', loader: vi.fn() },
        ],
      },
    ];
    discover.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({
      plugins: { '@kb-labs/state': { enabled: true, resolvedPath: '/missing/node_modules/@kb-labs/state' } },
    });

    // resolvedPath does not exist
    const fsMock = await getFsMock();
    fsMock.access.mockRejectedValue(new Error('ENOENT'));

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'state get' });

    const result = readData<{ stages: Array<{ code: string; remediation?: string }> }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'PATH_MISSING');
    expect(stage).toBeDefined();
    expect(stage?.remediation).toMatch(/pnpm install/);
  });

  it('verdict is the last item in chain and summarises root cause', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'command',
      command: {
        manifest: { segments: ['review', 'run'] },
        available: false,
        unavailableReason: 'Missing dependency: @kb-labs/review-engine',
        hint: 'pnpm add @kb-labs/review-engine',
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/review',
      },
      rest: [],
    });

    const chainSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ chain: chainSpy }), [], { command: 'review run' });

    expect(chainSpy).toHaveBeenCalledOnce();
    const items = chainSpy.mock.calls[0]?.[0] as Array<{ title: string; status: string }>;
    const verdict = items[items.length - 1];
    expect(verdict?.title).toBe('verdict');
    expect(verdict?.status).toBe('error');
  });

  it('--json output has stages[] and verdict with rootCause + remediation', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'command',
      command: {
        manifest: { segments: ['review', 'run'] },
        available: false,
        unavailableReason: 'Missing dependency: @kb-labs/review-engine',
        hint: 'pnpm add @kb-labs/review-engine',
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/review',
      },
      rest: [],
    });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'review run' });

    const result = readData<{
      ok: boolean;
      command: string;
      stages: unknown[];
      verdict: { rootCause: string; remediation?: string };
    }> (jsonSpy);
    expect(result.command).toBe('review run');
    expect(Array.isArray(result.stages)).toBe(true);
    expect(result.verdict.rootCause).toBe('REQUIRES_MISSING');
    expect(result.verdict.remediation).toBe('pnpm add @kb-labs/review-engine');
  });
});

// ── Tests: review-fix coverage ───────────────────────────────────────────────

describe('diag --command (review-fix scenarios)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCollectorInstance.getEvents.mockReturnValue([]);
    // Reset mocks that earlier tests may have overridden back to their defaults
    const { preflightManifests } = await import('../../registry/register.js') as unknown as { preflightManifests: ReturnType<typeof vi.fn> };
    preflightManifests.mockReturnValue({ valid: [], skipped: [] });
    const discoverMod = await import('../../registry/discover.js') as unknown as { discoverManifests: ReturnType<typeof vi.fn> };
    discoverMod.discoverManifests.mockResolvedValue([]);
  });

  it('reports NOT_IN_MARKETPLACE (info) when registry OK but plugin not in lock', async () => {
    // Registry confirms command is available — lock absence is fine for dev
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'command',
      command: {
        manifest: { segments: ['myplug', 'run'] },
        available: true,
        shadowed: false,
        source: 'workspace',
        packageName: '@kb-labs/myplug',
      },
      rest: [],
    });

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({ plugins: {} }); // no entry for myplug

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    const code = await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'myplug run' });

    // Command works — ok: true despite no lock entry
    expect(code).toBe(0);
    const result = readData<{ status: string; stages: Array<{ code: string; status: string }> }> (jsonSpy);
    expect(result.status).toBe('healthy');
    const lockStage = result.stages.find(s => s.code === 'NOT_IN_MARKETPLACE');
    expect(lockStage).toBeDefined();
    expect(lockStage?.status).toBe('info');
  });

  it('reports NO_LOCK as warning when registry not OK and no lock file', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['missingplug', 'cmd'], suggestions: [] });

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue(null); // no marketplace.lock at all

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    const code = await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'missingplug cmd' });

    expect(code).toBe(0);
    const result = readData<{ status: string; stages: Array<{ code: string; status: string }> }> (jsonSpy);
    expect(result.status).toBe('degraded');
    const lockStage = result.stages.find(s => s.code === 'NO_LOCK');
    expect(lockStage).toBeDefined();
    expect(lockStage?.status).toBe('warning');
  });

  it('shows "and N more" when plugin has more than 5 commands', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['bigplug', 'typo'], suggestions: [] });

    const discoverMod = await getDiscoverMock() as { discoverManifests: ReturnType<typeof vi.fn> };
    const manyCommands = Array.from({ length: 8 }, (_, i) => ({
      _synthetic: false,
      group: 'bigplug',
      segments: ['bigplug', `cmd${i}`],
      id: `cmd${i}`,
      describe: `Command ${i}`,
      schema: 'kb.adapter/1', manifestVersion: '1.0' as const,
      loader: vi.fn(),
    }));
    // reset to clear any previous mockResolvedValue, then set fresh
    discoverMod.discoverManifests.mockReset();
    const discovered = [{
      packageName: '@kb-labs/bigplug',
      manifestPath: '/test/dist/manifest.js',
      pkgRoot: '/test',
      source: 'workspace' as const,
      scope: 'platform' as const,
      manifests: manyCommands,
    }];
    discoverMod.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({ plugins: { '@kb-labs/bigplug': { enabled: true, resolvedPath: '/test' } } });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'bigplug typo' });

    const result = readData<{ stages: Array<{ code: string; remediation?: string }> }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'COMMAND_PATH_MISSING');
    expect(stage).toBeDefined();
    expect(stage?.remediation).toMatch(/and 3 more/);
    expect(stage?.remediation).toMatch(/\(8\)/); // total count shown
  });

  it('reports GROUP_EXISTS_LEAF_MISSING when registry finds group but not the leaf', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({
      type: 'group',
      segments: ['workflow'],
      describe: 'Workflow commands',
      childKeys: ['run', 'list', 'abort'],
    });

    const lockMock = await getLockMock();
    lockMock.mockResolvedValue({ plugins: {} });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'workflow nonexistentleaf' });

    const result = readData<{ stages: Array<{ code: string; details?: Record<string, unknown> }> }> (jsonSpy);
    const stage = result.stages.find(s => s.code === 'GROUP_EXISTS_LEAF_MISSING');
    expect(stage).toBeDefined();
    expect(stage?.details?.availableChildren).toEqual(['run', 'list', 'abort']);
  });

  it('reports FS_NO_PATH info when lock entry has no resolvedPath', async () => {
    const reg = await getRegistryMock();
    reg.resolve.mockReturnValue({ type: 'not-found', input: ['nopathplug', 'run'], suggestions: [] });

    const discover = await getDiscoverMock();
    const discovered = [{
      packageName: '@kb-labs/nopathplug',
      manifestPath: '/test/dist/manifest.js',
      pkgRoot: '/test',
      source: 'workspace',
      scope: 'platform',
      manifests: [{ _synthetic: false, group: 'nopathplug', segments: ['nopathplug', 'run'], id: 'run', describe: 'Run', schema: 'kb.adapter/1', manifestVersion: '1.0' as const, loader: vi.fn() }],
    }];
    discover.discoverManifests.mockResolvedValue(discovered);
    await setDiscoveryResult(discovered);

    const lockMock = await getLockMock();
    // Entry exists but resolvedPath is empty string
    lockMock.mockResolvedValue({ plugins: { '@kb-labs/nopathplug': { enabled: true, resolvedPath: '' } } });

    const jsonSpy = vi.fn();
    const diag = await getDiag();
    await diag.run(makeCtx({ json: jsonSpy }), [], { json: true, command: 'nopathplug run' });

    const result = readData<{ stages: Array<{ code: string; status: string; stage: string }> }> (jsonSpy);
    const fsStage = result.stages.find(s => s.stage === 'filesystem');
    expect(fsStage?.code).toBe('FS_NO_PATH');
    expect(fsStage?.status).toBe('info');
  });
});

// ── Tests: flag metadata ──────────────────────────────────────────────────────

describe('diag --command flag metadata', () => {
  it('is declared with type string', async () => {
    const diag = await getDiag();
    const flags = (diag as unknown as { flags?: Array<{ name: string; type: string }> }).flags ?? [];
    const commandFlag = flags.find(f => f.name === 'command');
    expect(commandFlag?.type).toBe('string');
  });
});
