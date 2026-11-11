import { fs } from './recording-filesystem.js';
import * as path from 'node:path';
import type { MarketplaceLockScope, MarketplaceLockValidationResult } from './marketplace-lock.js';
import { validateMarketplaceLock } from './marketplace-lock.js';

/** Runtime-resolved roots that may own one marketplace lock. */
export interface MarketplaceLockRoots {
  platformRoot?: string;
  projectRoot?: string;
}

/**
 * Resolve the owner scope for a lock path from the same platform/project roots
 * used by runtime bootstrap. A shared development root is platform-owned,
 * because adapter discovery reads its lock as platform scope.
 */
export async function resolveMarketplaceLockScope(
  roots: MarketplaceLockRoots,
  lockRoot: string,
): Promise<MarketplaceLockScope> {
  const [target, platform, project] = await Promise.all([
    canonicalPath(lockRoot),
    roots.platformRoot ? canonicalPath(roots.platformRoot) : undefined,
    roots.projectRoot ? canonicalPath(roots.projectRoot) : undefined,
  ]);

  if (platform && target === platform) {return 'platform';}
  if (project && target === project) {return 'project';}
  throw new Error(`Marketplace lock root "${lockRoot}" is neither the resolved platform root nor project root.`);
}

/** Validate a lock using the scope its runtime-resolved root owns. */
export async function validateMarketplaceLockAtRoot(
  value: unknown,
  roots: MarketplaceLockRoots,
  lockRoot: string,
): Promise<MarketplaceLockValidationResult & { scope: MarketplaceLockScope }> {
  const scope = await resolveMarketplaceLockScope(roots, lockRoot);
  return { ...validateMarketplaceLock(value, scope), scope };
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return path.resolve(value);
    }
    throw error;
  }
}
