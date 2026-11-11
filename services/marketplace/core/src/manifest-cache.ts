/**
 * @module @kb-labs/marketplace-core/manifest-cache
 * Read/write .kb/marketplace.manifests.json — cached manifests for fast discovery.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ManifestCache, ManifestCacheEntry } from '@kb-labs/marketplace-contracts';

const CACHE_FILE = '.kb/marketplace.manifests.json';
const SCHEMA_VERSION = 'kb.marketplace.manifests/1' as const;

/**
 * Read the manifest cache from disk. Returns null if missing or invalid.
 */
export async function readManifestCache(root: string): Promise<ManifestCache | null> {
  const cachePath = path.join(root, CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== SCHEMA_VERSION) {return null;}
    return parsed as ManifestCache;
  } catch {
    return null;
  }
}

/**
 * Write the manifest cache atomically (tmp → rename).
 */
export async function writeManifestCache(root: string, cache: ManifestCache): Promise<void> {
  const cachePath = path.join(root, CACHE_FILE);
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${cachePath}.tmp.${randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, cachePath);
}

/**
 * Create an empty manifest cache.
 */
export function createEmptyManifestCache(): ManifestCache {
  return { schema: SCHEMA_VERSION, entries: {} };
}

/**
 * Set a single entry in the manifest cache and persist.
 */
export async function setCacheEntry(
  root: string,
  packageId: string,
  entry: ManifestCacheEntry,
): Promise<void> {
  const existing = await readManifestCache(root) ?? createEmptyManifestCache();
  existing.entries[packageId] = entry;
  await writeManifestCache(root, existing);
}

/**
 * Remove a single entry from the manifest cache and persist.
 */
export async function removeCacheEntry(
  root: string,
  packageId: string,
): Promise<void> {
  const existing = await readManifestCache(root);
  if (!existing || !(packageId in existing.entries)) {return;}
  delete existing.entries[packageId];
  await writeManifestCache(root, existing);
}
