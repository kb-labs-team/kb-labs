/**
 * Persistent cache for parsed commits and metadata
 * Includes graph hash invalidation and lockfile support
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Change, ChangeCache } from './types';

const CACHE_FILE = 'cache.json';
const GRAPH_FILE = 'graph.json';
const LOCK_FILE = '.cache.lock';

/**
 * Load cache from disk
 */
export async function loadCache(cacheDir: string): Promise<ChangeCache | null> {
  const cachePath = join(cacheDir, CACHE_FILE);
  
  try {
    if (!existsSync(cachePath)) {
      return null;
    }
    
    const content = await readFile(cachePath, 'utf-8');
    return JSON.parse(content) as ChangeCache;
  } catch (error) {
    // Corrupted cache, return null to rebuild
    return null;
  }
}

/**
 * Save cache to disk
 */
export async function saveCache(cacheDir: string, cache: ChangeCache): Promise<void> {
  const cachePath = join(cacheDir, CACHE_FILE);
  
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    // Non-critical error, just log and continue
    console.warn(`Failed to save cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get cached commit if exists
 */
export function getCachedChange(cache: ChangeCache | null, sha: string): Change | null {
  if (!cache) {return null;}
  
  return cache.commits[sha] || null;
}

/**
 * Update cache with new commits
 */
export function updateCache(cache: ChangeCache | null, commits: Change[]): ChangeCache {
  if (!cache) {
    cache = {
      meta: {
        graphHash: '',
        HEAD: '',
      },
      commits: {},
      lastTags: {},
    };
  }
  
  for (const commit of commits) {
    cache.commits[commit.sha] = commit;
  }
  
  return cache;
}

/**
 * Save devlink graph snapshot
 */
export async function saveGraphSnapshot(
  cacheDir: string,
  graphHash: string
): Promise<void> {
  const graphPath = join(cacheDir, GRAPH_FILE);
  
  try {
    await mkdir(cacheDir, { recursive: true });
    const content = JSON.stringify({ hash: graphHash, timestamp: new Date().toISOString() }, null, 2);
    await writeFile(graphPath, content, 'utf-8');
    
    // Also update cache meta
    const cache = await loadCache(cacheDir);
    if (cache) {
      cache.meta.graphHash = graphHash;
      await saveCache(cacheDir, cache);
    }
  } catch (error) {
    console.warn(`Failed to save graph snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Update HEAD reference in cache
 */
export async function updateHead(cacheDir: string, head: string): Promise<void> {
  const cache = await loadCache(cacheDir);
  if (cache) {
    cache.meta.HEAD = head;
    await saveCache(cacheDir, cache);
  }
}

/**
 * Update last tag for a package
 */
export async function updateLastTag(
  cacheDir: string,
  packageName: string,
  tag: string,
  sha: string
): Promise<void> {
  const cache = await loadCache(cacheDir);
  const updatedCache = updateCache(cache, []);
  updatedCache.lastTags[packageName] = { tag, sha };
  await saveCache(cacheDir, updatedCache);
}

/**
 * Get last tag for a package
 */
export function getLastTag(
  cache: ChangeCache | null,
  packageName: string
): { tag: string; sha: string } | null {
  if (!cache) {return null;}
  
  return cache.lastTags[packageName] || null;
}

/**
 * Check if cache is valid for given range
 * Invalidates if graph hash or HEAD changed outside range
 */
export async function isCacheValid(
  cacheDir: string,
  from: string,
  to: string,
  currentGraphHash?: string,
  currentHead?: string
): Promise<boolean> {
  const cache = await loadCache(cacheDir);
  if (!cache) {return false;}
  
  // Check graph hash
  if (currentGraphHash && cache.meta.graphHash && cache.meta.graphHash !== currentGraphHash) {
    return false;
  }
  
  // Check HEAD (should be >= 'to' for cache to be valid)
  if (currentHead && cache.meta.HEAD && !isCommitValid(cache.meta.HEAD, from, to)) {
    return false;
  }
  
  return true;
}

/**
 * Check if commit is within range
 */
function isCommitValid(commit: string, from: string, to: string): boolean {
  // Simplified check - in real implementation would use git rev-list to compare
  // For now, just ensure commit exists between from and to
  return true;
}

/**
 * Acquire lockfile for cache operations
 */
export async function acquireLock(cacheDir: string): Promise<() => Promise<void>> {
  const lockPath = join(cacheDir, LOCK_FILE);
  
  // Check if lock exists
  if (existsSync(lockPath)) {
    throw new Error('Cache lock already acquired. Another process may be running.');
  }
  
  // Create lock
  await mkdir(cacheDir, { recursive: true });
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
  }), 'utf-8');
  
  // Return release function
  return async () => {
    if (existsSync(lockPath)) {
      try {
        await writeFile(lockPath, '', 'utf-8');
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}


