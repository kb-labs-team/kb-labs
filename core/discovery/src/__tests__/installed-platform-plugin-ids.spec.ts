import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveryManager } from '../discovery-manager.js';

describe('installed platform plugin identities', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  // case: S-179.14
  it('discovers the sealed platform plugin set using manifest IDs in the lock', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-discovery-installed-plugin-ids-'));
    const platformRoot = path.join(tempRoot, 'platform');
    const projectRoot = path.join(tempRoot, 'project');
    const sourceRoot = path.join(workspaceRoot, 'plugins/commit');
    const installedPluginRoot = path.join(platformRoot, 'node_modules', '@kb-labs', 'commit');
    await Promise.all([
      fs.mkdir(path.join(platformRoot, '.kb'), { recursive: true }),
      fs.mkdir(projectRoot, { recursive: true }),
      fs.mkdir(path.dirname(installedPluginRoot), { recursive: true }),
    ]);
    await fs.cp(sourceRoot, installedPluginRoot, { recursive: true });

    const pluginPackages = [
      { id: '@kb-labs/commit', package: '@kb-labs/commit', root: installedPluginRoot },
    ];
    const plugins = Object.fromEntries(pluginPackages.map(({ id, package: packageName, root }) => [id, {
      version: '2.120.1',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      package: packageName,
      resolvedPath: path.relative(platformRoot, root),
      source: 'platform',
      enabled: true,
    }]));
    await fs.writeFile(path.join(platformRoot, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3', plugins,
    }));

    const discovery = await new DiscoveryManager({
      root: projectRoot,
      platformRoot,
      workspace: false,
      verifyIntegrity: false,
    }).discover();
    expect(discovery.plugins.map(plugin => plugin.id).sort()).toEqual(pluginPackages.map(plugin => plugin.id).sort());
    expect(discovery.diagnostics.filter(event => event.code === 'PLUGIN_ID_MISMATCH')).toEqual([]);
  });
});
