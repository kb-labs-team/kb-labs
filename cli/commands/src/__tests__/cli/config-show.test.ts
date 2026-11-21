/**
 * Unit tests for the `config show` command.
 *
 * `loadPlatformConfig` is mocked so tests run without touching the real
 * filesystem/workspace resolution — we only exercise the row-building,
 * provenance, and redaction logic in `show.ts`.
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noopUI, noopTraceContext } from '@kb-labs/plugin-contracts';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';
import { openCatalog as openCatalogWithVersion } from '@kb-labs/core-registry';
import { setResolvedCatalog } from '../../registry/discovery-state.js';

type LoadPlatformConfigResult = {
  platformConfig: Record<string, unknown>;
  rawConfig?: Record<string, unknown>;
  rawPlatformConfig?: Record<string, unknown>;
  effectiveConfig?: Record<string, unknown>;
  platformRoot: string;
  projectRoot: string;
  sameLocation: boolean;
  sources: {
    platformDefaults?: string;
    projectConfig?: string;
    roots: unknown;
    fields?: Record<string, 'platform' | 'project' | 'both'>;
    ignoredProjectFields?: string[];
  };
};

const loadPlatformConfigMock = vi.fn<() => Promise<LoadPlatformConfigResult>>();
const sharedConfigMock = vi.hoisted(() => ({
  resolveConfigRoots: vi.fn(),
  manifestSettingsLayers: vi.fn(() => []),
  renderErrorEnvelope: vi.fn(),
}));

vi.mock('@kb-labs/core-runtime', () => ({
  loadPlatformConfig: (...args: unknown[]) => loadPlatformConfigMock(),
}));

vi.mock('../../commands/system/config/shared.js', () => sharedConfigMock);

function makeCtx(overrides: Partial<PluginContextV3['ui']> = {}): PluginContextV3 {
  return {
    host: 'cli',
    requestId: 'test-config-show',
    pluginId: '@kb-labs/system',
    pluginVersion: '1.0.0',
    cwd: '/test/workspace',
    ui: {
      ...noopUI,
      ...overrides,
    },
    platform: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } } as never,
    runtime: { fs: {} as never, fetch: vi.fn(), env: vi.fn() },
    api: {} as never,
    hostContext: { host: 'cli' as const, binaryName: 'kb', argv: [], flags: {} },
    trace: noopTraceContext,
  };
}

function readData<T>(jsonSpy: ReturnType<typeof vi.fn>): T {
  const envelope = jsonSpy.mock.calls[0]?.[0] as { ok?: boolean; data?: T };
  expect(envelope).toMatchObject({ ok: true, data: expect.anything() });
  return envelope.data as T;
}

async function getConfigShow() {
  const { configShow } = await import('../../commands/system/config/show.js');
  return configShow;
}

// ── Split-root scenario: platform owns most fields, project adds `services` ────

function splitRootResult(overrides: Partial<LoadPlatformConfigResult> = {}): LoadPlatformConfigResult {
  return {
    platformConfig: {
      adapters: { llm: '@kb-labs/adapters-llm-openai' },
      execution: { mode: 'worker-pool' },
      adapterOptions: { llm: { apiKey: 'fake-test-value-1' } },
    },
    rawConfig: { platform: { dir: '~/kb-platform-demo' }, services: { studio: true } },
    rawPlatformConfig: { platform: '~/kb-platform-demo', services: { studio: true }, plugins: { review: true } },
    effectiveConfig: { platform: { dir: '~/kb-platform-demo' }, services: { studio: true } },
    platformRoot: '/platform-root',
    projectRoot: '/project-root',
    sameLocation: false,
    sources: {
      platformDefaults: '/platform-root/.kb/kb.config.jsonc',
      projectConfig: '/project-root/.kb/kb.config.jsonc',
      roots: {},
      fields: {
        adapters: 'platform',
        execution: 'platform',
        adapterOptions: 'platform',
      },
      ignoredProjectFields: undefined,
    },
    ...overrides,
  };
}

const openCatalog = (
  scope: Parameters<typeof openCatalogWithVersion>[0],
  options: Omit<Parameters<typeof openCatalogWithVersion>[1], 'resolvePlatformVersion'> = {},
) => openCatalogWithVersion(scope, { ...options, resolvePlatformVersion: async () => 'test' });

describe('config show', () => {
  let testRoot: string;
  let testCatalog: Awaited<ReturnType<typeof openCatalog>> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    testRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-config-show-'));
    testCatalog = await openCatalog({ platformRoot: testRoot, projectRoot: testRoot }, { persistSnapshot: false });
    setResolvedCatalog(testCatalog);
    sharedConfigMock.resolveConfigRoots.mockResolvedValue({
      platformRoot: '/platform-root',
      projectRoot: '/project-root',
      projectId: 'prj_config_show_test',
      sameLocation: false,
    });
  });

  afterEach(async () => {
    setResolvedCatalog(undefined);
    const openedCatalog = testCatalog;
    testCatalog = undefined;
    await openedCatalog?.dispose();
    await rm(testRoot, { recursive: true, force: true });
  });

  it('attributes platform-owned fields to "platform" and project-only fields to "project"', async () => {
    loadPlatformConfigMock.mockResolvedValue(splitRootResult());
    const configShow = await getConfigShow();
    const jsonSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy });

    const code = await configShow.run(ctx, [], { json: true });
    expect(code).toBe(0);

    const payload = readData<{ fields: Array<{ source: string; field: string; value: unknown }> }> (jsonSpy);
    const byField = new Map(payload.fields.map((r) => [r.field, r]));

    expect(byField.get('adapters.llm')?.source).toBe('platform');
    expect(byField.get('execution.mode')?.source).toBe('platform');
    expect(byField.get('services.studio')?.source).toBe('both');
    expect(byField.get('services.studio')?.value).toBe(true);
  });

  it('surfaces platform-only product config fields that the project file never mentions', async () => {
    // Regression test for the architect finding: buildRows previously sourced
    // non-CONFIG_FIELD_SCOPE top-level fields only from effectiveConfig
    // (== rawProjectConfig), which has no platform fallback. A field the
    // installer wrote into the platform-owned config (ADR-0013) but the
    // project file never mentions was invisible in `kb config show`.
    loadPlatformConfigMock.mockResolvedValue(splitRootResult());
    const configShow = await getConfigShow();
    const jsonSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy });

    await configShow.run(ctx, [], { json: true });
    const payload = readData<{ fields: Array<{ source: string; field: string; value: unknown }> }> (jsonSpy);
    const byField = new Map(payload.fields.map((r) => [r.field, r]));

    expect(byField.get('plugins.review')?.source).toBe('platform');
    expect(byField.get('plugins.review')?.value).toBe(true);
  });

  it('redacts sensitive field values in both table and json output', async () => {
    loadPlatformConfigMock.mockResolvedValue(splitRootResult());
    const configShow = await getConfigShow();
    const jsonSpy = vi.fn();
    const successSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy, success: successSpy });

    await configShow.run(ctx, [], { json: true });
    const payload = readData<{ fields: Array<{ field: string; value: unknown }> }> (jsonSpy);
    const apiKeyRow = payload.fields.find((r) => r.field === 'adapterOptions.llm.apiKey');
    expect(apiKeyRow?.value).toBe('***REDACTED***');

    await configShow.run(ctx, [], { json: false });
    const call = successSpy.mock.calls[0]?.[1] as { sections: Array<{ items: string[] }> };
    const lines = call.sections[0]?.items ?? [];
    expect(lines.some((l) => l.includes('***REDACTED***'))).toBe(true);
    expect(lines.some((l) => l.includes('fake-test-value-1'))).toBe(false);
  });

  it('marks a rejected platform-only override as "ignored" and shows the platform value', async () => {
    loadPlatformConfigMock.mockResolvedValue(
      splitRootResult({
        sources: {
          platformDefaults: '/platform-root/.kb/kb.config.jsonc',
          projectConfig: '/project-root/.kb/kb.config.jsonc',
          roots: {},
          fields: { adapters: 'platform', execution: 'platform', adapterOptions: 'platform' },
          ignoredProjectFields: ['execution'],
        },
      }),
    );
    const configShow = await getConfigShow();
    const jsonSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy });

    await configShow.run(ctx, [], { json: true });
    const payload = readData<{ fields: Array<{ source: string; field: string; value: unknown }> }> (jsonSpy);
    const ignoredRow = payload.fields.find((r) => r.field === 'execution.mode' && r.source === 'ignored');
    expect(ignoredRow?.value).toBe('worker-pool');
  });

  it('reports all fields as "both" in sameLocation mode (monorepo/dev)', async () => {
    // Regression test for the QA finding: the loader itself reports
    // sameLocation fields as 'platform' (see config-loader.ts's samePath
    // branch — there's no second layer to merge against, so
    // mergeWithFieldPolicy has nothing to call 'both'). A prior version of
    // this test mocked the loader as already returning 'both', which mocked
    // around the bug instead of catching it: buildRows was passing that
    // 'platform' label straight through to the user, misleadingly implying
    // the project layer had no say over a field that lives in the one file
    // that IS both platform and project. Mock the loader's *real* output
    // ('platform') so this test actually exercises buildRows's sameLocation
    // normalization instead of asserting on a value it was just handed.
    loadPlatformConfigMock.mockResolvedValue({
      platformConfig: {
        adapters: { llm: '@kb-labs/adapters-llm-openai' },
      },
      rawConfig: { services: { studio: true } },
      effectiveConfig: { services: { studio: true } },
      platformRoot: '/repo',
      projectRoot: '/repo',
      sameLocation: true,
      sources: {
        roots: {},
        fields: { adapters: 'platform' },
        ignoredProjectFields: undefined,
      },
    });
    const configShow = await getConfigShow();
    const jsonSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy });

    await configShow.run(ctx, [], { json: true });
    const payload = readData<{ fields: Array<{ source: string; field: string }> }> (jsonSpy);
    const byField = new Map(payload.fields.map((r) => [r.field, r]));
    expect(byField.get('adapters.llm')?.source).toBe('both');
    expect(byField.get('services.studio')?.source).toBe('both');
    expect(payload.fields.every((r) => r.source !== 'ignored')).toBe(true);
  });

  it('redacts sensitive keys nested inside array elements, not just the leaf field name', async () => {
    // Regression test for the QA-reported critical secret leak: `flatten`
    // stops recursing at arrays and keeps them as a single leaf (e.g.
    // `adapterOptions.llm.tierMapping`, this repo's own real config shape —
    // a map of tier name -> array of adapter-routing entries). redactLeaf
    // previously only checked the leaf's own dotted path for a sensitive
    // segment, so a secret key buried inside an array element (e.g. a
    // per-entry apiKey) was serialized in plaintext even though the field
    // name "tierMapping" itself isn't sensitive.
    loadPlatformConfigMock.mockResolvedValue(
      splitRootResult({
        platformConfig: {
          adapters: { llm: '@kb-labs/adapters-llm-openai' },
          execution: { mode: 'worker-pool' },
          adapterOptions: {
            llm: {
              tierMapping: {
                small: [
                  { adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', apiKey: 'fake-test-value-3' },
                ],
                large: [
                  { adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-opus', credentials: { token: 'fake-test-value-4' } },
                ],
              },
            },
          },
        },
      }),
    );
    const configShow = await getConfigShow();
    const jsonSpy = vi.fn();
    const ctx = makeCtx({ json: jsonSpy });

    await configShow.run(ctx, [], { json: true });
    const payload = readData<{ fields: Array<{ field: string; value: unknown }> }> (jsonSpy);
    // `tierMapping` is an object keyed by tier name whose values are the
    // arrays (matching this repo's real .kb/kb.config.json shape) — flatten
    // recurses through the object down to each per-tier array, which is
    // where it stops (arrays are leaves).
    const smallRow = payload.fields.find((r) => r.field === 'adapterOptions.llm.tierMapping.small');
    const largeRow = payload.fields.find((r) => r.field === 'adapterOptions.llm.tierMapping.large');
    expect(smallRow).toBeDefined();
    expect(largeRow).toBeDefined();

    const serialized = JSON.stringify([smallRow?.value, largeRow?.value]);
    expect(serialized).not.toContain('fake-test-value-3');
    expect(serialized).not.toContain('fake-test-value-4');
    expect(serialized).toContain('***REDACTED***');
    // Non-sensitive sibling data inside the same array must survive redaction.
    expect(serialized).toContain('gpt-4o-mini');
    expect(serialized).toContain('@kb-labs/adapters-vibeproxy');
  });
});
