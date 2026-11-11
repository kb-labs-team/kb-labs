import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { EntityRegistry } from '../registry.js';
import { createHealthContributor } from '../health/health-aggregator.js';
import { writeMarketplaceLock, createEmptyLock, createMarketplaceEntry } from '@kb-labs/core-discovery';

async function createPluginDir(tmpDir: string, id: string, opts?: {
  commands?: number; routes?: number; workflows?: number;
}): Promise<string> {
  const pluginDir = path.join(tmpDir, 'plugins', id.replace('@kb-labs/', ''));
  await fs.mkdir(pluginDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    schema: 'kb.plugin/3',
    id,
    version: '1.0.0',
    display: { name: id, description: `Test plugin ${id}` },
  };
  if (opts?.commands) {
    manifest.cli = {
      commands: Array.from({ length: opts.commands }, (_, i) => ({
        path: `cmd-${i}`, describe: `Command ${i}`, handler: `./dist/cmd-${i}.js`,
      })),
    };
  }
  if (opts?.routes) {
    manifest.rest = {
      routes: Array.from({ length: opts.routes }, (_, i) => ({
        method: 'GET', path: `/api/${i}`, handler: `./dist/route-${i}.js`,
      })),
    };
  }
  if (opts?.workflows) {
    manifest.workflows = {
      handlers: Array.from({ length: opts.workflows }, (_, i) => ({
        id: `wf-${i}`, handler: `./dist/wf-${i}.js`,
      })),
    };
  }

  await fs.writeFile(path.join(pluginDir, 'kb.plugin.json'), JSON.stringify(manifest), 'utf-8');
  await fs.writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: id, version: '1.0.0',
  }), 'utf-8');

  return pluginDir;
}

async function computeIntegrity(dir: string): Promise<string> {
  const content = await fs.readFile(path.join(dir, 'package.json'));
  return `sha256-${crypto.createHash('sha256').update(content).digest('base64')}`;
}

