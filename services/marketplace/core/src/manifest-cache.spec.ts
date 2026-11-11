import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readManifestCache,
  writeManifestCache,
  createEmptyManifestCache,
  setCacheEntry,
  removeCacheEntry,
} from './manifest-cache.js';

describe('manifest-cache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-cache-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('readManifestCache', () => {
    it('returns null when cache does not exist', async () => {
      const result = await readManifestCache(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, '.kb', 'marketplace.manifests.json'), 'not json');
      const result = await readManifestCache(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null for wrong schema', async () => {
      await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.kb', 'marketplace.manifests.json'),
        JSON.stringify({ schema: 'wrong/1', entries: {} }),
      );
      const result = await readManifestCache(tmpDir);
      expect(result).toBeNull();
    });

    it('reads valid cache', async () => {
      const cache = createEmptyManifestCache();
      cache.entries['@test/pkg'] = {
        manifestType: 'plugin',
        manifest: { id: 'test' } as any,
        cachedAt: '2026-01-01T00:00:00Z',
        integrity: 'sha256-abc',
      };
      await fs.mkdir(path.join(tmpDir, '.kb'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.kb', 'marketplace.manifests.json'),
        JSON.stringify(cache),
      );

      const result = await readManifestCache(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.entries['@test/pkg']!.manifestType).toBe('plugin');
    });
  });

  describe('writeManifestCache', () => {
    it('creates .kb dir and writes atomically', async () => {
      const cache = createEmptyManifestCache();
      await writeManifestCache(tmpDir, cache);

      const content = await fs.readFile(
        path.join(tmpDir, '.kb', 'marketplace.manifests.json'),
        'utf-8',
      );
      const parsed = JSON.parse(content);
      expect(parsed.schema).toBe('kb.marketplace.manifests/1');
      expect(parsed.entries).toEqual({});
    });
  });

  describe('setCacheEntry', () => {
    it('adds entry and persists', async () => {
      await setCacheEntry(tmpDir, '@test/pkg', {
        manifestType: 'adapter',
        manifest: { id: 'pino', implements: 'ILogger' } as any,
        cachedAt: new Date().toISOString(),
        integrity: 'sha256-xyz',
      });

      const cache = await readManifestCache(tmpDir);
      expect(cache).not.toBeNull();
      expect(cache!.entries['@test/pkg']!.manifestType).toBe('adapter');
    });

    it('overwrites existing entry', async () => {
      await setCacheEntry(tmpDir, '@test/pkg', {
        manifestType: 'plugin',
        manifest: { id: 'v1' } as any,
        cachedAt: new Date().toISOString(),
        integrity: 'sha256-v1',
      });
      await setCacheEntry(tmpDir, '@test/pkg', {
        manifestType: 'plugin',
        manifest: { id: 'v2' } as any,
        cachedAt: new Date().toISOString(),
        integrity: 'sha256-v2',
      });

      const cache = await readManifestCache(tmpDir);
      expect(cache!.entries['@test/pkg']!.integrity).toBe('sha256-v2');
    });
  });

  describe('removeCacheEntry', () => {
    it('removes entry and persists', async () => {
      await setCacheEntry(tmpDir, '@test/a', {
        manifestType: 'plugin',
        manifest: {} as any,
        cachedAt: new Date().toISOString(),
        integrity: 'sha256-a',
      });
      await setCacheEntry(tmpDir, '@test/b', {
        manifestType: 'plugin',
        manifest: {} as any,
        cachedAt: new Date().toISOString(),
        integrity: 'sha256-b',
      });

      await removeCacheEntry(tmpDir, '@test/a');

      const cache = await readManifestCache(tmpDir);
      expect(cache!.entries['@test/a']).toBeUndefined();
      expect(cache!.entries['@test/b']).toBeDefined();
    });

    it('no-op if entry does not exist', async () => {
      await removeCacheEntry(tmpDir, '@test/nonexistent');
      // Should not throw
    });
  });
});
