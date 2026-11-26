import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RegistrySnapshot } from '@kb-labs/plugin-contracts';
import { buildStudioRegistry, registerPluginRegistryRoutes } from '../plugin-registry-routes.js';

function emptySnapshot(): RegistrySnapshot {
  return {
    schema: 'kb.registry/2',
    rev: 1,
    version: '1.0.0',
    generatedAt: '2026-11-24T00:00:00.000Z',
    partial: false,
    stale: false,
    source: { cwd: '/workspace' },
    plugins: [],
    manifests: [],
    observations: [],
    requestIdentity: 'test',
    inputFingerprint: 'test',
    ts: 0,
  };
}

describe('plugin registry routes', () => {
  let app: FastifyInstance | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (root) { await rm(root, { recursive: true, force: true }); }
    root = undefined;
  });

  it('returns a valid empty Studio registry and an empty plugin catalog', async () => {
    app = Fastify();
    await registerPluginRegistryRoutes(app, { apiBasePath: '/api/v1', getSnapshot: emptySnapshot });

    const studio = await app.inject({ method: 'GET', url: '/api/v1/studio/registry' });
    expect(studio.statusCode).toBe(200);
    expect(studio.json()).toMatchObject({
      schema: 'kb.studio/2',
      schemaVersion: 2,
      plugins: [],
    });

    const catalog = await app.inject({ method: 'GET', url: '/api/v1/plugins/registry' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ manifests: [], apiBasePath: '/api/v1' });

  });

  it('projects a Studio manifest and serves its widget bundle through the registered URL', async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-plugin-registry-'));
    const pluginRoot = join(root, 'plugin');
    const widgetsDir = join(pluginRoot, 'dist', 'widgets');
    await mkdir(widgetsDir, { recursive: true });
    await writeFile(join(widgetsDir, 'remoteEntry.js'), 'globalThis.fixtureRemote = true;');

    const snapshot = emptySnapshot();
    snapshot.manifests.push({
      pluginId: '@kb-labs/test-plugin',
      manifest: {
        schema: 'kb.plugin/3',
        id: '@kb-labs/test-plugin',
        version: '1.2.3',
        display: { name: 'Test Plugin' },
        studio: {
          version: 2,
          remoteName: 'testPlugin',
          pages: [{ id: 'test.home', title: 'Test', route: '/p/test', entry: './Test' }],
          menus: [{ id: 'test', label: 'Test', target: 'test.home' }],
        },
      },
      pluginRoot,
      source: { kind: 'local', path: pluginRoot },
      packageName: '@kb-labs/test-plugin',
      scope: 'platform',
      origin: 'workspace',
      manifestPath: join(pluginRoot, 'manifest.json'),
      manifestKind: 'static',
    });

    app = Fastify();
    await registerPluginRegistryRoutes(app, { apiBasePath: '/api/v1', getSnapshot: () => snapshot });

    const studioRegistry = buildStudioRegistry(snapshot);
    expect(studioRegistry.plugins[0]).toMatchObject({
      pluginId: '@kb-labs/test-plugin',
      displayName: 'Test Plugin',
      pluginVersion: '1.2.3',
      remoteName: 'testPlugin',
      pages: [{ id: 'test.home', route: '/p/test' }],
    });
    expect('widgetBundleDir' in studioRegistry.plugins[0]!).toBe(false);

    const widgetUrl = studioRegistry.plugins[0]!.remoteEntryUrl;
    const widget = await app.inject({ method: 'GET', url: widgetUrl });
    expect(widget.statusCode).toBe(200);
    expect(widget.headers['content-type']).toContain('javascript');
    expect(widget.body).toContain('fixtureRemote');
  });

  it('rejects widget symlinks that resolve outside the bundle root', async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-plugin-registry-'));
    const pluginRoot = join(root, 'plugin');
    const widgetsDir = join(pluginRoot, 'dist', 'widgets');
    const secretPath = join(root, 'outside.js');
    await mkdir(widgetsDir, { recursive: true });
    await writeFile(secretPath, 'outside bundle');
    await symlink(secretPath, join(widgetsDir, 'escape.js'));

    const snapshot = emptySnapshot();
    snapshot.manifests.push({
      pluginId: '@kb-labs/test-plugin',
      manifest: {
        schema: 'kb.plugin/3',
        id: '@kb-labs/test-plugin',
        version: '1.2.3',
        studio: { version: 2, remoteName: 'testPlugin', pages: [], menus: [] },
      },
      pluginRoot,
      source: { kind: 'local', path: pluginRoot },
      packageName: '@kb-labs/test-plugin',
      scope: 'platform',
      origin: 'workspace',
      manifestPath: join(pluginRoot, 'manifest.json'),
      manifestKind: 'static',
    });

    app = Fastify();
    await registerPluginRegistryRoutes(app, { apiBasePath: '/api/v1', getSnapshot: () => snapshot });

    const response = await app.inject({ method: 'GET', url: '/plugins/@kb-labs/test-plugin/widgets/escape.js' });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('outside bundle');
  });

  it('rejects a widget bundle root that resolves outside the plugin package', async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-plugin-registry-'));
    const pluginRoot = join(root, 'plugin');
    const distDir = join(pluginRoot, 'dist');
    const outsideWidgets = join(root, 'outside-widgets');
    await mkdir(distDir, { recursive: true });
    await mkdir(outsideWidgets, { recursive: true });
    await writeFile(join(outsideWidgets, 'remoteEntry.js'), 'outside bundle');
    await symlink(outsideWidgets, join(distDir, 'widgets'));

    const snapshot = emptySnapshot();
    snapshot.manifests.push({
      pluginId: '@kb-labs/test-plugin',
      manifest: {
        schema: 'kb.plugin/3',
        id: '@kb-labs/test-plugin',
        version: '1.2.3',
        studio: { version: 2, remoteName: 'testPlugin', pages: [], menus: [] },
      },
      pluginRoot,
      source: { kind: 'local', path: pluginRoot },
      packageName: '@kb-labs/test-plugin',
      scope: 'platform',
      origin: 'workspace',
      manifestPath: join(pluginRoot, 'manifest.json'),
      manifestKind: 'static',
    });

    app = Fastify();
    await registerPluginRegistryRoutes(app, { apiBasePath: '/api/v1', getSnapshot: () => snapshot });

    const response = await app.inject({ method: 'GET', url: '/plugins/@kb-labs/test-plugin/widgets/remoteEntry.js' });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('outside bundle');
  });

  it('rejects README symlinks that resolve outside the plugin package', async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-plugin-registry-'));
    const pluginRoot = join(root, 'plugin');
    await mkdir(pluginRoot, { recursive: true });
    const outsideReadme = join(root, 'outside.md');
    await writeFile(outsideReadme, 'outside package');
    await symlink(outsideReadme, join(pluginRoot, 'README.md'));

    const snapshot = emptySnapshot();
    snapshot.manifests.push({
      pluginId: '@kb-labs/test-plugin',
      manifest: { schema: 'kb.plugin/3', id: '@kb-labs/test-plugin', version: '1.2.3' },
      pluginRoot,
      source: { kind: 'local', path: pluginRoot },
      packageName: '@kb-labs/test-plugin',
      scope: 'platform',
      origin: 'workspace',
      manifestPath: join(pluginRoot, 'manifest.json'),
      manifestKind: 'static',
    });

    app = Fastify();
    await registerPluginRegistryRoutes(app, { apiBasePath: '/api/v1', getSnapshot: () => snapshot });

    const response = await app.inject({ method: 'GET', url: '/api/v1/plugins/@kb-labs/test-plugin/readme' });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('outside package');
  });
});