describe('EntityRegistry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-registry-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('initializes empty when no lock file', async () => {
    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    expect(registry.listPlugins()).toEqual([]);
    expect(registry.queryEntities({})).toEqual([]);
    expect(registry.getEntityKinds()).toEqual([]);

    await registry.dispose();
  });

  it('discovers plugins from marketplace.lock', async () => {
    const pluginDir = await createPluginDir(tmpDir, '@kb-labs/test', { commands: 2 });
    const integrity = await computeIntegrity(pluginDir);

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/test'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/test',
      source: 'local', primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const plugins = registry.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.id).toBe('@kb-labs/test');

    const manifest = registry.getManifest('@kb-labs/test');
    expect(manifest).not.toBeNull();
    expect(manifest!.cli?.commands).toHaveLength(2);

    await registry.dispose();
  });

  it('queryEntities returns correct entities by kind', async () => {
    const pluginDir = await createPluginDir(tmpDir, '@kb-labs/multi', {
      commands: 2, routes: 3, workflows: 1,
    });
    const integrity = await computeIntegrity(pluginDir);

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/multi'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/multi',
      source: 'local', primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    expect(registry.queryEntities({ kind: 'cli-command' })).toHaveLength(2);
    expect(registry.queryEntities({ kind: 'rest-route' })).toHaveLength(3);
    expect(registry.queryEntities({ kind: 'workflow' })).toHaveLength(1);
    expect(registry.queryEntities({ kind: 'plugin' })).toHaveLength(1);

    await registry.dispose();
  });

  it('getEntity returns exact entity', async () => {
    const pluginDir = await createPluginDir(tmpDir, '@kb-labs/exact', { commands: 1 });
    const integrity = await computeIntegrity(pluginDir);

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/exact'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/exact',
      source: 'local', primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const entity = registry.getEntity({
      pluginId: '@kb-labs/exact', kind: 'cli-command', entityId: 'cmd-0',
    });
    expect(entity).not.toBeNull();
    expect(entity!.ref.entityId).toBe('cmd-0');

    expect(registry.getEntity({
      pluginId: '@kb-labs/exact', kind: 'cli-command', entityId: 'nonexistent',
    })).toBeNull();

    await registry.dispose();
  });

  it('snapshot produces valid registry/1 schema', async () => {
    const pluginDir = await createPluginDir(tmpDir, '@kb-labs/snap');
    const integrity = await computeIntegrity(pluginDir);

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/snap'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/snap',
      source: 'local', primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const snap = registry.snapshot();
    expect(snap.schema).toBe('kb.registry/2');
    expect(snap.plugins).toHaveLength(1);
    expect(snap.manifests).toHaveLength(1);
    expect(snap.partial).toBe(false);
    expect(snap.stale).toBe(false);
    expect(typeof snap.generatedAt).toBe('string');
    expect(typeof snap.ts).toBe('number');

    await registry.dispose();
  });

  it('getOpenAPISpec returns spec for plugin with REST routes', async () => {
    const pluginDir = await createPluginDir(tmpDir, '@kb-labs/api', { routes: 2 });
    const integrity = await computeIntegrity(pluginDir);

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/api'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/api',
      source: 'local', primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const spec = registry.getOpenAPISpec('@kb-labs/api');
    expect(spec).not.toBeNull();
    expect(spec!.openapi).toBe('3.1.0');
    expect(Object.keys(spec!.paths)).toHaveLength(2);

    expect(registry.getOpenAPISpec('@kb-labs/nonexistent')).toBeNull();

    await registry.dispose();
  });

  it('getStudioRegistry returns all plugins', async () => {
    const dir1 = await createPluginDir(tmpDir, '@kb-labs/studio-a', { commands: 1 });
    const dir2 = await createPluginDir(tmpDir, '@kb-labs/studio-b', { routes: 1 });

    const lock = createEmptyLock();
    for (const [id, dir] of [['@kb-labs/studio-a', dir1], ['@kb-labs/studio-b', dir2]] as const) {
      const integrity = await computeIntegrity(dir);
      lock.plugins[id] = createMarketplaceEntry({
        version: '1.0.0', integrity,
        resolvedPath: `./plugins/${id.replace('@kb-labs/', '')}`,
        source: 'local', primaryKind: 'plugin', provides: ['plugin'],
      });
    }
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const studioReg = registry.getStudioRegistry();
    expect(studioReg.plugins).toHaveLength(2);
    expect(studioReg.plugins.map(p => p.id).sort()).toEqual(['@kb-labs/studio-a', '@kb-labs/studio-b']);

    await registry.dispose();
  });

  it('getDiagnostics returns structured report', async () => {
    // Create lock pointing to non-existent plugin
    const lock = createEmptyLock();
    lock.plugins['@kb-labs/missing'] = createMarketplaceEntry({
      version: '1.0.0', integrity: 'sha256-x',
      package: '@kb-labs/missing',
      resolvedPath: './nonexistent',
      source: 'platform', primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const report = registry.getDiagnostics();
    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.summary.failedPlugins).toBeGreaterThan(0);
    expect(report.events.some(e => e.code === 'PACKAGE_NOT_FOUND')).toBe(true);

    await registry.dispose();
  });

  it('onChange notifies on refresh', async () => {
    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const diffs: unknown[] = [];
    registry.onChange(diff => diffs.push(diff));

    // Create a plugin after init
    const pluginDir = await createPluginDir(tmpDir, '@kb-labs/new');
    const integrity = await computeIntegrity(pluginDir);
    const lock = createEmptyLock();
    lock.plugins['@kb-labs/new'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/new',
      source: 'local', primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    await registry.refresh();

    expect(diffs).toHaveLength(1);
    expect((diffs[0] as any).added).toHaveLength(1);
    expect((diffs[0] as any).added[0].id).toBe('@kb-labs/new');

    await registry.dispose();
  });

  it('getManifest returns null for unknown plugin', async () => {
    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();
    expect(registry.getManifest('@kb-labs/unknown')).toBeNull();
    await registry.dispose();
  });

  it('adds execution health contributors to the shared snapshot and degrades the aggregate', async () => {
    const registry = new EntityRegistry({
      root: tmpDir,
      resolvePlatformVersion: async () => 'test',
      healthContributors: [createHealthContributor('execution', async () => ({
        healthy: false,
        executionMode: 'worker-pool',
        details: { workers: { total: 0, idle: 0, busy: 0, queued: 0, queueLimit: 10 } },
      }))],
    });
    await registry.initialize();
    const snapshot = await registry.getSystemHealth();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.components).toContainEqual({ id: 'execution', status: 'degraded', details: { workers: { total: 0, idle: 0, busy: 0, queued: 0, queueLimit: 10 }, executionMode: 'worker-pool' } });
    await registry.dispose();
  });

  it('getSystemHealth returns valid health snapshot', async () => {
    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => 'test' });
    await registry.initialize();

    const health = await registry.getSystemHealth({ uptimeSec: 42 });
    expect(health.schema).toBe('kb.health/1');
    expect(health.uptimeSec).toBe(42);
    expect(health.registry.total).toBe(0);
    expect(health.status).toBe('healthy');

    await registry.dispose();
  });

  it('uses the platform version owner despite a conflicting KB_LABS_VERSION', async () => {
    const previousVersion = process.env.KB_LABS_VERSION;
    process.env.KB_LABS_VERSION = '2.120.1';
    const registry = new EntityRegistry({ root: tmpDir, resolvePlatformVersion: async () => '2.120.2-cand.d84c8f013160' });
    try {
      await registry.initialize();
      const health = await registry.getSystemHealth();
      expect(health.version.kbLabs).toBe('2.120.2-cand.d84c8f013160');
    } finally {
      await registry.dispose();
      if (previousVersion === undefined) {delete process.env.KB_LABS_VERSION;}
      else {process.env.KB_LABS_VERSION = previousVersion;}
    }
  });

  it('resolves the platform version only when health reports it', async () => {
    let calls = 0;
    const registry = new EntityRegistry({
      root: tmpDir,
      resolvePlatformVersion: async () => {
        calls++;
        return '2.120.2-cand.d84c8f013160';
      },
    });
    try {
      await registry.initialize();
      expect(calls).toBe(0);
      const health = await registry.getSystemHealth();
      expect(calls).toBe(1);
      expect(health.version.kbLabs).toBe('2.120.2-cand.d84c8f013160');
    } finally {
      await registry.dispose();
    }
  });
});
