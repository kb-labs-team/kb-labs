/**
 * Parity between the CLI and the REST/registry discovery (ADR-0048, task 7.6).
 *
 * There is one pipeline (core-discovery). The CLI adapter and `EntityRegistry`
 * (what REST uses) must therefore return the same set of plugins with the same
 * manifests for one platform root + one project root, and a project-scope
 * install must be visible to the CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeMarketplaceLock,
  createEmptyLock,
  createMarketplaceEntry,
  computePackageIntegrity,
} from '@kb-labs/core-discovery';
import { openCatalog as openCatalogWithVersion } from '@kb-labs/core-registry';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { discoverManifests } from '../discover';
import { registerManifests } from '../register';
import { createRegistry as createCommandRegistry } from '../service';

async function makePlugin(dir: string, id: string, commandPath: string, version = '1.0.0'): Promise<string> {
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'dist', 'run.js'), 'export default async () => 0;');
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: id, version, kb: { manifest: './dist/manifest.js' } }),
  );
  const manifest: ManifestV3 = {
    schema: 'kb.plugin/3',
    id,
    version,
    display: { name: id },
    cli: { commands: [{ path: commandPath, describe: `Command of ${id}`, handler: './run.js' }] },
  };
  // Static manifest only: there is no dist/manifest.js, so nothing here can be import()ed.
  await fs.writeFile(path.join(dir, 'dist', 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

async function writeLock(
  root: string,
  entries: Array<{ id: string; dir: string; source: 'platform' | 'marketplace' | 'local' }>,
): Promise<void> {
  const lock = createEmptyLock();
  for (const { id, dir, source } of entries) {
    const entryOptions = {
      version: '1.0.0',
      integrity: await computePackageIntegrity(dir),
      primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
    };
    if (source === 'local') {
      lock.plugins[id] = createMarketplaceEntry({ ...entryOptions, source, resolvedPath: path.relative(root, dir) });
    } else {
      const packageName = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).name as string;
      lock.plugins[id] = source === 'platform'
        ? createMarketplaceEntry({ ...entryOptions, source, package: packageName, resolvedPath: path.relative(root, dir) })
        : createMarketplaceEntry({ ...entryOptions, source, package: packageName,
            marketplaceSource: 'registry', signatureStatus: 'verified' });
    }
  }
  await writeMarketplaceLock(root, lock);
}

async function writeStorePin(kbHome: string, id: string, dir: string): Promise<void> {
  const integrity = await computePackageIntegrity(dir);
  const entryDir = path.join(kbHome, 'store', 'entries', `${id.replaceAll('/', '+')}@1.0.0`);
  const packageRoot = path.join(entryDir, 'node_modules', ...id.split('/'));
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(dir, packageRoot, { recursive: true });
  await fs.writeFile(path.join(entryDir, 'entry.json'), JSON.stringify({
    schema: 'kb.store-entry/1',
    name: id,
    version: '1.0.0',
    kind: 'plugin',
    integrity,
    installedAt: new Date().toISOString(),
  }, null, 2));
}

const openCatalog = (
  scope: Parameters<typeof openCatalogWithVersion>[0],
  options: Omit<Parameters<typeof openCatalogWithVersion>[1], 'resolvePlatformVersion'> = {},
) => openCatalogWithVersion(scope, { ...options, resolvePlatformVersion: async () => 'test' });

describe('one discovery pipeline: CLI and registry agree', () => {
  let platformRoot: string;
  let projectRoot: string;
  let linkedRoot: string;
  let kbHome: string;
  let previousKbHome: string | undefined;

  beforeEach(async () => {
    platformRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-parity-platform-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-parity-project-'));
    linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-parity-linked-'));
    kbHome = path.join(projectRoot, '.kb-home');
    previousKbHome = process.env.KB_HOME;
    process.env.KB_HOME = kbHome;

    // (i) platform-scope plugin, installed into the platform node_modules
    const platformDir = await makePlugin(path.join(platformRoot, 'node_modules', '@x', 'plat-entry'), '@x/plat', 'plat hello');
    // (ii) project-scope marketplace pin resolved from the shared extension store
    const projectDir = await makePlugin(path.join(projectRoot, 'fixtures', '@x', 'proj-entry'), '@x/proj', 'proj hello');
    // (iii) linked dev plugin living outside both roots, linked into the platform lock
    const linkedDir = await makePlugin(path.join(linkedRoot, 'linked-entry'), '@x/linked', 'linked hello');
    // (iv) workspace plugin: a pnpm workspace package under the platform root, not in any lock
    await makePlugin(path.join(platformRoot, 'packages', 'ws-entry'), '@x/ws', 'ws hello');
    await fs.writeFile(path.join(platformRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    await writeLock(platformRoot, [
      { id: '@x/plat', dir: platformDir, source: 'platform' },
      { id: '@x/linked', dir: linkedDir, source: 'local' },
    ]);
    await writeLock(projectRoot, [{ id: '@x/proj', dir: projectDir, source: 'marketplace' }]);
    await writeStorePin(kbHome, '@x/proj', projectDir);
  });

  afterEach(async () => {
    if (previousKbHome === undefined) {delete process.env.KB_HOME;}
    else {process.env.KB_HOME = previousKbHome;}
    await fs.rm(platformRoot, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(linkedRoot, { recursive: true, force: true });
  });

  async function cliSet(): Promise<Map<string, { source: string; scope: string; manifest: ManifestV3 | undefined }>> {
    const catalog = await openCatalog({ platformRoot, projectRoot });
    const results = await discoverManifests(catalog);
    const out = new Map<string, { source: string; scope: string; manifest: ManifestV3 | undefined }>();
    for (const r of results) {
      const manifest = r.manifests[0]?.v3Manifest;
      out.set(manifest?.id ?? r.packageName, { source: r.source, scope: r.scope, manifest });
    }
    return out;
  }

  it('returns the same plugins with the same manifests', async () => {
    const cli = await cliSet();

    const entityRegistry = await openCatalog({ platformRoot, projectRoot });
    const restIds = entityRegistry.listPlugins().map(p => p.id).sort();

    expect([...cli.keys()].sort()).toEqual(['@x/linked', '@x/plat', '@x/proj', '@x/ws']);
    expect(restIds).toEqual([...cli.keys()].sort());
    for (const id of restIds) {
      expect(cli.get(id)?.manifest).toEqual(entityRegistry.getManifest(id));
    }
  });

  it('two readers opened for one scope report the same generation', async () => {
    const first = await openCatalog({ platformRoot, projectRoot });
    const second = await openCatalog({ platformRoot, projectRoot });
    try {
      expect({ rev: first.snapshot().rev, checksum: first.snapshot().checksum }).toEqual({
        rev: second.snapshot().rev,
        checksum: second.snapshot().checksum,
      });
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it('makes the project-scope install visible to the CLI', async () => {
    const cli = await cliSet();

    expect(cli.get('@x/proj')).toMatchObject({ source: 'node_modules', scope: 'project' });
  });

  it('keeps the source of each plugin: workspace, linked, node_modules', async () => {
    const cli = await cliSet();

    expect(cli.get('@x/ws')).toMatchObject({ source: 'workspace', scope: 'platform' });
    expect(cli.get('@x/linked')).toMatchObject({ source: 'linked', scope: 'platform' });
    expect(cli.get('@x/plat')).toMatchObject({ source: 'node_modules', scope: 'platform' });
  });

  it('registers commands of every source from the discovery result', async () => {
    const results = await discoverManifests(await openCatalog({ platformRoot, projectRoot }));
    const commands = createCommandRegistry();

    const registered = await registerManifests(results, commands);

    expect(registered.errors).toBe(0);
    expect(commands.listCommands().map(c => c.manifest.segments.join(' ')).sort()).toEqual([
      'linked hello',
      'plat hello',
      'proj hello',
      'ws hello',
    ]);
  });

  it('a workspace copy shadows the installed copy of the same plugin', async () => {
    const installed = await makePlugin(path.join(platformRoot, 'node_modules', '@x', 'ws-installed'), '@x/ws', 'ws hello', '0.9.0');
    await writeLock(platformRoot, [{ id: '@x/ws', dir: installed, source: 'platform' }]);

    const cli = await cliSet();

    expect(cli.get('@x/ws')).toMatchObject({ source: 'workspace' });
    expect(cli.get('@x/ws')?.manifest?.version).toBe('1.0.0');
  });

  it('single-root development (KB_PLATFORM_ROOT == project root) keeps working', async () => {
    const results = await discoverManifests(await openCatalog({ platformRoot, projectRoot: platformRoot }));

    expect(results.map(r => r.manifests[0]?.v3Manifest?.id).sort()).toEqual(['@x/linked', '@x/plat', '@x/ws']);
  });
});
