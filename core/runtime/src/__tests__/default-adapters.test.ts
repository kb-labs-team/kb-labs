import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspacePackages } from '@kb-labs/core-discovery';
import { loadAdapterManifest } from '@kb-labs/core-platform';
import type { AdapterManifest } from '@kb-labs/core-platform';
import { validatePlatformAdapterOptions } from '@kb-labs/core-config';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { configuredAdapterForSlot, projectEffectiveAdapterImplementation, resolveDiscoveredAdapterDefaults } from '../default-adapters.js';
import { loadCatalogAdapterEntries, loadDiscoveredAdapterModule } from '../adapter-module-loader.js';
import { ADAPTER_CONFIG_KEYS } from '../config.js';
import type { DiscoveredAdapter } from '../discover-adapters.js';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const adapterProjectionCases: Array<{ slot: string; key: string | undefined; projection: 'package' | 'composite' }> =
  Object.entries(ADAPTER_CONFIG_KEYS).reduce((cases, [slot, mapping]) => {
    if (mapping.keys.length === 0) {cases.push({ slot, key: undefined, projection: mapping.projection });}
    for (const key of mapping.keys) {cases.push({ slot, key, projection: mapping.projection });}
    return cases;
  }, [] as Array<{ slot: string; key: string | undefined; projection: 'package' | 'composite' }>);

describe('projectEffectiveAdapterImplementation', () => {
  it.each(adapterProjectionCases)('projects $slot from mapped key $key', ({ slot, key, projection }) => {
    const configured = '@kb-labs/adapters-selected';
    const staleHost = '@kb-labs/adapters-stale';
    const host = projection === 'composite' ? 'HybridLogReader' : staleHost;
    const adapters = key === undefined ? {} : { [key]: configured };
    const result = projectEffectiveAdapterImplementation(slot, adapters, host);
    expect(result).toBe(projection === 'package' && key !== undefined ? configured : host);
    if (projection === 'package' && key !== undefined) {
      expect(projectEffectiveAdapterImplementation(slot, adapters, undefined, '@kb-labs/adapters-default'))
        .toBe(configured);
    }
  });
});

async function workspaceAdapterManifests(): Promise<Map<string, AdapterManifest>> {
  const packages = await findWorkspacePackages(workspaceRoot);
  const manifests = new Map<string, AdapterManifest>();

  for (const candidate of packages) {
    const result = await loadAdapterManifest({ packageRoot: candidate.packageRoot });
    if (result.kind === 'failed') {
      expect(result.reason, `${candidate.packageName} must declare networkRequired`).not.toBe('adapter manifest must declare networkRequired as a boolean');
      continue;
    }
    if (result.kind === 'not-adapter') {continue;}
    expect(result.manifest.configSchema, `${candidate.packageName} must declare configSchema`).toBeDefined();
    expect(result.manifest.networkRequired, `${candidate.packageName} must declare networkRequired`).toBeTypeOf('boolean');
    for (const [slot, entrypoint] of Object.entries(result.manifest.defaultFor ?? {})) {
      expect(Array.isArray(entrypoint), `${candidate.packageName} defaultFor ${slot} must declare path segments`).toBe(true);
      expect(entrypoint.every(segment => segment.length > 0 && segment !== '.' && segment !== '..'), `${candidate.packageName} defaultFor ${slot} must use package path segments`).toBe(true);
      expect(configuredAdapterForSlot(slot, {}), `${candidate.packageName} defaultFor ${slot} must resolve through the platform config mapping`).toBeDefined();
    }
    manifests.set(candidate.packageName, result.manifest);
  }

  expect(manifests.size).toBeGreaterThan(0);
  return manifests;
}

async function makePlatformRoot(): Promise<string> {
  const platformRoot = await mkdtemp(path.join(tmpdir(), 'kb-adapter-schema-'));
  const scopePath = path.join(platformRoot, 'node_modules', '@kb-labs');
  await mkdir(scopePath, { recursive: true });
  const packages = await findWorkspacePackages(workspaceRoot);
  for (const candidate of packages) {
    if ((await loadAdapterManifest({ packageRoot: candidate.packageRoot })).kind !== 'adapter') {continue;}
    await symlink(candidate.packageRoot, path.join(scopePath, candidate.packageName.slice('@kb-labs/'.length)));
  }
  return platformRoot;
}

