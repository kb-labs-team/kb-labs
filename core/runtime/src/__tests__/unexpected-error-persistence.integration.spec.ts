import { afterAll, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computePackageIntegrity, createEmptyLock, createMarketplaceEntry, DiscoveryManager, findWorkspacePackages, writeMarketplaceLock } from '@kb-labs/core-discovery';
import type { MarketplaceAdapterEntry } from '@kb-labs/plugin-contracts';
import { ADAPTER_DEFAULTS, loadAdapterManifest } from '@kb-labs/core-platform';
import { writeTestPlatformReceipt } from './platform-version-fixture.js';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const cliRoot = path.join(repositoryRoot, 'cli/bin');
const cliEntry = path.join(cliRoot, 'dist/bin.js');
const temporaryRoots: string[] = [];

describe('installed default log persistence across CLI processes', () => {
  afterAll(async () => {
    await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })));
  });

  it('drains a failed plugin command through CLI shutdown and queries it from a second process', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'kb-log-persistence-platform-'));
    temporaryRoots.push(tempRoot);
    const home = path.join(tempRoot, 'home');
    const platformRoot = path.join(tempRoot, 'platform');
    await Promise.all([mkdir(home, { recursive: true }), mkdir(platformRoot, { recursive: true })]);
    writeTestPlatformReceipt(platformRoot);
    const layoutPath = path.join(platformRoot, '.kb/v2/platform-layout.json');
    await mkdir(path.dirname(layoutPath), { recursive: true });
    await copyFile(path.join(repositoryRoot, 'tools/kb-create/v2/contracts/platform-layout.json'), layoutPath);
    await writeFile(path.join(platformRoot, '.kb/kb.config.json'), JSON.stringify({
      gateway: { access: { mode: 'local' } },
    }));
    const stateDataRoot = path.join(platformRoot, 'state/data');
    await mkdir(stateDataRoot, { recursive: true });
    await symlink(stateDataRoot, path.join(platformRoot, '.kb/data'), 'dir');

    const registry = JSON.parse(await readFile(path.join(repositoryRoot, 'e2e/platform/registry-manifest.json'), 'utf8')) as {
      adapters: Array<{ name: string }>;
    };
    const workspacePackages = new Map((await findWorkspacePackages(repositoryRoot))
      .map(candidate => [candidate.packageName, candidate.packageRoot]));
    const requiredSlots = Object.entries(ADAPTER_DEFAULTS)
      .filter(([, policy]) => 'preferInstalledDefault' in policy && policy.preferInstalledDefault)
      .map(([slot]) => slot);
    const defaults = new Map<string, { packageName: string; packageRoot: string; slots: string[] }>();
    for (const { name } of registry.adapters) {
      const packageRoot = workspacePackages.get(name);
      if (!packageRoot) { continue; }
      const loaded = await loadAdapterManifest({ packageRoot });
      if (loaded.kind === 'failed') { throw new Error(`${name}: ${loaded.reason}`); }
      if (loaded.kind !== 'adapter') { continue; }
      const slots = Object.keys(loaded.manifest.defaultFor ?? {});
      if (slots.length) { defaults.set(name, { packageName: name, packageRoot, slots }); }
    }
    const manifestSlots = [...new Set([...defaults.values()].flatMap(adapter => adapter.slots))];
    const selected = new Map<string, { packageName: string; packageRoot: string }>();
    for (const slot of new Set([...requiredSlots, ...manifestSlots])) {
      const candidates = [...defaults.values()].filter(adapter => adapter.slots.includes(slot));
      if (!candidates.length) { continue; }
      expect(candidates, `zero-config default for ${slot}`).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate) { selected.set(candidate.packageName, candidate); }
    }
    const logPersistenceDefault = [...selected.values()].find(adapter =>
      defaults.get(adapter.packageName)?.slots.includes('logPersistence'));
    expect(logPersistenceDefault?.packageName).toBe('@kb-labs/adapters-log-document');

    const adapters: Record<string, MarketplaceAdapterEntry> = {};
    for (const { packageName: name, packageRoot } of selected.values()) {
      const packagePath = path.join(platformRoot, 'node_modules', name);
      await mkdir(path.dirname(packagePath), { recursive: true });
      await symlink(packageRoot, packagePath, 'dir');
      const entry = createMarketplaceEntry({
        version: '2.120.1',
        integrity: 'sha512-aW50ZWdyYXRpb24=',
        primaryKind: 'adapter',
        provides: ['adapter'],
        source: 'platform',
        package: name,
        resolvedPath: path.relative(platformRoot, packagePath),
      });
      if (entry.source !== 'platform') { throw new Error(`expected an installed adapter entry for ${name}`); }
      adapters[name] = { ...entry, enabled: true };
    }
    await writeMarketplaceLock(platformRoot, { ...createEmptyLock(), adapters });

    const pluginName = '@kb-labs/x57-shutdown-failure-fixture';
    const pluginRoot = path.join(platformRoot, 'node_modules', pluginName);
    const pluginDist = path.join(pluginRoot, 'dist');
    await mkdir(pluginDist, { recursive: true });
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
      name: pluginName,
      version: '1.0.0',
      type: 'module',
      kb: { manifest: './dist/manifest.js' },
    }));
    await writeFile(path.join(pluginDist, 'manifest.json'), JSON.stringify({
      schema: 'kb.plugin/3',
      id: pluginName,
      version: '1.0.0',
      cli: { commands: [{
        path: 'x57-shutdown-failure-fixture fail',
        describe: 'Fail after platform logging is initialized for shutdown persistence coverage.',
        handler: './handler.js#execute',
      }] },
    }));
    await writeFile(path.join(pluginDist, 'handler.js'), [
      'export async function execute() {',
      '  throw new Error("failure after log persistence initialization");',
      '}',
    ].join('\n'));
    const fixturePlugins = { [pluginName]: createMarketplaceEntry({
      version: '1.0.0',
      integrity: await computePackageIntegrity(pluginRoot),
      primaryKind: 'plugin',
      provides: ['plugin'],
      source: 'platform',
      package: pluginName,
      resolvedPath: path.relative(platformRoot, pluginRoot),
    }) };
    await writeMarketplaceLock(platformRoot, { ...createEmptyLock(), adapters, plugins: fixturePlugins });
    const discovery = await new DiscoveryManager({ root: platformRoot, platformRoot }).discover();
    expect(discovery.plugins.map(plugin => plugin.id), JSON.stringify(discovery)).toContain(pluginName);

    const env = cleanEnvironment(home, platformRoot);
    env.KB_LOG_LEVEL = 'info';
    const produced = spawnSync(process.execPath, [cliEntry, 'x57-shutdown-failure-fixture', 'fail', '--json'], {
      cwd: platformRoot, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(produced.status, `${produced.stderr}\n${produced.stdout}`).toBe(1);
    expect(produced.signal).toBeNull();
    const outputEnvelopes = produced.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      ok: boolean;
      error?: { code?: string; correlationId?: string; cause?: unknown; stack?: unknown };
    });
    const failure = outputEnvelopes.find(envelope => envelope.error?.code === 'KB_PLUGIN_COMMAND_FAILED');
    expect(failure, `${produced.stderr}\n${produced.stdout}`).toBeDefined();
    if (!failure) { throw new Error('built CLI process handler did not render KB_PLUGIN_COMMAND_FAILED'); }
    expect(failure.ok).toBe(false);
    expect(failure.error?.code).toBe('KB_PLUGIN_COMMAND_FAILED');
    const correlationId = failure.error?.correlationId;
    expect(correlationId).toBeTruthy();
    if (!correlationId) { throw new Error('built CLI error envelope omitted its correlation ID'); }
    expect(failure.error).not.toHaveProperty('cause');
    expect(failure.error).not.toHaveProperty('stack');

    const queried = spawnSync(process.execPath, [cliEntry, 'logs', 'query', '--correlation-id', correlationId, '--json'], {
      cwd: platformRoot, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(queried.status, queried.stderr || queried.stdout).toBe(0);
    const envelope = JSON.parse(queried.stdout) as {
      ok: boolean;
      data?: { data?: { logs?: Array<Record<string, unknown>> } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.data).toMatchObject({ source: 'persistence' });
    const record = envelope.data?.data?.logs?.find(log => log.correlationId === correlationId);
    expect(record, JSON.stringify(envelope)).toBeDefined();
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).toContain('failure after log persistence initialization');
  }, 40_000);
});

function cleanEnvironment(home: string, platformRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: path.dirname(home),
    KB_PLATFORM_ROOT: platformRoot,
    KB_DIAGNOSTICS: 'agent',
  };
}
