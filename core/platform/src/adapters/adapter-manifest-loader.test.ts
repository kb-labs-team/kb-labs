import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { declaredAdapterManifestPath, declaredManifestPath, loadAdapterManifest } from './adapter-manifest-loader.js';

describe('package manifest declarations', () => {
  it('reads only the plugin package manifest declaration', () => {
    expect(declaredManifestPath({ kb: { manifest: './dist/manifest.js' } })).toBe('./dist/manifest.js');
    expect(declaredManifestPath({ kb: { adapter: { manifest: './dist/manifest.js' } } })).toBeUndefined();
    expect(declaredManifestPath({ kbLabs: { manifest: './dist/legacy.js' } })).toBeUndefined();
    expect(declaredManifestPath({})).toBeUndefined();
  });

  it('reads only the adapter-specific package manifest declaration', () => {
    expect(declaredAdapterManifestPath({ kb: { adapter: { manifest: './dist/manifest.js' } } })).toBe('./dist/manifest.js');
    expect(declaredAdapterManifestPath({ kb: { manifest: './dist/manifest.js' } })).toBeUndefined();
  });
});

describe('loadAdapterManifest', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {await fs.rm(tempRoot, { recursive: true, force: true });}
    tempRoot = undefined;
  });

  it('loads a typed manifest from the sole kb.adapter declaration for an installed package', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-loader-'));
    const packageRoot = path.join(tempRoot, 'node_modules', '@fixture', 'cache');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/cache', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), `export const manifest = ${JSON.stringify({
      schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'fixture-cache', name: 'Fixture Cache', version: '1.0.0',
      type: 'core', implements: 'ICache', networkRequired: false, defaultFor: { cache: [] }, configSchema: { directory: { type: 'string' } },
    })};`);

    const result = await loadAdapterManifest({ spec: '@fixture/cache', platformRoot: tempRoot });
    expect(result.kind).toBe('adapter');
    if (result.kind !== 'adapter') {throw new Error('expected adapter manifest');}
    expect(result.manifest.requires).toBeUndefined();
    expect(result.manifest.configSchema?.directory?.type).toBe('string');
  });

  // case: S-321.6
  it('refuses to import an adapter manifest symlink that resolves outside the package', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-symlink-'));
    const packageRoot = path.join(tempRoot, 'package');
    const outsideManifest = path.join(tempRoot, 'outside.mjs');
    const sideEffectPath = path.join(tempRoot, 'manifest-imported');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'linked-adapter', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(outsideManifest, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sideEffectPath)}, 'executed'); export const manifest = {};`);
    await fs.symlink(outsideManifest, path.join(packageRoot, 'manifest.mjs'));

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({ kind: 'failed' });
    await expect(fs.access(sideEffectPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['array', ['storage']],
    ['non-array entrypoint', { storage: 'database' }],
    ['invalid path segment', { storage: ['..'] }],
  ] as const)('returns a structured failure for a malformed defaultFor %s', async (_kind, defaultFor) => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-loader-'));
    const packageRoot = path.join(tempRoot, 'malformed-default-for');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'malformed-default-for', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), `export const manifest = ${JSON.stringify({
      schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'malformed-default-for', name: 'Malformed Default', version: '1.0.0',
      type: 'core', implements: 'ICache', networkRequired: false, defaultFor,
    })};`);

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({
      kind: 'failed', reason: 'adapter manifest defaultFor must be a slot-to-entrypoint map of path segments',
    });
  });

  it('rejects an adapter manifest without its required network declaration', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-loader-'));
    const packageRoot = path.join(tempRoot, 'missing-network');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'missing-network', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), `export const manifest = ${JSON.stringify({
      schema: 'kb.adapter/1', manifestVersion: '1.0.0', id: 'missing-network', name: 'Missing Network', version: '1.0.0',
      type: 'core', implements: 'ICache',
    })};`);

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({
      kind: 'failed', reason: 'adapter manifest must declare networkRequired as a boolean',
    });
  });

  it('returns not-adapter for packages without kb.adapter.manifest', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-loader-'));
    const packageRoot = path.join(tempRoot, 'plain');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'plain', kbLabs: { manifest: './manifest.mjs' },
    }));
    await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), 'export const manifest = {};');

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({
      kind: 'not-adapter', reason: expect.stringContaining('kb.adapter.manifest'),
    });
  });

  it('returns failed when a declared module does not export a valid adapter manifest', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-loader-'));
    const packageRoot = path.join(tempRoot, 'broken');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'broken', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), 'export const manifest = { schema: "kb.adapter/1", implements: "ICache" };');

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({ kind: 'failed' });
  });

  it.each([
    ['missing', ''],
    ['wrong', 'schema: "kb.adapter/2", '],
  ] as const)('returns failed when a declared adapter manifest has a %s schema', async (_kind, schemaField) => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-loader-'));
    const packageRoot = path.join(tempRoot, 'invalid-schema');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'invalid-schema', type: 'module', kb: { adapter: { manifest: './manifest.mjs' } },
    }));
    await fs.writeFile(path.join(packageRoot, 'manifest.mjs'), `export const manifest = { ${schemaField}implements: "ICache" };`);

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({
      kind: 'failed', reason: expect.stringContaining('adapter manifest must declare schema "kb.adapter/1"'),
    });
  });

  it('preserves the declared module path when its built manifest file is missing', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-adapter-manifest-missing-'));
    const packageRoot = path.join(tempRoot, 'missing-built-manifest');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'missing-built-manifest', type: 'module', kb: { adapter: { manifest: './dist/manifest.js' } },
    }));

    await expect(loadAdapterManifest({ packageRoot })).resolves.toMatchObject({
      kind: 'failed', modulePath: path.join(packageRoot, 'dist/manifest.js'),
    });
  });
});
