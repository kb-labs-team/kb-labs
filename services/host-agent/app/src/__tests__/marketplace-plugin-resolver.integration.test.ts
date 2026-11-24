import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalizeProjectPath, deriveProjectId } from '@kb-labs/core-project-registry';
import { createEmptyLock, createMarketplaceEntry, writeMarketplaceLock } from '@kb-labs/core-discovery';
import { createExtensionStore, PnpmInstaller } from '@kb-labs/core-extension-store';
import { LocalPluginResolver } from '../handlers/local-plugin-resolver.js';

describe('Host Agent Marketplace command resolver', () => {
  let root: string | undefined;
  const previousKbHome = process.env.KB_HOME;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    root = undefined;
    if (previousKbHome === undefined) {
      delete process.env.KB_HOME;
    } else {
      process.env.KB_HOME = previousKbHome;
    }
  });

  it('resolves only the exact approved store pin and manifest-declared handler', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kb-marketplace-resolver-'));
    const kbHome = path.join(root, 'home', '.kb');
    const projectRoot = path.join(root, 'project');
    const packageRoot = path.join(root, 'package');
    const pluginId = '@journey/registry-canonical';
    const version = '1.0.2';
    const manifest = {
      schema: 'kb.plugin/3',
      id: pluginId,
      version,
      permissions: { fs: { read: ['.'], write: [] } },
      cli: { commands: [{ path: 'journey-smoke run', describe: 'Run fixture', handler: 'dist/commands/show-plan.js#showPlan' }] },
    };
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(packageRoot, 'dist', 'commands'), { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: pluginId, version }));
    await writeFile(path.join(packageRoot, 'dist', 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(packageRoot, 'dist', 'commands', 'show-plan.js'), `export const showPlan = { async execute() { return { source: 'store' }; } };`);

    process.env.KB_HOME = kbHome;
    const store = createExtensionStore({ root: kbHome, installer: new PnpmInstaller() });
    const installed = await store.resolve({ name: pluginId, version, kind: 'plugin', spec: `file:${packageRoot}` });
    const otherPackageRoot = path.join(root, 'other-package');
    await mkdir(path.join(otherPackageRoot, 'dist', 'commands'), { recursive: true });
    await writeFile(path.join(otherPackageRoot, 'package.json'), JSON.stringify({ name: pluginId, version: '1.0.3' }));
    await writeFile(path.join(otherPackageRoot, 'dist', 'manifest.json'), JSON.stringify({ ...manifest, version: '1.0.3' }));
    await writeFile(path.join(otherPackageRoot, 'dist', 'commands', 'show-plan.js'), `export const showPlan = { async execute() { return { source: 'other-version' }; } };`);
    const installedOtherVersion = await store.resolve({
      name: pluginId,
      version: '1.0.3',
      kind: 'plugin',
      spec: `file:${otherPackageRoot}`,
    });
    const lock = createEmptyLock();
    lock.plugins[pluginId] = createMarketplaceEntry({
      version,
      integrity: installed.entry.integrity,
      source: 'marketplace',
      package: pluginId,
      primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
      marketplaceSource: 'npm',
      signatureStatus: 'unsigned',
    });
    await writeMarketplaceLock(projectRoot, lock, 'project');

    const request = {
      projectId: deriveProjectId(await canonicalizeProjectPath(projectRoot)),
      pluginId,
      commandPath: 'journey-smoke run',
      requestId: 'resolver-request-1',
      executionId: 'resolver-execution-1',
      input: { argv: ['run'], flags: { json: true } },
    };

    const policy = { approvedPins: [{ package: pluginId, version, integrity: installed.entry.integrity }] };
    const resolver = new LocalPluginResolver([projectRoot], policy);
    const resolved = await resolver.resolveMarketplace(request);
    expect(resolved.pluginRoot).toBe(await realpath(installed.packageRoot));
    expect(resolved.handlerPath).toBe(`${path.join(resolved.pluginRoot, 'dist', 'commands', 'show-plan.js')}#showPlan`);
    expect(resolved.projectRoot).toBe(await canonicalizeProjectPath(projectRoot));
    expect(resolved.descriptor.permissions).toEqual({ fs: { read: ['.'], write: [] } });
    expect(resolved.descriptor.hostContext).toMatchObject({ host: 'cli', argv: ['run'], flags: { json: true } });

    await expect(new LocalPluginResolver([projectRoot], {
      approvedPins: [{ package: pluginId, version: '9.9.9', integrity: installed.entry.integrity }],
    }).resolveMarketplace(request)).rejects.toThrow(/not approved by Host Agent policy/);
    await expect(new LocalPluginResolver([projectRoot], {
      approvedPins: [{ package: pluginId, version, integrity: 'sha512-wrong' }],
    }).resolveMarketplace(request)).rejects.toThrow(/not approved by Host Agent policy/);

    lock.plugins[pluginId]!.enabled = false;
    await writeMarketplaceLock(projectRoot, lock, 'project');
    await expect(resolver.resolveMarketplace(request)).rejects.toThrow(/not enabled and pinned/);

    lock.plugins[pluginId]!.enabled = true;
    await writeMarketplaceLock(projectRoot, lock, 'project');
    const externalHandler = path.join(root, 'outside-handler.js');
    await writeFile(externalHandler, `export const showPlan = { async execute() { return { source: 'outside' }; } };`);
    const storedHandler = path.join(installed.packageRoot, 'dist', 'commands', 'show-plan.js');
    await rm(storedHandler);
    await symlink(externalHandler, storedHandler);
    await expect(resolver.resolveMarketplace(request)).rejects.toThrow(/inside the installed package dist directory/);

    const installedPackagePath = installed.packageRoot;
    await rm(installedPackagePath);
    await symlink(installedOtherVersion.packageRoot, installedPackagePath, 'dir');
    await expect(resolver.resolveMarketplace(request)).rejects.toThrow(/outside the exact pinned extension store entry/);
  }, 60_000);
});
