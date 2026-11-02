/**
 * Integration tests for the full registry lifecycle:
 *   marketplace.lock → DiscoveryManager → EntityRegistry → snapshot → queries
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';

import {
  createEmptyLock,
  createMarketplaceEntry,
  addToMarketplaceLock,
  removeFromMarketplaceLock,
  readMarketplaceLock,
  writeMarketplaceLock,
  DiagnosticCollector,
} from '@kb-labs/core-discovery';

import {
  openCatalog,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createFakePlugin(root: string, id: string, opts?: {
  commands?: Array<{ path: string; describe: string }>;
  routes?: Array<{ method: string; path: string }>;
  workflows?: Array<{ id: string }>;
  crons?: Array<{ id: string; schedule: string }>;
  widgets?: Array<{ id: string }>;
}): Promise<{ dir: string; integrity: string }> {
  const shortName = id.replace('@kb-labs/', '');
  const dir = path.join(root, 'plugins', shortName);
  await fs.mkdir(dir, { recursive: true });

  const manifest: Record<string, unknown> = {
    schema: 'kb.plugin/3',
    id,
    version: '1.0.0',
    display: { name: shortName, description: `Test plugin ${shortName}` },
  };

  if (opts?.commands?.length) {
    manifest.cli = {
      commands: opts.commands.map(c => ({ ...c, handler: `./dist/${c.path.replace(/ /g, '-')}.js` })),
    };
  }
  if (opts?.routes?.length) {
    manifest.rest = {
      routes: opts.routes.map(r => ({
        method: r.method, path: r.path, handler: `./dist/route.js`,
      })),
    };
  }
  if (opts?.workflows?.length) {
    manifest.workflows = {
      handlers: opts.workflows.map(w => ({ id: w.id, handler: `./dist/${w.id}.js` })),
    };
  }
  if (opts?.crons?.length) {
    manifest.cron = {
      schedules: opts.crons.map(c => ({
        id: c.id, schedule: c.schedule, job: { type: c.id },
      })),
    };
  }
  if (opts?.widgets?.length) {
    manifest.studio = { pages: opts.widgets.map(w => ({ id: w.id, component: `./dist/${w.id}.js` })) };
  }

  await fs.writeFile(path.join(dir, 'kb.plugin.json'), JSON.stringify(manifest), 'utf-8');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: id, version: '1.0.0',
  }), 'utf-8');

  const pkgContent = await fs.readFile(path.join(dir, 'package.json'));
  const integrity = `sha256-${crypto.createHash('sha256').update(pkgContent).digest('base64')}`;

  return { dir, integrity };
}

async function registerPlugin(
  root: string,
  id: string,
  pluginDir: string,
  integrity: string,
  provides: string[],
  source: 'marketplace' | 'local' = 'local',
) {
  const entryOptions = {
    version: '1.0.0',
    integrity,
    resolvedPath: path.relative(root, pluginDir),
    primaryKind: (provides[0] ?? 'plugin') as any,
    provides: provides as any,
  };
  const entry = source === 'local'
    ? createMarketplaceEntry({ ...entryOptions, source: 'local' })
    : createMarketplaceEntry({
      ...entryOptions,
      source: 'marketplace',
      package: JSON.parse(await fs.readFile(path.join(pluginDir, 'package.json'), 'utf8')).name,
      marketplaceSource: 'registry',
      signatureStatus: 'verified',
    });
  await addToMarketplaceLock(root, id, entry);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Registry Integration', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-integration-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not persist a snapshot when the catalog is opened with persistence disabled', async () => {
    const kbHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-registry-memory-home-'));
    const previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;
    const scopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-registry-memory-scope-'));
    try {
      const catalog = await openCatalog({ platformRoot: scopeRoot, projectRoot: scopeRoot }, { persistSnapshot: false });
      await catalog.dispose();
      const snapshotPath = resolveRuntimeStatePath(scopeRoot, ['cache', 'registry.json'], { root: kbHome });
      await expect(fs.access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousKbHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousKbHome;
      await fs.rm(kbHome, { recursive: true, force: true });
      await fs.rm(scopeRoot, { recursive: true, force: true });
    }
  });

  it('full lifecycle: install → discover → query → uninstall → refresh', async () => {
    // 1. Install: create plugin + write to marketplace.lock
    const { dir, integrity } = await createFakePlugin(root, '@kb-labs/greeter', {
      commands: [{ path: 'greet', describe: 'Say hello' }],
      routes: [{ method: 'GET', path: '/api/greet' }],
    });
    await registerPlugin(root, '@kb-labs/greeter', dir, integrity, ['plugin', 'cli-command', 'rest-route']);

    // 2. Discover: create registry
    const registry = await openCatalog({ platformRoot: root, projectRoot: root });

    // 3. Query: verify plugin and entities
    const plugins = registry.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.id).toBe('@kb-labs/greeter');

    const commands = registry.queryEntities({ kind: 'cli-command' });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.ref.entityId).toBe('greet');

    const routes = registry.queryEntities({ kind: 'rest-route' });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.ref.entityId).toBe('GET /api/greet');

    // 4. Uninstall: remove from lock
    await removeFromMarketplaceLock(root, '@kb-labs/greeter');

    // 5. Refresh: registry picks up removal
    await registry.refresh();

    expect(registry.listPlugins()).toHaveLength(0);
    expect(registry.queryEntities({ kind: 'cli-command' })).toHaveLength(0);

    await registry.dispose();
  });

  it('multi-plugin registry with mixed entity types', async () => {
    // Plugin A: CLI commands + workflows
    const a = await createFakePlugin(root, '@kb-labs/plugin-a', {
      commands: [
        { path: 'a init', describe: 'Initialize A' },
        { path: 'a run', describe: 'Run A' },
      ],
      workflows: [{ id: 'a-workflow' }],
    });
    await registerPlugin(root, '@kb-labs/plugin-a', a.dir, a.integrity, ['plugin', 'cli-command', 'workflow']);

    // Plugin B: REST routes + crons
    const b = await createFakePlugin(root, '@kb-labs/plugin-b', {
      routes: [
        { method: 'GET', path: '/api/b/list' },
        { method: 'POST', path: '/api/b/create' },
        { method: 'DELETE', path: '/api/b/:id' },
      ],
      crons: [{ id: 'b-nightly', schedule: '0 3 * * *' }],
    });
    await registerPlugin(root, '@kb-labs/plugin-b', b.dir, b.integrity, ['plugin', 'rest-route', 'cron']);

    // Plugin C: Studio widgets
    const c = await createFakePlugin(root, '@kb-labs/plugin-c', {
      widgets: [{ id: 'dashboard-widget' }, { id: 'status-widget' }],
    });
    await registerPlugin(root, '@kb-labs/plugin-c', c.dir, c.integrity, ['plugin', 'studio-widget']);

    const registry = await openCatalog({ platformRoot: root, projectRoot: root });

    // Verify totals
    expect(registry.listPlugins()).toHaveLength(3);
    expect(registry.queryEntities({ kind: 'plugin' })).toHaveLength(3);
    expect(registry.queryEntities({ kind: 'cli-command' })).toHaveLength(2);
    expect(registry.queryEntities({ kind: 'rest-route' })).toHaveLength(3);
    expect(registry.queryEntities({ kind: 'workflow' })).toHaveLength(1);
    expect(registry.queryEntities({ kind: 'cron' })).toHaveLength(1);
    expect(registry.queryEntities({ kind: 'studio-widget' })).toHaveLength(2);

    // Filter by plugin
    expect(registry.queryEntities({ pluginId: '@kb-labs/plugin-b' })).toHaveLength(5); // 1 plugin + 3 routes + 1 cron

    // Filter by multiple kinds
    expect(registry.queryEntities({ kind: ['cli-command', 'workflow'] })).toHaveLength(3);

    // Search
    expect(registry.queryEntities({ search: 'dashboard' })).toHaveLength(1);

    // Entity kinds
    const kinds = registry.getEntityKinds();
    expect(kinds).toContain('plugin');
    expect(kinds).toContain('cli-command');
    expect(kinds).toContain('rest-route');
    expect(kinds).toContain('workflow');
    expect(kinds).toContain('cron');
    expect(kinds).toContain('studio-widget');

    await registry.dispose();
  });

  // case: S-282.1 S-282.2
  it('refreshes workspace CLI commands when matched package membership changes', async () => {
    const platformRoot = path.join(root, 'workspace-platform');
    const projectRoot = path.join(root, 'workspace-project');
    const kbHome = path.join(root, 'workspace-kb-home');
    const previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;
    try {
      await fs.mkdir(platformRoot, { recursive: true });
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(path.join(platformRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n');

      const addWorkspacePlugin = async (shortName: string, command: string) => {
        const plugin = await createFakePlugin(platformRoot, `@kb-labs/${shortName}`, {
          commands: [{ path: command, describe: `Run ${command}` }],
        });
        const packageJsonPath = path.join(plugin.dir, 'package.json');
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
        packageJson.kb = { manifest: 'kb.plugin.json' };
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson));
        return plugin.dir;
      };

      const packageA = await addWorkspacePlugin('a', 'sample from-a');
      const first = await openCatalog({ platformRoot, projectRoot });
      expect(first.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId)).toContain('sample from-a');
      await first.dispose();

      const packageB = await addWorkspacePlugin('b', 'sample from-b');
      const afterAdd = await openCatalog({ platformRoot, projectRoot });
      const afterAddCommands = afterAdd.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId);
      expect(afterAddCommands).toContain('sample from-a');
      expect(afterAddCommands).toContain('sample from-b');
      await afterAdd.dispose();

      await fs.rm(packageA, { recursive: true, force: true });
      const afterRemoval = await openCatalog({ platformRoot, projectRoot });
      const afterRemovalCommands = afterRemoval.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId);
      expect(afterRemovalCommands).not.toContain('sample from-a');
      expect(afterRemovalCommands).toContain('sample from-b');
      await afterRemoval.dispose();

      await fs.rm(packageB, { recursive: true, force: true });
    } finally {
      if (previousKbHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousKbHome;
    }
  });

  it('refreshes a cached CLI capability when the platform marketplace lock changes', async () => {
    const platformRoot = path.join(root, 'platform');
    const projectRoot = path.join(root, 'project');
    const kbHome = path.join(root, 'kb-home');
    const previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;
    try {
      await fs.mkdir(platformRoot, { recursive: true });
      await fs.mkdir(projectRoot, { recursive: true });
      const commit = await createFakePlugin(platformRoot, '@kb-labs/commit', {
        commands: [{ path: 'commit plan show', describe: 'Show the Commit plan' }],
      });
      const unrelated = await createFakePlugin(platformRoot, '@kb-labs/unrelated', {
        workflows: [{ id: 'unrelated-workflow' }],
      });
      await registerPlugin(platformRoot, '@kb-labs/commit', commit.dir, commit.integrity, ['plugin', 'cli-command']);
      await registerPlugin(platformRoot, '@kb-labs/unrelated', unrelated.dir, unrelated.integrity, ['plugin', 'workflow']);

      const lock = await readMarketplaceLock(platformRoot, new DiagnosticCollector());
      expect(lock).not.toBeNull();
      lock!.plugins['@kb-labs/commit']!.enabled = false;
      await writeMarketplaceLock(platformRoot, lock!);

      const disabled = await openCatalog({ platformRoot, projectRoot });
      expect(disabled.queryEntities({ kind: 'cli-command' })).toHaveLength(0);
      await disabled.dispose();
      const snapshotPath = resolveRuntimeStatePath(projectRoot, ['cache', 'registry.json'], { root: kbHome });
      const persistedSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as { ts: number };

      const enabledLock = await readMarketplaceLock(platformRoot, new DiagnosticCollector());
      expect(enabledLock).not.toBeNull();
      enabledLock!.plugins['@kb-labs/commit']!.enabled = true;
      await writeMarketplaceLock(platformRoot, enabledLock!);
      const lockPath = path.join(platformRoot, '.kb', 'marketplace.lock');
      const changedAt = new Date(persistedSnapshot.ts);
      await fs.utimes(lockPath, changedAt, changedAt);
      expect((await fs.stat(lockPath)).mtimeMs).toBe(persistedSnapshot.ts);

      const enabled = await openCatalog({ platformRoot, projectRoot });
      expect(enabled.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId))
        .toContain('commit plan show');
      await enabled.dispose();
    } finally {
      if (previousKbHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousKbHome;
    }
  });

  it('does not persist a fresh snapshot when the marketplace lock changes during discovery', async () => {
    const platformRoot = path.join(root, 'platform-race');
    const projectRoot = path.join(root, 'project-race');
    const kbHome = path.join(root, 'kb-home-race');
    const previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;
    try {
      await fs.mkdir(platformRoot, { recursive: true });
      await fs.mkdir(projectRoot, { recursive: true });
      const commit = await createFakePlugin(platformRoot, '@kb-labs/commit', {
        commands: [{ path: 'commit plan show', describe: 'Show the Commit plan' }],
      });
      const trigger = await createFakePlugin(platformRoot, '@kb-labs/fingerprint-trigger', {
        workflows: [{ id: 'fingerprint-trigger' }],
      });
      await registerPlugin(platformRoot, '@kb-labs/commit', commit.dir, commit.integrity, ['plugin', 'cli-command']);
      await registerPlugin(platformRoot, '@kb-labs/fingerprint-trigger', trigger.dir, trigger.integrity, ['plugin', 'workflow']);

      const lockPath = path.join(platformRoot, '.kb', 'marketplace.lock');
      const lock = await readMarketplaceLock(platformRoot, new DiagnosticCollector());
      expect(lock).not.toBeNull();
      lock!.plugins['@kb-labs/commit']!.enabled = false;
      await writeMarketplaceLock(platformRoot, lock!);
      const enabledLock = structuredClone(lock!);
      enabledLock.plugins['@kb-labs/commit']!.enabled = true;
      const triggerManifest = JSON.parse(await fs.readFile(path.join(trigger.dir, 'kb.plugin.json'), 'utf8'));
      await fs.writeFile(path.join(trigger.dir, 'package.json'), JSON.stringify({
        name: '@kb-labs/fingerprint-trigger',
        version: '1.0.0',
        kb: { manifest: 'manifest.mjs' },
      }));
      await fs.writeFile(path.join(trigger.dir, 'manifest.mjs'), [
        "import { writeFile } from 'node:fs/promises';",
        `await writeFile(${JSON.stringify(lockPath)}, ${JSON.stringify(JSON.stringify(enabledLock))});`,
        `export const manifest = ${JSON.stringify(triggerManifest)};`,
      ].join('\n'));

      const discoveredBeforeEnable = await openCatalog({ platformRoot, projectRoot });
      expect(discoveredBeforeEnable.queryEntities({ kind: 'cli-command' })).toHaveLength(0);
      await discoveredBeforeEnable.dispose();
      expect((await readMarketplaceLock(platformRoot, new DiagnosticCollector()))?.plugins['@kb-labs/commit']?.enabled)
        .toBe(true);

      const reopened = await openCatalog({ platformRoot, projectRoot });
      expect(reopened.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId))
        .toContain('commit plan show');
      await reopened.dispose();
    } finally {
      if (previousKbHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousKbHome;
    }
  });

  it('rediscovers when a loaded manifest artifact changes before snapshot persistence', async () => {
    const platformRoot = path.join(root, 'manifest-race-platform');
    const projectRoot = path.join(root, 'manifest-race-project');
    const kbHome = path.join(root, 'manifest-race-kb-home');
    const previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;
    try {
      await fs.mkdir(platformRoot, { recursive: true });
      await fs.mkdir(projectRoot, { recursive: true });
      const target = await createFakePlugin(platformRoot, '@kb-labs/target', {
        commands: [{ path: 'target old', describe: 'Old command' }],
      });
      const trigger = await createFakePlugin(platformRoot, '@kb-labs/manifest-trigger', {
        workflows: [{ id: 'manifest-trigger' }],
      });
      await registerPlugin(platformRoot, '@kb-labs/target', target.dir, target.integrity, ['plugin', 'cli-command']);
      await registerPlugin(platformRoot, '@kb-labs/manifest-trigger', trigger.dir, trigger.integrity, ['plugin', 'workflow']);

      const targetManifestPath = path.join(target.dir, 'kb.plugin.json');
      const updatedManifest = JSON.parse(await fs.readFile(targetManifestPath, 'utf8')) as Record<string, unknown>;
      updatedManifest.cli = {
        commands: [{ path: 'target new', describe: 'New command', handler: './dist/target-new.js' }],
      };
      await fs.writeFile(path.join(trigger.dir, 'package.json'), JSON.stringify({
        name: '@kb-labs/manifest-trigger',
        version: '1.0.0',
        kb: { manifest: 'manifest.mjs' },
      }));
      await fs.writeFile(path.join(trigger.dir, 'manifest.mjs'), [
        "import { writeFile } from 'node:fs/promises';",
        'await new Promise((resolve) => setTimeout(resolve, 100));',
        `await writeFile(${JSON.stringify(targetManifestPath)}, ${JSON.stringify(JSON.stringify(updatedManifest))});`,
        `export const manifest = ${JSON.stringify({
          schema: 'kb.plugin/3', id: '@kb-labs/manifest-trigger', version: '1.0.0',
          workflows: { handlers: [{ id: 'manifest-trigger', handler: './dist/manifest-trigger.js' }] },
        })};`,
      ].join('\n'));

      const first = await openCatalog({ platformRoot, projectRoot });
      expect(first.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId)).toContain('target old');
      await first.dispose();

      const reopened = await openCatalog({ platformRoot, projectRoot });
      const commandIds = reopened.queryEntities({ kind: 'cli-command' }).map(entity => entity.ref.entityId);
      expect(commandIds).toContain('target new');
      expect(commandIds).not.toContain('target old');
      await reopened.dispose();
    } finally {
      if (previousKbHome === undefined) delete process.env.KB_HOME;
      else process.env.KB_HOME = previousKbHome;
    }
  });

  it('snapshot persistence and reload', async () => {
    const { dir, integrity } = await createFakePlugin(root, '@kb-labs/persistent', {
      commands: [{ path: 'persist-cmd', describe: 'Test persistence' }],
    });
    await registerPlugin(root, '@kb-labs/persistent', dir, integrity, ['plugin', 'cli-command']);

    // First registry: discovers and persists snapshot
    const reg1 = await openCatalog({ platformRoot: root, projectRoot: root });
    expect(reg1.listPlugins()).toHaveLength(1);
    const snap1 = reg1.snapshot();
    expect(snap1.schema).toBe('kb.registry/1');
    expect(snap1.manifests).toHaveLength(1);
    await reg1.dispose();

    // Second registry: should load from snapshot cache
    const reg2 = await openCatalog({ platformRoot: root, projectRoot: root });
    expect(reg2.listPlugins()).toHaveLength(1);
    expect(reg2.queryEntities({ kind: 'cli-command' })).toHaveLength(1);
    await reg2.dispose();
  });

  it('keeps an unrelated workflow discoverable while retaining a missing-plugin diagnostic', async () => {
    // Good plugin
    const good = await createFakePlugin(root, '@kb-labs/good', {
      workflows: [{ id: 'unrelated-workflow' }],
    });
    await registerPlugin(root, '@kb-labs/good', good.dir, good.integrity, ['plugin', 'workflow']);

    // Bad plugin: directory doesn't exist
    const lock = createEmptyLock();
    lock.plugins['@kb-labs/ghost'] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: 'sha256-fake',
      package: '@kb-labs/ghost',
      resolvedPath: './nonexistent',
      source: 'platform',
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    // Merge with existing lock
    const existingLock = JSON.parse(
      await fs.readFile(path.join(root, '.kb', 'marketplace.lock'), 'utf-8'),
    );
    existingLock.plugins['@kb-labs/ghost'] = lock.plugins['@kb-labs/ghost'];
    await writeMarketplaceLock(root, existingLock);

    const registry = await openCatalog({ platformRoot: root, projectRoot: root });

    // Only good plugin loaded
    expect(registry.listPlugins()).toHaveLength(1);
    expect(registry.listPlugins()[0]!.id).toBe('@kb-labs/good');
    expect(registry.queryEntities({ kind: 'workflow' })).toMatchObject([
      { ref: { pluginId: '@kb-labs/good', entityId: 'unrelated-workflow' } },
    ]);

    // Diagnostics show the error
    const diag = registry.getDiagnostics();
    expect(diag.summary.errors).toBeGreaterThan(0);
    expect(diag.byPlugin['@kb-labs/ghost']).toBeDefined();
    expect(diag.byPlugin['@kb-labs/ghost']!.some(e => e.code === 'PACKAGE_NOT_FOUND')).toBe(true);

    await registry.dispose();
  });

  it('onChange fires on refresh with added/removed plugins', async () => {
    const registry = await openCatalog({ platformRoot: root, projectRoot: root });
    expect(registry.listPlugins()).toHaveLength(0);

    const diffs: Array<{ added: unknown[]; removed: unknown[]; changed: unknown[] }> = [];
    registry.onChange(diff => diffs.push(diff));

    // Add plugin
    const { dir, integrity } = await createFakePlugin(root, '@kb-labs/dynamic');
    await registerPlugin(root, '@kb-labs/dynamic', dir, integrity, ['plugin']);
    await registry.refresh();

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.added).toHaveLength(1);
    expect((diffs[0]!.added[0] as any).id).toBe('@kb-labs/dynamic');

    // Remove plugin
    await removeFromMarketplaceLock(root, '@kb-labs/dynamic');
    await registry.refresh();

    expect(diffs).toHaveLength(2);
    expect(diffs[1]!.removed).toHaveLength(1);
    expect((diffs[1]!.removed[0] as any).id).toBe('@kb-labs/dynamic');

    await registry.dispose();
  });

  it('generators: OpenAPI and Studio registry', async () => {
    const { dir, integrity } = await createFakePlugin(root, '@kb-labs/api-plugin', {
      commands: [{ path: 'api-cmd', describe: 'API command' }],
      routes: [
        { method: 'GET', path: '/api/items' },
        { method: 'POST', path: '/api/items' },
      ],
    });
    await registerPlugin(root, '@kb-labs/api-plugin', dir, integrity, ['plugin', 'cli-command', 'rest-route']);

    const registry = await openCatalog({ platformRoot: root, projectRoot: root });

    // OpenAPI
    const spec = registry.getOpenAPISpec('@kb-labs/api-plugin');
    expect(spec).not.toBeNull();
    expect(spec!.openapi).toBe('3.1.0');
    expect(spec!['x-kb-plugin-id']).toBe('@kb-labs/api-plugin');
    // Both routes share /api/items path (GET + POST), so 1 path with 2 methods
    expect(Object.keys(spec!.paths)).toHaveLength(1);
    const pathItem = spec!.paths['/api/items'] as Record<string, unknown>;
    expect(pathItem.get).toBeDefined();
    expect(pathItem.post).toBeDefined();

    // No spec for plugin without routes
    expect(registry.getOpenAPISpec('@kb-labs/nonexistent')).toBeNull();

    // Studio
    const studio = registry.getStudioRegistry();
    expect(studio.plugins).toHaveLength(1);
    expect(studio.plugins[0]!.capabilities.hasCommands).toBe(true);
    expect(studio.plugins[0]!.capabilities.hasRestAPI).toBe(true);

    await registry.dispose();
  });

  it('health snapshot reflects registry state', async () => {
    const { dir, integrity } = await createFakePlugin(root, '@kb-labs/healthy', {
      routes: [{ method: 'GET', path: '/api/health-test' }],
    });
    await registerPlugin(root, '@kb-labs/healthy', dir, integrity, ['plugin', 'rest-route']);

    const registry = await openCatalog({ platformRoot: root, projectRoot: root });
    const health = await registry.getSystemHealth({ uptimeSec: 100 });

    expect(health.schema).toBe('kb.health/1');
    expect(health.uptimeSec).toBe(100);
    expect(health.registry.total).toBe(1);
    expect(health.registry.withRest).toBe(1);
    expect(health.status).toBe('healthy');

    await registry.dispose();
  });
});
