/**
 * Integration test: marketplace install → discovery → plugin available
 *
 * Tests the real flow:
 *   1. Create fake plugin on disk with kb.plugin.json
 *   2. Write marketplace.lock with correct integrity
 *   3. Run DiscoveryManager.discover()
 *   4. Verify plugin is found with correct metadata
 *
 * No mocking — uses real filesystem, real lock files, real discovery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { IExtensionStore } from '@kb-labs/core-extension-store';
import { DiscoveryManager } from '../discovery-manager.js';
import {
  writeMarketplaceLock,
  createEmptyLock,
  createMarketplaceEntry,
} from '../marketplace-lock.js';

describe('Discovery Integration: install → discover → available', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-discovery-integration-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function computeIntegrity(content: string): string {
    return `sha256-${crypto.createHash('sha256').update(Buffer.from(content)).digest('base64')}`;
  }

  async function installPlugin(opts: {
    name: string;
    id: string;
    version: string;
    commands?: Array<{ id: string; describe: string }>;
    routes?: Array<{ method: string; path: string }>;
    workflows?: Array<{ id: string }>;
  }) {
    const pluginDir = path.join(tmpDir, 'plugins', opts.name);
    await fs.mkdir(pluginDir, { recursive: true });

    const pkgJson = JSON.stringify({ name: opts.id, version: opts.version });
    await fs.writeFile(path.join(pluginDir, 'package.json'), pkgJson);

    const manifest: Record<string, unknown> = {
      schema: 'kb.plugin/3',
      id: opts.id,
      version: opts.version,
      display: { name: opts.name, description: `${opts.name} plugin` },
    };
    if (opts.commands?.length) {
      manifest.cli = { commands: opts.commands.map(c => ({ ...c, handler: './dist/h.js' })) };
    }
    if (opts.routes?.length) {
      manifest.rest = { routes: opts.routes.map(r => ({ ...r, handler: './dist/r.js' })) };
    }
    if (opts.workflows?.length) {
      manifest.workflows = { handlers: opts.workflows };
    }

    await fs.writeFile(path.join(pluginDir, 'kb.plugin.json'), JSON.stringify(manifest));

    return {
      dir: pluginDir,
      integrity: computeIntegrity(pkgJson),
      relPath: `./plugins/${opts.name}`,
    };
  }

  it('discovers a single CLI plugin end-to-end', async () => {
    const { integrity, relPath } = await installPlugin({
      name: 'commit',
      id: '@kb-labs/commit',
      version: '1.5.0',
      commands: [{ id: 'commit', describe: 'AI commit message' }],
    });

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/commit'] = createMarketplaceEntry({
      version: '1.5.0',
      integrity,
      package: '@kb-labs/commit',
      resolvedPath: relPath,
      source: 'platform',
      primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const dm = new DiscoveryManager({ root: tmpDir });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0]!;
    expect(plugin.id).toBe('@kb-labs/commit');
    expect(plugin.version).toBe('1.5.0');
    expect(plugin.source.kind).toBe('marketplace');
    expect(plugin.provides).toContain('plugin');
    expect(plugin.provides).toContain('cli-command');
    expect(plugin.display?.name).toBe('commit');

    // Manifest should be loaded
    const manifest = result.manifests.get('@kb-labs/commit');
    expect(manifest).toBeDefined();
    expect(manifest!.cli?.commands).toHaveLength(1);
  });

  // case: S-268.10
  it('does not load a plugin resolved outside the project through a Marketplace lock path', async () => {
    const projectRoot = path.join(tmpDir, 'projects', 'app');
    const outsidePlugin = path.join(tmpDir, 'outside', 'plugin');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsidePlugin, { recursive: true });
    await fs.writeFile(path.join(outsidePlugin, 'package.json'), JSON.stringify({ name: '@vendor/outside', version: '1.0.0' }));
    await fs.writeFile(path.join(outsidePlugin, 'kb.plugin.json'), JSON.stringify({
      schema: 'kb.plugin/3',
      id: '@vendor/outside',
      version: '1.0.0',
      display: { name: 'Outside plugin', description: 'Must not be loaded from outside the project scope.' },
    }));
    const lockRoot = path.join(projectRoot, '.kb');
    await fs.mkdir(lockRoot, { recursive: true });
    await fs.writeFile(path.join(lockRoot, 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {
        '@vendor/outside': {
          version: '1.0.0', integrity: computeIntegrity(JSON.stringify({ name: '@vendor/outside', version: '1.0.0' })),
          package: '@vendor/outside', resolvedPath: path.relative(projectRoot, outsidePlugin), enabled: true,
          source: 'marketplace', marketplaceSource: 'npm', signatureStatus: 'unsigned',
        },
      },
    }));

    const dm = new DiscoveryManager({ root: projectRoot, scope: 'project', workspace: false });
    const result = await dm.discover();

    expect(result.plugins.map(plugin => plugin.id)).not.toContain('@vendor/outside');
    expect(result.manifests.has('@vendor/outside')).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOCK_SCHEMA_INVALID' }));
  });

  // case: S-268.10
  it('discovers a local link at its recorded absolute path outside the scope root', async () => {
    const projectRoot = path.join(tmpDir, 'projects', 'app');
    const linked = await installPlugin({ name: 'developer-plugin', id: '@vendor/developer-plugin', version: '1.0.0' });
    await fs.mkdir(path.join(projectRoot, '.kb'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {
        '@vendor/developer-plugin': { link: linked.dir, enabled: true, source: 'local' },
      },
    }));

    const result = await new DiscoveryManager({ root: projectRoot, scope: 'project', workspace: false }).discover();

    expect(result.plugins.map(plugin => plugin.id)).toContain('@vendor/developer-plugin');
    expect(result.manifests.has('@vendor/developer-plugin')).toBe(true);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'LOCK_SCHEMA_INVALID' }));
  });

  // case: S-203.25
  it('fails closed for marketplace plugins when policy config is broken and retains local sources', async () => {
    const marketplace = await installPlugin({ name: 'marketplace', id: '@vendor/marketplace', version: '1.0.0' });
    const firstParty = await installPlugin({ name: 'first-party', id: '@vendor/platform-shipped', version: '1.0.0' });
    const linked = await installPlugin({ name: 'linked', id: '@vendor/linked', version: '1.0.0' });
    const firstPartyPackageJsonPath = path.join(firstParty.dir, 'package.json');
    const firstPartyPackageJson = JSON.parse(await fs.readFile(firstPartyPackageJsonPath, 'utf8')) as Record<string, unknown>;
    firstPartyPackageJson.kb = { manifest: './kb.plugin.json' };
    await fs.writeFile(firstPartyPackageJsonPath, JSON.stringify(firstPartyPackageJson));
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n');
    await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
    const configPath = path.join(tmpDir, '.kb', 'kb.config.json');
    await fs.writeFile(configPath, '{"plugins":');

    const lock = createEmptyLock();
    lock.plugins['@vendor/marketplace'] = createMarketplaceEntry({
      version: '1.0.0', integrity: marketplace.integrity, resolvedPath: marketplace.relPath,
      package: '@vendor/marketplace', source: 'marketplace', primaryKind: 'plugin', provides: ['plugin'],
      marketplaceSource: 'registry', signatureStatus: 'verified',
    });
    lock.plugins['@vendor/linked'] = createMarketplaceEntry({
      version: '1.0.0', integrity: linked.integrity, resolvedPath: linked.relPath,
      source: 'local', primaryKind: 'plugin', provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const extensionStore: IExtensionStore = {
      root: path.join(tmpDir, 'store'),
      casDir: path.join(tmpDir, 'store', 'cas'),
      entriesDir: path.join(tmpDir, 'store', 'entries'),
      lookup: async () => ({
        packageRoot: marketplace.dir,
        entryDir: path.join(tmpDir, 'store', 'entries', 'marketplace'),
        entry: {
          schema: 'kb.store-entry/1',
          name: '@vendor/marketplace',
          version: '1.0.0',
          kind: 'plugin',
          integrity: marketplace.integrity,
          installedAt: '2026-10-12T00:00:00.000Z',
        },
      }),
      resolve: async () => { throw new Error('resolve must not run during discovery'); },
      listEntries: async () => [],
    };
    const result = await new DiscoveryManager({ root: tmpDir, scope: 'project', extensionStore }).discover();

    expect(result.plugins.map(plugin => plugin.id).sort()).toEqual(['@vendor/linked', '@vendor/platform-shipped']);
    expect(result.failures.map(failure => failure.id)).toContain('@vendor/marketplace');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'JSON_PARSE_FAILED',
        context: expect.objectContaining({ filePath: configPath }),
        remediation: expect.stringContaining('python3 -m json.tool'),
      }),
      expect.objectContaining({
        code: 'JSON_PARSE_FAILED',
        context: expect.objectContaining({ filePath: configPath }),
      }),
    ]));
  });

  it('discovers multiple plugins with different entity kinds', async () => {
    const commit = await installPlugin({
      name: 'commit',
      id: '@kb-labs/commit',
      version: '1.0.0',
      commands: [{ id: 'commit', describe: 'Commit' }],
    });

    const api = await installPlugin({
      name: 'rest-api',
      id: '@kb-labs/rest-api',
      version: '2.0.0',
      routes: [{ method: 'GET', path: '/api/status' }],
    });

    const workflow = await installPlugin({
      name: 'deploy',
      id: '@kb-labs/deploy',
      version: '0.5.0',
      workflows: [{ id: 'deploy-prod' }],
    });

    const lock = createEmptyLock();
    for (const { id, version, integrity, relPath, provides } of [
      { ...commit, id: '@kb-labs/commit', version: '1.0.0', provides: ['plugin', 'cli-command'] },
      { ...api, id: '@kb-labs/rest-api', version: '2.0.0', provides: ['plugin', 'rest-route'] },
      { ...workflow, id: '@kb-labs/deploy', version: '0.5.0', provides: ['plugin', 'workflow'] },
    ]) {
      lock.plugins[id] = createMarketplaceEntry({
        version, integrity, resolvedPath: relPath,
        source: 'local', primaryKind: 'plugin', provides,
      });
    }
    await writeMarketplaceLock(tmpDir, lock);

    const dm = new DiscoveryManager({ root: tmpDir });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(3);
    expect(result.manifests.size).toBe(3);

    // Verify entity kinds extracted from manifests
    const commitPlugin = result.plugins.find(p => p.id === '@kb-labs/commit')!;
    expect(commitPlugin.provides).toContain('cli-command');

    const apiPlugin = result.plugins.find(p => p.id === '@kb-labs/rest-api')!;
    expect(apiPlugin.provides).toContain('rest-route');

    const deployPlugin = result.plugins.find(p => p.id === '@kb-labs/deploy')!;
    expect(deployPlugin.provides).toContain('workflow');
  });

  it('installed → disabled → not discovered → enabled → discovered', async () => {
    const { integrity, relPath } = await installPlugin({
      name: 'toggle-test',
      id: '@kb-labs/toggle',
      version: '1.0.0',
      commands: [{ id: 'toggle', describe: 'Toggle test' }],
    });

    // Install as disabled
    const lock = createEmptyLock();
    lock.plugins['@kb-labs/toggle'] = createMarketplaceEntry({
      version: '1.0.0', integrity, resolvedPath: relPath,
      source: 'local', primaryKind: 'plugin', provides: ['plugin'],
    });
    lock.plugins['@kb-labs/toggle']!.enabled = false;
    await writeMarketplaceLock(tmpDir, lock);

    // Discovery should skip
    const dm = new DiscoveryManager({ root: tmpDir });
    let result = await dm.discover();
    expect(result.plugins).toHaveLength(0);

    // Enable
    lock.plugins['@kb-labs/toggle']!.enabled = true;
    await writeMarketplaceLock(tmpDir, lock);

    // Discovery should find
    result = await dm.discover();
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.id).toBe('@kb-labs/toggle');
  });

  it('tampered package is blocked (integrity mismatch)', async () => {
    const { relPath } = await installPlugin({
      name: 'tampered',
      id: '@kb-labs/tampered',
      version: '1.0.0',
    });

    // Install with wrong integrity
    const lock = createEmptyLock();
    lock.plugins['@kb-labs/tampered'] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: 'sha256-WRONGHASH',
      package: '@kb-labs/tampered',
      resolvedPath: relPath,
      source: 'platform', // marketplace = strict integrity check
      primaryKind: 'plugin',
      provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    const dm = new DiscoveryManager({ root: tmpDir, verifyIntegrity: true });
    const result = await dm.discover();

    // Should be blocked
    expect(result.plugins).toHaveLength(0);
    const mismatch = result.diagnostics.find(d => d.code === 'INTEGRITY_MISMATCH');
    expect(mismatch).toBeDefined();
  });

  it('removed package directory produces PACKAGE_NOT_FOUND diagnostic', async () => {
    const { integrity } = await installPlugin({
      name: 'vanished',
      id: '@kb-labs/vanished',
      version: '1.0.0',
    });

    const lock = createEmptyLock();
    lock.plugins['@kb-labs/vanished'] = createMarketplaceEntry({
      version: '1.0.0', integrity,
      resolvedPath: './plugins/vanished',
      source: 'local', primaryKind: 'plugin', provides: ['plugin'],
    });
    await writeMarketplaceLock(tmpDir, lock);

    // Delete the plugin directory
    await fs.rm(path.join(tmpDir, 'plugins', 'vanished'), { recursive: true });

    const dm = new DiscoveryManager({ root: tmpDir });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(0);
    const notFound = result.diagnostics.find(d => d.code === 'PACKAGE_NOT_FOUND');
    expect(notFound).toBeDefined();
    expect(notFound!.remediation).toContain('install');
  });

  it('no lock file produces empty result with diagnostic', async () => {
    const dm = new DiscoveryManager({ root: tmpDir });
    const result = await dm.discover();

    expect(result.plugins).toHaveLength(0);
    expect(result.manifests.size).toBe(0);
    expect(result.diagnostics.some(d => d.code === 'LOCK_NOT_FOUND')).toBe(true);
  });
});
