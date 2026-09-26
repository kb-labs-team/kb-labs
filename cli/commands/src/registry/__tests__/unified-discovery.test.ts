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
import { createRegistry as createEntityRegistry } from '@kb-labs/core-registry';
import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { discoverManifests } from '../discover';
import { registerManifests } from '../register';
import { createRegistry as createCommandRegistry } from '../service';

async function makePlugin(dir: string, id: string, commandPath: string, version = '1.0.0'): Promise<string> {
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: id, version, kb: { manifest: './dist/manifest.js' } }),
  );
  const manifest: ManifestV3 = {
    schema: 'kb.plugin/3',
    id,
    version,
    display: { name: id },
    cli: { commands: [{ path: commandPath, describe: `Command of ${id}`, handler: './dist/run.js' }] },
  };
  // Static manifest only: there is no dist/manifest.js, so nothing here can be import()ed.
  await fs.writeFile(path.join(dir, 'dist', 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

async function writeLock(
  root: string,
  entries: Array<{ id: string; dir: string; source: 'marketplace' | 'local' }>,
): Promise<void> {
  const lock = createEmptyLock();
  for (const { id, dir, source } of entries) {
    lock.installed[id] = createMarketplaceEntry({
      version: '1.0.0',
      integrity: await computePackageIntegrity(dir),
      resolvedPath: path.relative(root, dir),
      source,
      primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
    });
  }
  await writeMarketplaceLock(root, lock);
}

describe('one discovery pipeline: CLI and registry agree', () => {
  let platformRoot: string;
  let projectRoot: string;
  let linkedRoot: string;

  beforeEach(async () => {
    platformRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-parity-platform-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-parity-project-'));
    linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-parity-linked-'));

    // (i) platform-scope plugin, installed into the platform node_modules
    const platformDir = await makePlugin(path.join(platformRoot, 'node_modules', '@x', 'plat-entry'), '@x/plat', 'plat hello');
    // (ii) project-scope plugin, installed into the project's own node_modules
    const projectDir = await makePlugin(path.join(projectRoot, 'node_modules', '@x', 'proj-entry'), '@x/proj', 'proj hello');
    // (iii) linked dev plugin living outside both roots, linked into the platform lock
    const linkedDir = await makePlugin(path.join(linkedRoot, 'linked-entry'), '@x/linked', 'linked hello');
    // (iv) workspace plugin: a pnpm workspace package under the platform root, not in any lock
    await makePlugin(path.join(platformRoot, 'packages', 'ws-entry'), '@x/ws', 'ws hello');
    await fs.writeFile(path.join(platformRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    await writeLock(platformRoot, [
      { id: '@x/plat', dir: platformDir, source: 'marketplace' },
      { id: '@x/linked', dir: linkedDir, source: 'local' },
    ]);
    await writeLock(projectRoot, [{ id: '@x/proj', dir: projectDir, source: 'marketplace' }]);
  });

  afterEach(async () => {
    await fs.rm(platformRoot, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(linkedRoot, { recursive: true, force: true });
  });

  async function cliSet(): Promise<Map<string, { source: string; scope: string; manifest: ManifestV3 | undefined }>> {
    const results = await discoverManifests(projectRoot, { platformRoot, projectRoot });
    const out = new Map<string, { source: string; scope: string; manifest: ManifestV3 | undefined }>();
    for (const r of results) {
      const manifest = r.manifests[0]?.manifestV2;
      out.set(manifest?.id ?? r.packageName, { source: r.source, scope: r.scope, manifest });
    }
    return out;
  }

  it('returns the same plugins with the same manifests', async () => {
    const cli = await cliSet();

    const entityRegistry = await createEntityRegistry({ root: projectRoot, platformRoot });
    const restIds = entityRegistry.listPlugins().map(p => p.id).sort();

    expect([...cli.keys()].sort()).toEqual(['@x/linked', '@x/plat', '@x/proj', '@x/ws']);
    expect(restIds).toEqual([...cli.keys()].sort());
    for (const id of restIds) {
      expect(cli.get(id)?.manifest).toEqual(entityRegistry.getManifest(id));
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
    const results = await discoverManifests(projectRoot, { platformRoot, projectRoot });
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
    await writeLock(platformRoot, [{ id: '@x/ws', dir: installed, source: 'marketplace' }]);

    const cli = await cliSet();

    expect(cli.get('@x/ws')).toMatchObject({ source: 'workspace' });
    expect(cli.get('@x/ws')?.manifest?.version).toBe('1.0.0');
  });

  it('single-root development (KB_PLATFORM_ROOT == project root) keeps working', async () => {
    const results = await discoverManifests(platformRoot);

    expect(results.map(r => r.manifests[0]?.manifestV2?.id).sort()).toEqual(['@x/linked', '@x/plat', '@x/ws']);
  });
});
