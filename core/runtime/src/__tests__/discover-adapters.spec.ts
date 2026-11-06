import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverAdapters } from '../discover-adapters.js';
import { AdapterUnavailableError } from '@kb-labs/core-platform';
import { writeTestPlatformReceipt } from './platform-version-fixture.js';

describe('discoverAdapters (lock-based)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-adapters-'));
    writeTestPlatformReceipt(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map when no lock file exists', async () => {
    const result = await discoverAdapters(tmpDir);
    expect(result.size).toBe(0);
  });

  it('returns empty map when lock has no adapters', async () => {
    await writeLock(tmpDir, {
      '@test/plugin': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './packages/plugin',
        source: 'platform',
      },
    });

    const result = await discoverAdapters(tmpDir);
    expect(result.size).toBe(0);
  });

  it('skips disabled adapters', async () => {
    await writeLock(tmpDir, {
      '@test/adapter': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './packages/adapter',
        source: 'platform',
        enabled: false,
      },
    });

    const result = await discoverAdapters(tmpDir);
    expect(result.size).toBe(0);
  });

  it('skips adapters without built dist', async () => {
    await writeLock(tmpDir, {
      '@test/adapter': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './packages/adapter',
        source: 'platform',
      },
    });

    // Create package dir but no dist
    const pkgDir = path.join(tmpDir, 'packages', 'adapter');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), '{"name":"@test/adapter"}');

    const result = await discoverAdapters(tmpDir);
    expect(result.size).toBe(0);
  });

  it('discovers adapter with createAdapter export', async () => {
    const pkgDir = path.join(tmpDir, 'packages', 'my-adapter');
    const distDir = path.join(pkgDir, 'dist');
    await fs.mkdir(distDir, { recursive: true });

    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@test/my-adapter', type: 'module', kb: { adapter: { manifest: './dist/manifest.js' } } }),
    );

    await fs.writeFile(
      path.join(distDir, 'manifest.js'),
      validAdapterManifest('ITestAdapter'),
    );

    await fs.writeFile(
      path.join(distDir, 'index.js'),
      'export function createAdapter(config) { return { type: "test", config }; }\n',
    );

    await writeLock(tmpDir, {
      '@test/my-adapter': {
        version: '1.0.0',
        integrity: 'sha256-abc',
        resolvedPath: './packages/my-adapter',
        source: 'platform',
        primaryKind: 'adapter',
      },
    });

    const result = await discoverAdapters(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has('@test/my-adapter')).toBe(true);

    const adapter = result.get('@test/my-adapter')!;
    expect(typeof adapter.createAdapter).toBe('function');
    expect(adapter.packageName).toBe('@test/my-adapter');

    const instance = adapter.createAdapter({ key: 'value' }) as Record<string, unknown>;
    expect((instance as Record<string, unknown>).type).toBe('test');
    expect((instance.config as Record<string, unknown>).key).toBe('value');
  });

  // case: S-179.5
  it('loads a built adapter directly from its workspace package without a marketplace lock', async () => {
    const packageRoot = path.join(tmpDir, 'adapters', 'sqlite');
    const distDir = path.join(packageRoot, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/adapters-sqlite',
      type: 'module',
      kb: { adapter: { manifest: './dist/manifest.js' } },
    }));
    await fs.writeFile(path.join(distDir, 'manifest.js'), validAdapterManifest('IDocumentDatabase'));
    await fs.writeFile(path.join(distDir, 'index.js'), 'export function createAdapter() { return {}; }');

    const result = await discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@kb-labs/adapters-sqlite', slot: 'documentDatabase' }],
    });

    expect(result.get('@kb-labs/adapters-sqlite')).toMatchObject({ packageName: '@kb-labs/adapters-sqlite', pkgRoot: packageRoot });
  });

  // case: S-179.5
  it('loads workspace CLI adapters from the CLI workspace when platform root is isolated', async () => {
    const platformRoot = path.join(tmpDir, 'home', 'platform');
    const workspaceRoot = path.join(tmpDir, 'checkout');
    writeTestPlatformReceipt(workspaceRoot);
    const packageRoot = path.join(workspaceRoot, 'adapters', 'fs');
    const distDir = path.join(packageRoot, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@kb-labs/adapters-fs',
      type: 'module',
      kb: { adapter: { manifest: './dist/manifest.js' } },
    }));
    await fs.writeFile(path.join(distDir, 'manifest.js'), validAdapterManifest('IStorage'));
    await fs.writeFile(path.join(distDir, 'index.js'), 'export function createAdapter() { return {}; }');

    const result = await discoverAdapters(platformRoot, {
      development: true,
      workspaceRoot,
      configuredPackages: [{ packageName: '@kb-labs/adapters-fs', slot: 'storage' }],
    });

    expect(result.get('@kb-labs/adapters-fs')).toMatchObject({ packageName: '@kb-labs/adapters-fs', pkgRoot: packageRoot });
  });

  it('classifies configured workspace adapters from their declared manifest, not package names', async () => {
    const adapterRoot = path.join(tmpDir, 'packages', 'storage');
    await writeWorkspacePackage(tmpDir, adapterRoot, '@example/storage', `${validAdapterManifest('IStorage')} export function createAdapter() { return {}; }`);

    const result = await discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@example/storage', slot: 'storage' }],
    });

    expect(result.has('@example/storage')).toBe(true);
  });

  // case: S-179.11
  it('rejects a configured package with an adapter-like name when its manifest does not classify it as an adapter', async () => {
    const impostorRoot = path.join(tmpDir, 'packages', 'impostor');
    await writeWorkspacePackage(tmpDir, impostorRoot, '@kb-labs/adapters-not-an-adapter', 'export const manifest = { name: "not an adapter" }; export function createAdapter() { return {}; }');

    await expect(discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@kb-labs/adapters-not-an-adapter', slot: 'logger' }],
    })).rejects.toMatchObject({
      name: 'AdapterUnavailableError',
      slot: 'logger',
      hint: expect.stringContaining('platform.adapters.logger'),
    });
  });

  it('loads only configured workspace packages', async () => {
    const configuredRoot = path.join(tmpDir, 'packages', 'configured');
    const unrelatedRoot = path.join(tmpDir, 'packages', 'unrelated');
    await writeWorkspacePackage(tmpDir, configuredRoot, '@example/configured', `${validAdapterManifest('IStorage')} export function createAdapter() { return {}; }`);
    await writeWorkspacePackage(tmpDir, unrelatedRoot, '@kb-labs/adapters-unrelated', `${validAdapterManifest('ICache')} export function createAdapter() { throw new Error("must not import unconfigured adapter"); }`);

    const result = await discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@example/configured', slot: 'storage' }],
    });

    expect([...new Set([...result.values()].map(adapter => adapter.packageName))]).toEqual(['@example/configured']);
  });

  // case: S-179.11
  it('fails when a configured workspace package manifest has no implements value', async () => {
    const packageRoot = path.join(tmpDir, 'packages', 'invalid');
    await writeWorkspacePackage(tmpDir, packageRoot, '@example/invalid', 'export const manifest = { name: "not an adapter" }; export function createAdapter() { return {}; }');

    await expect(discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@example/invalid', slot: 'storage' }],
    })).rejects.toMatchObject({
      name: 'AdapterUnavailableError',
      slot: 'storage',
      reason: 'load-failed',
      message: expect.stringContaining('@example/invalid'),
      hint: expect.stringContaining('platform.adapters'),
      action: { command: 'node ./cli/bin/dist/bin.js qa cases validate --json' },
    });
  });

  // case: S-179.11
  it('fails when a configured workspace adapter does not export createAdapter', async () => {
    const packageRoot = path.join(tmpDir, 'packages', 'invalid');
    await writeWorkspacePackage(tmpDir, packageRoot, '@example/invalid', validAdapterManifest('IStorage'));

    await expect(discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@example/invalid', slot: 'storage' }],
    })).rejects.toMatchObject({
      name: 'AdapterUnavailableError',
      slot: 'storage',
      reason: 'load-failed',
      hint: expect.stringContaining('platform.adapters.storage'),
      action: { command: 'node ./cli/bin/dist/bin.js qa cases validate --json' },
    });
  });

  it('does not activate workspace packages in an installed platform with pnpm-workspace.yaml', async () => {
    const adapterRoot = path.join(tmpDir, 'packages', 'built');
    const packageName = '@kb-labs/adapters-installed-workspace';
    await writeWorkspacePackage(tmpDir, adapterRoot, packageName, `${validAdapterManifest('IStorage')} export function createAdapter() { return {}; }`);

    const result = await discoverAdapters(tmpDir, {
      development: false,
      configuredPackages: [{ packageName, slot: 'storage' }],
    });

    expect(result.has(packageName)).toBe(false);
  });

  it('never resolves a workspace adapter from the project root', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-workspace-'));
    try {
      const projectPackage = '@kb-labs/adapters-project';
      await writeWorkspacePackage(projectRoot, path.join(projectRoot, 'packages', 'project'), projectPackage, `${validAdapterManifest('IStorage')} export function createAdapter() { return {}; }`);
      const result = await discoverAdapters(tmpDir, {
        development: true,
        workspaceRoot: tmpDir,
        configuredPackages: [{ packageName: projectPackage, slot: 'storage' }],
      });
      expect(result.has(projectPackage)).toBe(false);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports a configured unbuilt workspace adapter with a typed build hint', async () => {
    const packageRoot = path.join(tmpDir, 'packages', 'unbuilt');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@example/unbuilt', kb: { adapter: { manifest: './dist/manifest.js' } } }));

    const failure = discoverAdapters(tmpDir, {
      development: true,
      workspaceRoot: tmpDir,
      configuredPackages: [{ packageName: '@example/unbuilt', slot: 'storage' }],
    });
    await expect(failure).rejects.toBeInstanceOf(AdapterUnavailableError);
    await expect(failure).rejects.toMatchObject({
      slot: 'storage',
      reason: 'load-failed',
      hint: expect.stringContaining('Build'),
      action: { command: 'pnpm build' },
    });
  });
});

