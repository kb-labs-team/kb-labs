import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectRegistry } from '@kb-labs/core-project-registry';

const mocks = vi.hoisted(() => ({
  resolveProjectConfig: vi.fn(),
  initializePlatform: vi.fn(),
}));

vi.mock('../platform-init.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform-init.js')>();
  return {
    ...actual,
    resolveProjectConfig: vi.fn(async (...args: Parameters<typeof actual.resolveProjectConfig>) => {
      mocks.resolveProjectConfig(...args);
      return actual.resolveProjectConfig(...args);
    }),
    initializePlatform: mocks.initializePlatform,
  };
});

import { executeCli } from '../bootstrap.js';
import { registry } from '@kb-labs/cli-commands';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');

describe('installed project plugin routes at CLI bootstrap', () => {
  let temporaryRoot: string | undefined;
  const originalEnv = { ...process.env };
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush: async () => {},
    child() { return logger; },
  };
  const platform = { logger, getAdapter: () => undefined };

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('discovers the packed enabled plugin in a registered project before resolving its help route', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-installed-plugin-bootstrap-'));
    const home = path.join(temporaryRoot, 'home');
    const kbHome = path.join(home, '.kb');
    const platformRoot = path.join(temporaryRoot, 'platform');
    const projectRoot = path.join(temporaryRoot, 'registered-project');
    const packedRoot = path.join(temporaryRoot, 'packed');
    const unpackedRoot = path.join(temporaryRoot, 'unpacked');
    const pluginRoot = path.join(workspaceRoot, 'plugins', 'commit');
    const packageName = '@kb-labs/commit';
    const version = '2.120.1';
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(path.join(platformRoot, '.kb'), { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(packedRoot, { recursive: true }),
      mkdir(unpackedRoot, { recursive: true }),
    ]);
    process.env.HOME = home;
    process.env.KB_HOME = kbHome;
    process.env.KB_PLATFORM_ROOT = platformRoot;
    process.env.KB_LOG_LEVEL = 'silent';
    process.env.CLI_VERSION = '2.120.1';
    delete process.env.KB_NET_OFFSET;
    await writeFile(path.join(platformRoot, '.kb', 'kb.config.json'), JSON.stringify({
      gateway: { access: { mode: 'local' } },
      platform: { adapters: {} },
    }));
    await mkdir(path.join(projectRoot, '.kb'), { recursive: true });
    await writeFile(path.join(projectRoot, '.kb', 'kb.config.jsonc'), '{}\n');

    const env = { ...process.env, HOME: home, KB_HOME: kbHome, KB_PLATFORM_ROOT: platformRoot, CLI_VERSION: '2.120.1' };
    await createProjectRegistry({ env }).add(projectRoot);

    const packedJson = execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', packedRoot,
    ], {
      cwd: pluginRoot,
      encoding: 'utf8',
      env: { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const [packed] = JSON.parse(packedJson) as Array<{ filename: string }>;
    if (!packed) throw new Error('npm pack did not produce the Commit package');
    execFileSync('tar', ['-xzf', path.join(packedRoot, packed.filename), '-C', unpackedRoot, '--strip-components=1']);
    const manifestPath = path.join(unpackedRoot, 'dist', 'manifest.json');
    const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      id: string;
      cli?: { commands?: Array<{ path: string }> };
    };

    const extensionStorePath = path.join(workspaceRoot, 'core', 'extension-store', 'dist', 'index.js');
    const extensionStore = await import(pathToFileURL(extensionStorePath).href) as {
      createExtensionStore(options: {
        root: string;
        installer: {
          install(options: { name: string; projectDir: string }): Promise<{ integrity: string; packageRoot: string }>;
        };
      }): {
        resolve(request: {
          name: string;
          version: string;
          kind: 'plugin';
          spec: string;
          expectedIntegrity: string;
        }): Promise<unknown>;
      };
    };
    const discoveryPath = path.join(workspaceRoot, 'core', 'discovery', 'dist', 'index.js');
    const discovery = await import(pathToFileURL(discoveryPath).href) as {
      computePackageIntegrity(root: string): Promise<string>;
      createEmptyLock(): { plugins: Record<string, unknown> };
      createMarketplaceEntry(options: {
        version: string;
        integrity: string;
        source: 'marketplace';
        package: string;
        primaryKind: 'plugin';
        provides: ['plugin', 'cli-command'];
        marketplaceSource: 'npm';
        signatureStatus: 'unsigned';
      }): unknown;
      writeMarketplaceLock(root: string, lock: unknown, scope: 'project'): Promise<void>;
    };
    const integrity = await discovery.computePackageIntegrity(unpackedRoot);
    const store = extensionStore.createExtensionStore({
      root: kbHome,
      installer: {
        async install({ name, projectDir }) {
          const packageRoot = path.join(projectDir, 'node_modules', ...name.split('/'));
          await mkdir(path.dirname(packageRoot), { recursive: true });
          await cp(unpackedRoot, packageRoot, { recursive: true });
          return { integrity, packageRoot };
        },
      },
    });
    await store.resolve({ name: packageName, version, kind: 'plugin', spec: packed.filename, expectedIntegrity: integrity });
    const lock = discovery.createEmptyLock();
    lock.plugins[packageName] = discovery.createMarketplaceEntry({
      version,
      integrity,
      source: 'marketplace',
      package: packageName,
      primaryKind: 'plugin',
      provides: ['plugin', 'cli-command'],
      marketplaceSource: 'npm',
      signatureStatus: 'unsigned',
    });
    await discovery.writeMarketplaceLock(projectRoot, lock, 'project');

    mocks.initializePlatform.mockImplementation(async (config) => ({ ...config, platform }));

    expect(registry.resolve(['commit']).type).toBe('not-found');
    const exitCode = await executeCli(['commit', '--help'], { cwd: projectRoot, env });

    expect(exitCode).toBe(0);
    expect(mocks.resolveProjectConfig).toHaveBeenCalledExactlyOnceWith(projectRoot, undefined);
    expect(registry.resolve(['commit']).type).toBe('group');
    const commandPaths = packageManifest.cli?.commands?.map(({ path: commandPath }) => commandPath) ?? [];
    expect(commandPaths.length).toBeGreaterThan(0);
    for (const commandPath of commandPaths) {
      expect(registry.resolve(commandPath.split(/\s+/)).type, commandPath).toBe('command');
    }
  }, 60_000);
});
