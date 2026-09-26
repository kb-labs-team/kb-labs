/**
 * Tests for the hybrid mtime+hash cache staleness detection.
 *
 * Key behaviour verified:
 * 1. mtime unchanged → not stale (fast path, hash never read)
 * 2. mtime changed + hash unchanged → not stale (touch / content-addressed build)
 * 3. mtime changed + hash changed → stale (real rebuild, triggers re-discovery)
 * 4. manifest deleted → stale
 * 5. package.json mtime changed → stale
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import { parse as yamlParse } from 'yaml';
import { glob } from 'glob';

// ---------------------------------------------------------------------------
// FS mock — hoisted so vi.mock factory can reference it
// ---------------------------------------------------------------------------
const fsMock = vi.hoisted(() => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

// Keep the real sync fs helpers (state-dir resolution uses realpath/existsSync); only `promises` is mocked.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  promises: fsMock,
}));
vi.mock('node:fs/promises', () => fsMock);
vi.mock('yaml', () => ({ parse: vi.fn().mockReturnValue({ packages: [] }) }));
vi.mock('glob', () => ({ glob: vi.fn().mockResolvedValue([]) }));
vi.mock('../utils/path.js', () => ({ toPosixPath: (p: string) => p.replace(/\\/g, '/') }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { CacheFile, PackageCacheEntry, DiscoveryResult, CommandManifest } from '../types';

const PKG_ROOT = '/workspace/plugins/test';
const MANIFEST_PATH = '/workspace/plugins/test/dist/index.js';
const _PKG_JSON_PATH = '/workspace/plugins/test/package.json';

const HASH_V1 = `sha256-${crypto.createHash('sha256').update('version 1').digest('base64')}`;
const _HASH_V2 = `sha256-${crypto.createHash('sha256').update('version 2').digest('base64')}`;

function makeEntry(overrides: Partial<PackageCacheEntry> = {}): PackageCacheEntry {
  const manifest: CommandManifest = {
    manifestVersion: '1.0',
    segments: ['test', 'cmd'],
    id: 'test:cmd',
    group: 'test',
    describe: 'Test command',
    loader: async () => ({ run: async () => 0 }),
  };
  const result: DiscoveryResult = {
    scope: 'platform',
    source: 'workspace',
    packageName: '@kb-labs/test-plugin',
    manifestPath: MANIFEST_PATH,
    pkgRoot: PKG_ROOT,
    manifests: [manifest],
  };
  return {
    version: '1.0.0',
    manifestHash: HASH_V1,
    manifestPath: MANIFEST_PATH,
    pkgJsonMtime: 1000,
    manifestMtime: 2000,
    cachedAt: Date.now(),
    result,
    ...overrides,
  };
}

function makeCacheJson(entry: PackageCacheEntry): string {
  const cache: CacheFile = {
    version: process.version,
    cliVersion: '0.1.0',
    discoveryVersion: 2,
    timestamp: Date.now() - 1000,
    ttlMs: 300_000,
    stateHash: 'abc',
    packages: { '@kb-labs/test-plugin': entry },
    platformRoot: '/workspace',
    projectRoot: '/workspace',
  };
  return JSON.stringify(cache);
}

/** Build a stat mock that routes by path */
function statMock(routes: Record<string, { mtimeMs: number } | 'throw'>) {
  return vi.fn().mockImplementation(async (p: unknown) => {
    const ps = String(p);
    for (const [key, val] of Object.entries(routes)) {
      if (ps.includes(key)) {
        if (val === 'throw') { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
        return val;
      }
    }
    return { mtimeMs: 0 };
  });
}

/** Build a readFile mock: returns cacheJson for cli-manifests, ENOENT for everything else */
function readFileMock(cacheJson: string) {
  return vi.fn().mockImplementation(async (p: unknown) => {
    const ps = String(p);
    if (ps.endsWith('cli-manifests.json')) { return cacheJson; }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cache staleness — hybrid mtime + hash strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore defaults after clearAllMocks wipes them
    vi.mocked(glob).mockResolvedValue([]);
    vi.mocked(yamlParse).mockReturnValue({ packages: [] });
  });

  it('fast path: serves from cache when both mtimes unchanged', async () => {
    const entry = makeEntry({ pkgJsonMtime: 1000, manifestMtime: 2000, manifestHash: HASH_V1 });
    fsMock.readFile = readFileMock(makeCacheJson(entry));
    fsMock.stat = statMock({
      'package.json': { mtimeMs: 1000 },   // unchanged
      'dist/index.js': { mtimeMs: 2000 },  // unchanged
    });

    const { discoverManifests, resetInProcCache } = await import('../discover');
    resetInProcCache();
    const results = await discoverManifests('/workspace', false, {
      platformRoot: '/workspace',
      projectRoot: '/workspace',
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.packageName).toBe('@kb-labs/test-plugin');
    // readFile for the manifest should NOT be called (no hash verification needed)
    const manifestReadCalls = vi.mocked(fsMock.readFile).mock.calls
      .filter(c => String(c[0]).includes('dist/index.js'));
    expect(manifestReadCalls).toHaveLength(0);
  });

  it('mtime changed but hash identical → not stale (content-addressed build / touch)', async () => {
    const entry = makeEntry({ pkgJsonMtime: 1000, manifestMtime: 2000, manifestHash: HASH_V1 });
    fsMock.readFile = vi.fn().mockImplementation(async (p: unknown) => {
      const ps = String(p);
      if (ps.endsWith('cli-manifests.json')) { return makeCacheJson(entry); }
      if (ps.includes('dist/index.js')) { return 'version 1'; } // same content → same hash
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMock.stat = statMock({
      'package.json': { mtimeMs: 1000 },   // unchanged
      'dist/index.js': { mtimeMs: 9999 },  // mtime bumped (e.g. touch)
    });

    const { discoverManifests, resetInProcCache } = await import('../discover');
    resetInProcCache();
    const results = await discoverManifests('/workspace', false, {
      platformRoot: '/workspace',
      projectRoot: '/workspace',
    });

    // Entry still served — hash matched despite mtime change
    expect(results).toHaveLength(1);
    // Hash WAS read (mtime changed triggers hash check)
    const manifestReadCalls = vi.mocked(fsMock.readFile).mock.calls
      .filter(c => String(c[0]).includes('dist/index.js'));
    expect(manifestReadCalls.length).toBeGreaterThan(0);
  });

  it('mtime changed + hash changed → stale (real rebuild)', async () => {
    const entry = makeEntry({ pkgJsonMtime: 1000, manifestMtime: 2000, manifestHash: HASH_V1 });
    fsMock.readFile = vi.fn().mockImplementation(async (p: unknown) => {
      const ps = String(p);
      if (ps.endsWith('cli-manifests.json')) { return makeCacheJson(entry); }
      if (ps.includes('dist/index.js')) { return 'version 2'; } // different content → HASH_V2
      if (ps.includes('pnpm-workspace.yaml')) { return 'packages: []'; }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMock.stat = statMock({
      'package.json': { mtimeMs: 1000 },   // unchanged
      'dist/index.js': { mtimeMs: 9999 },  // mtime changed
    });

    const { discoverManifests, resetInProcCache } = await import('../discover');
    resetInProcCache();
    const results = await discoverManifests('/workspace', false, {
      platformRoot: '/workspace',
      projectRoot: '/workspace',
    });

    // Cache bypassed — re-discovery ran (no packages in workspace)
    expect(results).toHaveLength(0);
  });

  it('evicts entry when manifest file is deleted', async () => {
    const entry = makeEntry({ pkgJsonMtime: 1000, manifestMtime: 2000 });
    fsMock.readFile = vi.fn().mockImplementation(async (p: unknown) => {
      const ps = String(p);
      if (ps.endsWith('cli-manifests.json')) { return makeCacheJson(entry); }
      if (ps.includes('pnpm-workspace.yaml')) { return 'packages: []'; }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMock.stat = statMock({
      'package.json': { mtimeMs: 1000 },  // unchanged
      'dist/index.js': 'throw',           // manifest deleted
    });

    const { discoverManifests, resetInProcCache } = await import('../discover');
    resetInProcCache();
    const results = await discoverManifests('/workspace', false, {
      platformRoot: '/workspace',
      projectRoot: '/workspace',
    });

    expect(results).toHaveLength(0);
  });

  it('evicts entry when package.json mtime changes', async () => {
    const entry = makeEntry({ pkgJsonMtime: 1000 });
    fsMock.readFile = vi.fn().mockImplementation(async (p: unknown) => {
      const ps = String(p);
      if (ps.endsWith('cli-manifests.json')) { return makeCacheJson(entry); }
      if (ps.includes('pnpm-workspace.yaml')) { return 'packages: []'; }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    fsMock.stat = statMock({
      'package.json': { mtimeMs: 9999 },  // changed
    });

    const { discoverManifests, resetInProcCache } = await import('../discover');
    resetInProcCache();
    const results = await discoverManifests('/workspace', false, {
      platformRoot: '/workspace',
      projectRoot: '/workspace',
    });

    expect(results).toHaveLength(0);
  });
});