// ---------------------------------------------------------------------------
// Two-root (prod mode): project wins over platform
// ---------------------------------------------------------------------------

describe('discoverAdapters — platform lock is authoritative', () => {
  let platformRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    platformRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-'));
    projectRoot  = await fs.mkdtemp(path.join(os.tmpdir(), 'project-'));
    writeTestPlatformReceipt(platformRoot);
  });

  afterEach(async () => {
    await fs.rm(platformRoot, { recursive: true, force: true });
    await fs.rm(projectRoot,  { recursive: true, force: true });
  });

  it('returns empty when neither root has a lock', async () => {
    const result = await discoverAdapters(platformRoot);
    expect(result.size).toBe(0);
  });

  it('returns platform-only adapters when project lock is absent', async () => {
    await buildAdapter(platformRoot, 'platform-adapter', '@test/platform-adapter', 'platform-v1');
    const result = await discoverAdapters(platformRoot);
    expect(result.size).toBe(1);
    const adapter = result.get('@test/platform-adapter')!;
    expect(adapter).toBeDefined();
    const instance = adapter.createAdapter({}) as Record<string, unknown>;
    expect(instance['source']).toBe('platform-v1');
  });

  it('does not discover adapters from a project lock', async () => {
    await buildAdapter(projectRoot, 'project-adapter', '@test/project-adapter', 'project-v1');
    const result = await discoverAdapters(platformRoot);
    expect(result.size).toBe(0);
  });

  it('platform adapter remains selected when a project lock has the same id', async () => {
    await buildAdapter(platformRoot, 'shared-adapter', '@test/shared-adapter', 'platform-version');
    await buildAdapter(projectRoot,  'shared-adapter', '@test/shared-adapter', 'project-version');

    const result = await discoverAdapters(platformRoot);
    expect(result.size).toBe(1);

    const adapter = result.get('@test/shared-adapter')!;
    expect(adapter).toBeDefined();
    const instance = adapter.createAdapter({}) as Record<string, unknown>;
    expect(instance['source']).toBe('platform-version');
  });

  it('loads only adapters from the platform lock', async () => {
    await buildAdapter(platformRoot, 'platform-only', '@test/platform-only', 'from-platform');
    await buildAdapter(projectRoot,  'project-only',  '@test/project-only',  'from-project');

    const result = await discoverAdapters(platformRoot);
    expect(result.size).toBe(1);
    expect(result.has('@test/platform-only')).toBe(true);
    expect(result.has('@test/project-only')).toBe(false);
  });

  it('behaves identically when projectRoot === platformRoot (dev mode)', async () => {
    await buildAdapter(platformRoot, 'dev-adapter', '@test/dev-adapter', 'dev');
    const result = await discoverAdapters(platformRoot);
    // Same root: should not double-load or error
    expect(result.size).toBe(1);
    expect(result.has('@test/dev-adapter')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeLock(root: string, installed: Record<string, unknown>): Promise<void> {
  const lockDir = path.join(root, '.kb');
  await fs.mkdir(lockDir, { recursive: true });
  const plugins: Record<string, unknown> = {};
  const adapters: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(installed)) {
    const entry = raw as { primaryKind?: string; version: string; integrity: string; resolvedPath: string; enabled?: boolean };
    const serialized = {
      version: entry.version,
      integrity: entry.integrity,
      ...(entry.primaryKind === 'adapter' ? {} : { package: id }),
      resolvedPath: entry.resolvedPath,
      enabled: entry.enabled ?? true,
      source: 'platform',
    };
    (entry.primaryKind === 'adapter' ? adapters : plugins)[id] = serialized;
  }
  await fs.writeFile(
    path.join(lockDir, 'marketplace.lock'),
    JSON.stringify({ schema: 'kb.marketplace/3', plugins, ...(Object.keys(adapters).length ? { adapters } : {}) }, null, 2),
  );
}

/**
 * Creates a built adapter package + lock entry in `root`.
 * The adapter's `createAdapter` returns `{ source: tag }` so tests can identify
 * which root the loaded module came from.
 */
async function buildAdapter(
  root: string,
  pkgSlug: string,
  pkgName: string,
  tag: string,
): Promise<void> {
  const pkgDir  = path.join(root, 'packages', pkgSlug);
  const distDir = path.join(pkgDir, 'dist');
  await fs.mkdir(distDir, { recursive: true });

  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkgName, type: 'module', kb: { adapter: { manifest: './dist/manifest.js' } } }),
  );
  await fs.writeFile(path.join(distDir, 'manifest.js'), validAdapterManifest('ITestAdapter'));
  await fs.writeFile(
    path.join(distDir, 'index.js'),
    `export function createAdapter() { return { source: "${tag}" }; }\n`,
  );

  await writeLock(root, {
    [pkgName]: {
      version: '1.0.0',
      integrity: 'sha256-test',
      resolvedPath: `./packages/${pkgSlug}`,
      source: 'platform',
      primaryKind: 'adapter',
      provides: ['adapter'],
    },
  });
}

async function writeWorkspacePackage(workspaceRoot: string, packageRoot: string, packageName: string, indexSource: string): Promise<void> {
  const distDir = path.join(packageRoot, 'dist');
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    kb: { adapter: { manifest: './dist/manifest.js' } },
  }));
  await fs.writeFile(path.join(distDir, 'manifest.js'), indexSource.replace('createAdapter', 'unusedFactory'));
  await fs.writeFile(path.join(distDir, 'index.js'), indexSource);
  await fs.writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
}

function validAdapterManifest(role: string): string {
  return `export const manifest = { schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'fixture', name: 'Fixture', version: '1.0.0', type: 'core', implements: ${JSON.stringify(role)}, networkRequired: false };`;
}