function discovered(packageName: string, fields: Pick<AdapterManifest, 'implements'> & Partial<AdapterManifest>): DiscoveredAdapter {
  const manifest: AdapterManifest = {
    schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: packageName, name: packageName,
    version: '1.0.0', type: 'core', networkRequired: false, ...fields,
  };
  return {
    packageName,
    pkgRoot: `/platform/node_modules/${packageName}`,
    createAdapter: () => ({}),
    module: { manifest },
    entrypointManifests: Object.fromEntries([['', manifest], ...Object.values(manifest.defaultFor ?? {})
      .map((entrypoint) => [entrypoint.join('/'), manifest])]),
  };
}

describe('resolveDiscoveredAdapterDefaults', () => {
  // case: S-054.1
  it('validates resolved default options against every real workspace adapter manifest', async () => {
    const manifests = await workspaceAdapterManifests();
    expect(manifests.get('@kb-labs/adapters-log-ringbuffer')?.configSchema).toMatchObject({
      maxSize: { type: 'number', integer: true, minimum: 1 },
      ttl: { type: 'number', integer: true, minimum: 0 },
    });
    expect(manifests.get('@kb-labs/adapters-service-transport-http')?.configSchema).toMatchObject({
      services: { type: 'object', required: true },
      offset: { type: 'number' },
    });
    expect(manifests.get('@kb-labs/adapters-fs')?.configSchema?.baseDir?.defaultPath)
      .toEqual({ root: 'projectState', segments: ['storage'] });
    expect(manifests.get('@kb-labs/adapters-sqlite')?.configSchema?.filename?.defaultPath)
      .toEqual({ root: 'projectState', segments: ['database', 'kb.sqlite'] });
    expect(manifests.get('@kb-labs/adapters-analytics-sqlite')?.configSchema?.dbPath?.defaultPath)
      .toEqual({ root: 'projectState', segments: ['analytics', 'analytics.sqlite'] });
    expect(manifests.get('@kb-labs/adapters-log-ringbuffer')?.configSchema?.maxSize?.default).toBe(100);
    const discovered = new Map<string, DiscoveredAdapter>();
    for (const [packageName, manifest] of manifests) {
      discovered.set(packageName, {
        packageName,
        pkgRoot: path.join(workspaceRoot, 'node_modules', packageName),
        createAdapter: () => ({}),
        module: { manifest },
        entrypointManifests: Object.fromEntries([['', manifest], ...Object.values(manifest.defaultFor ?? {})
          .map((entrypoint) => [entrypoint.join('/'), manifest])]),
      });
    }

    const defaults = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} }, discovered, workspaceRoot);
    expect(Object.keys(defaults.adapterOptions).sort()).toEqual(Object.keys(defaults.adapters).sort());
    const platformRoot = await makePlatformRoot();
    try {
      const platformConfig: Record<string, unknown> = {
        adapters: defaults.adapters,
        adapterOptions: defaults.adapterOptions,
      };
      const issues = await validatePlatformAdapterOptions(platformRoot, platformConfig);
      expect(issues).toEqual([]);
    } finally {
      await rm(platformRoot, { recursive: true, force: true });
    }
  });

  it('uses installed manifest defaults, local data paths, and the SQLite KV entry point', () => {
    const sqlite = discovered('@kb-labs/adapters-sqlite', {
      defaultFor: { documentDatabase: [], kvStore: ['kv'] },
      schema: 'kb.adapter/1', implements: ['IDocumentDatabase', 'IKVStore'],
      configSchema: { filename: { type: 'string', defaultPath: { root: 'projectState', segments: ['database', 'kb.sqlite'] } } },
    });
    const storage = discovered('@kb-labs/adapters-fs', {
      defaultFor: { storage: [] }, schema: 'kb.adapter/1', implements: 'IStorage',
      configSchema: { baseDir: { type: 'string', defaultPath: { root: 'projectState', segments: ['storage'] } } },
    });
    const resolved = resolveDiscoveredAdapterDefaults({
      adapters: {}, adapterOptions: { storage: { baseDir: 'user/data' } },
    }, new Map([
      [sqlite.packageName, sqlite],
      [storage.packageName, storage],
    ]), '/project');

    expect(resolved.adapters).toEqual({
      documentDatabase: '@kb-labs/adapters-sqlite',
      kvStore: '@kb-labs/adapters-sqlite/kv',
      storage: '@kb-labs/adapters-fs',
    });
    expect(resolved.adapterOptions).toEqual({
      storage: { baseDir: 'user/data' },
      documentDatabase: { filename: resolveRuntimeStatePath('/project', ['database', 'kb.sqlite']) },
      kvStore: { filename: resolveRuntimeStatePath('/project', ['database', 'kb.sqlite']) },
    });
  });

  it('rejects a manifest default when its slot has no package config key', () => {
    const mapping = Object.entries(ADAPTER_CONFIG_KEYS).find(([, entry]) =>
      entry.projection === 'package' && entry.keys.length === 0,
    );
    expect(mapping).toBeDefined();
    const slot = mapping![0];
    const invalidDefault = discovered('@kb-labs/adapters-invalid-default', {
      defaultFor: { [slot]: [] }, schema: 'kb.adapter/1', implements: 'IStorage',
    });

    expect(() => resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} }, new Map([
      [invalidDefault.packageName, invalidDefault],
    ]), '/project')).toThrow(`Adapter ${invalidDefault.packageName} declares ${slot} as a default, but that slot has no package config key.`);
  });

  it('resolves declared option defaults for explicitly selected installed adapters', () => {
    const storage = discovered('@kb-labs/adapters-fs', {
      defaultFor: { storage: [] },
      schema: 'kb.adapter/1', implements: 'IStorage',
      configSchema: { baseDir: { type: 'string', defaultPath: { root: 'projectState', segments: ['storage'] } } },
    });
    const resolved = resolveDiscoveredAdapterDefaults({
      adapters: { storage: '@kb-labs/adapters-fs' }, adapterOptions: {},
    }, new Map([[storage.packageName, storage]]), '/project');

    expect(resolved.adapters.storage).toBe('@kb-labs/adapters-fs');
    expect(resolved.adapterOptions.storage).toEqual({
      baseDir: resolveRuntimeStatePath('/project', ['storage']),
    });
  });

  it('preserves explicit options stored under a mapped config key for a manifest default', () => {
    const workspaceProvider = discovered('@kb-labs/adapters-workspace-localfs', {
      defaultFor: { workspaceProvider: [] },
      schema: 'kb.adapter/1', implements: 'IWorkspaceProvider',
      configSchema: { rootDir: { type: 'string', default: '/default/workspaces' } },
    });
    const resolved = resolveDiscoveredAdapterDefaults({
      adapters: {}, adapterOptions: { workspace: { rootDir: '/custom/workspaces' } },
    }, new Map([[workspaceProvider.packageName, workspaceProvider]]), '/project');

    expect(resolved.adapters.workspace).toBe('@kb-labs/adapters-workspace-localfs');
    expect(resolved.adapterOptions.workspace).toEqual({ rootDir: '/custom/workspaces' });
  });

  it('resolves multi-entry defaults from the real SQLite and OpenAI manifests', async () => {
    const manifests = await workspaceAdapterManifests();
    const sqliteManifest = manifests.get('@kb-labs/adapters-sqlite');
    const openaiManifest = manifests.get('@kb-labs/adapters-openai');
    if (!sqliteManifest || !openaiManifest) {
      throw new Error('workspace must include the shipped SQLite and OpenAI adapter manifests');
    }
    expect(sqliteManifest?.defaultFor).toEqual({
      documentDatabase: [],
      kvStore: ['kv'],
      vectorStore: ['vector-store'],
    });
    expect(openaiManifest?.defaultFor).toEqual({
      llm: ['llm'],
      embeddings: ['embeddings'],
    });

    const sqlite = discovered('@kb-labs/adapters-sqlite', sqliteManifest);
    const openai = discovered('@kb-labs/adapters-openai', openaiManifest);
    const resolved = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} }, new Map([
      [sqlite.packageName, sqlite],
      [openai.packageName, openai],
    ]), '/project');

    expect(resolved.adapters).toEqual({
      documentDatabase: '@kb-labs/adapters-sqlite',
      kvStore: '@kb-labs/adapters-sqlite/kv',
      vectorStore: '@kb-labs/adapters-sqlite/vector-store',
      llm: '@kb-labs/adapters-openai/llm',
      embeddings: '@kb-labs/adapters-openai/embeddings',
    });

    const secondMultiEntryAdapter = discovered('@kb-labs/adapters-second-multi', {
      defaultFor: { cache: ['cache'], vectorStore: ['vector'] },
      implements: ['ICache', 'IVectorStore'],
    });
    const secondDefaults = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} }, new Map([
      [secondMultiEntryAdapter.packageName, secondMultiEntryAdapter],
    ]), '/project');
    expect(secondDefaults.adapters).toEqual({
      cache: '@kb-labs/adapters-second-multi/cache',
      vectorStore: '@kb-labs/adapters-second-multi/vector',
    });
  });

  it('resolves OpenAI slot defaults from each real entrypoint manifest', async () => {
    const packageRoot = path.join(workspaceRoot, 'adapters/openai');
    const loadedManifest = await loadAdapterManifest({ packageRoot });
    if (loadedManifest.kind !== 'adapter') {
      throw new Error('workspace OpenAI package must provide an adapter manifest');
    }
    const discoveredAdapters = await loadCatalogAdapterEntries(new Map([['@kb-labs/adapters-openai', {
      id: '@kb-labs/adapters-openai',
      packageRoot,
      source: 'marketplace',
      manifest: loadedManifest,
    }]]), { development: false, configuredPackages: [] });
    const openai = discoveredAdapters.get('@kb-labs/adapters-openai');
    if (!openai) {throw new Error('workspace OpenAI package must load from the adapter catalog');}
    const llmModule = await loadDiscoveredAdapterModule(openai, '@kb-labs/adapters-openai/llm');
    const embeddingsModule = await loadDiscoveredAdapterModule(openai, '@kb-labs/adapters-openai/embeddings');
    const resolved = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} },
      new Map([[openai.packageName, openai]]), '/project');

    expect(resolved.adapterOptions.llm).toMatchObject({ model: 'gpt-4o' });
    expect(resolved.adapterOptions.embeddings).toMatchObject({
      model: 'text-embedding-3-small',
    });
    const requestModels: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {chunks.push(Buffer.from(chunk));}
      requestModels.push((JSON.parse(Buffer.concat(chunks).toString()) as { model: unknown }).model);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {throw new Error('test server did not bind a TCP port');}
    const embeddingsOptions = resolved.adapterOptions.embeddings;
    if (typeof embeddingsOptions !== 'object' || embeddingsOptions === null || Array.isArray(embeddingsOptions)) {
      throw new Error('resolved embeddings defaults must be an object');
    }
    const client = await embeddingsModule.createAdapter({
      ...embeddingsOptions,
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }, {});
    try {
      const embeddings = client as {
        embed(text: string): Promise<number[]>;
        getDimensions(): Promise<number>;
      };
      expect(await embeddings.getDimensions()).toBe(1536);
      await embeddings.embed('slot-scoped default');
      expect(requestModels).toEqual(['text-embedding-3-small']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('defaults every persistent built-in adapter path under the machine project state directory', () => {
    const previousHome = process.env.KB_HOME;
    process.env.KB_HOME = '/machine/kb';
    try {
      const sqlite = discovered('@kb-labs/adapters-sqlite', {
        defaultFor: { documentDatabase: [], kvStore: ['kv'] },
        schema: 'kb.adapter/1', implements: ['IDocumentDatabase', 'IKVStore'],
        configSchema: { filename: { type: 'string', defaultPath: { root: 'projectState', segments: ['database', 'kb.sqlite'] } } },
      });
      const storage = discovered('@kb-labs/adapters-fs', {
        defaultFor: { storage: [] }, schema: 'kb.adapter/1', implements: 'IStorage',
        configSchema: { baseDir: { type: 'string', defaultPath: { root: 'projectState', segments: ['storage'] } } },
      });
      const analytics = discovered('@kb-labs/adapters-analytics-sqlite', {
        defaultFor: { analytics: [] }, schema: 'kb.adapter/1', implements: 'IAnalytics',
        configSchema: {
          dbPath: { type: 'string', defaultPath: { root: 'projectState', segments: ['analytics', 'analytics.sqlite'] } },
          retentionDays: { type: 'number', default: 90 },
        },
      });
      const ringbuffer = discovered('@kb-labs/adapters-log-ringbuffer', {
        defaultFor: { logRingBuffer: [] }, schema: 'kb.adapter/1', implements: 'ILogRingBuffer',
        configSchema: { maxSize: { type: 'number', default: 100 } },
      });
      const resolved = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} }, new Map([
        [sqlite.packageName, sqlite], [storage.packageName, storage], [analytics.packageName, analytics], [ringbuffer.packageName, ringbuffer],
      ]), '/project');

      expect(resolved.adapterOptions).toEqual({
        storage: { baseDir: resolveRuntimeStatePath('/project', ['storage']) },
        documentDatabase: { filename: resolveRuntimeStatePath('/project', ['database', 'kb.sqlite']) },
        kvStore: { filename: resolveRuntimeStatePath('/project', ['database', 'kb.sqlite']) },
        analytics: {
          dbPath: resolveRuntimeStatePath('/project', ['analytics', 'analytics.sqlite']),
          retentionDays: 90,
        },
        logRingBuffer: { maxSize: 100 },
      });
    } finally {
      if (previousHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousHome;
    }
  });

  it('keeps an explicit provider binding ahead of the discovered default', () => {
    const fallback = discovered('@kb-labs/adapters-analytics-sqlite', {
      defaultFor: { analytics: [] }, schema: 'kb.adapter/1', implements: 'IAnalytics',
    });
    const resolved = resolveDiscoveredAdapterDefaults({
      adapters: { analytics: '@kb-labs/adapters-analytics-custom' }, adapterOptions: {},
    }, new Map([[fallback.packageName, fallback]]), '/project');

    expect(resolved.adapters.analytics).toBe('@kb-labs/adapters-analytics-custom');
  });

  it('does not implicitly select a provider whose manifest requires configuration', () => {
    const configuredProvider = discovered('@kb-labs/adapters-service-transport-http', {
      defaultFor: { serviceTransport: [] },
      schema: 'kb.adapter/1', implements: 'IServiceTransport',
      configSchema: { services: { type: 'object', required: true } },
    });
    const resolved = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} },
      new Map([[configuredProvider.packageName, configuredProvider]]), '/project');

    expect(resolved.adapters).not.toHaveProperty('serviceTransport');
    expect(resolved.adapterOptions).not.toHaveProperty('serviceTransport');
  });

  it('allows a required secret credential with an environment source as an implicit default', () => {
    const openai = discovered('@kb-labs/adapters-openai', {
      defaultFor: { llm: ['llm'] },
      schema: 'kb.adapter/1', implements: 'ILLM',
      configSchema: {
        apiKey: { type: 'string', required: true, secret: true, env: 'OPENAI_API_KEY' },
        model: { type: 'string', default: 'gpt-4o' },
      },
    });
    const resolved = resolveDiscoveredAdapterDefaults({ adapters: {}, adapterOptions: {} },
      new Map([[openai.packageName, openai]]), '/project');

    expect(resolved.adapters.llm).toBe('@kb-labs/adapters-openai/llm');
  });
});

describe('workspace adapter manifest contract', () => {
  // case: S-179.17
  it('requires networkRequired on every workspace adapter discovered from the package graph', async () => {
    const manifests = await workspaceAdapterManifests();
    expect(manifests.size).toBeGreaterThan(0);
  });
});
