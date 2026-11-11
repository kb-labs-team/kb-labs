/**
 * @module @kb-labs/core/config/lockfile/lockfile
 * Lockfile generation and management
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
// Note: KbError and ERROR_HINTS are available if needed for future error handling
import { computeConfigHash } from '../hash/config-hash';
import { toFsProduct } from '../utils/product-normalize';

export interface LockfileData {
  $schema?: string;
  schemaVersion: '1.0';
  orgPreset?: string;
  profile?: string;
  policyBundle?: string;
  hashes: Record<string, string>;
  generatedAt: string;
}

/**
 * Read lockfile from workspace
 */
export async function readLockfile(cwd: string): Promise<LockfileData | null> {
  const lockfilePath = path.join(cwd, '.kb', 'lock.json');
  
  try {
    const lockfileData = await fsp.readFile(lockfilePath, 'utf-8');
    return JSON.parse(lockfileData) as LockfileData;
  } catch {
    // Try old location for backward compatibility
    const oldLockfilePath = path.join(cwd, '.kb', 'lockfile.json');
    try {
      const lockfileData = await fsp.readFile(oldLockfilePath, 'utf-8');
      return JSON.parse(lockfileData) as LockfileData;
    } catch {
      return null;
    }
  }
}

/**
 * Stable JSON serialization with sorted keys for predictable diffs
 */
function stableStringify(obj: unknown, space = 2): string {
  return JSON.stringify(obj, (key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce((sorted: Record<string, unknown>, k) => {
          sorted[k] = (value as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return value;
  }, space);
}

/**
 * Write lockfile to workspace
 */
export async function writeLockfile(
  cwd: string,
  lockfileData: LockfileData
): Promise<void> {
  const lockfileDir = path.join(cwd, '.kb');
  const lockfilePath = path.join(lockfileDir, 'lock.json');
  
  // Ensure .kb directory exists
  await fsp.mkdir(lockfileDir, { recursive: true });
  
  // Add schema if not present
  if (!lockfileData.$schema) {
    lockfileData.$schema = 'https://schemas.kb-labs.dev/lockfile.schema.json';
  }
  
  // Use atomic write with stable key ordering
  const { writeFileAtomic } = await import('../utils/fs-atomic');
  await writeFileAtomic(lockfilePath, stableStringify(lockfileData, 2) + '\n');
}

/**
 * Update lockfile with new hashes
 */
export async function updateLockfile(
  cwd: string,
  updates: {
    orgPreset?: string;
    profile?: string;
    policyBundle?: string;
    configHashes?: Record<string, unknown>;
  }
): Promise<LockfileData> {
  const existing = await readLockfile(cwd);
  
  const lockfileData: LockfileData = {
    $schema: 'https://schemas.kb-labs.dev/lockfile.schema.json',
    schemaVersion: '1.0',
    orgPreset: updates.orgPreset || existing?.orgPreset,
    profile: updates.profile || existing?.profile,
    policyBundle: updates.policyBundle || existing?.policyBundle,
    hashes: { ...existing?.hashes },
    generatedAt: new Date().toISOString(),
  };
  
  // Update config hashes
  if (updates.configHashes) {
    for (const [product, config] of Object.entries(updates.configHashes)) {
      const fsProduct = toFsProduct(product as string);
      const hash = computeConfigHash(config);
      lockfileData.hashes[fsProduct] = hash;
    }
  }
  
  await writeLockfile(cwd, lockfileData);
  return lockfileData;
}

/**
 * Get config hash for a product
 */
export function getLockfileConfigHash(config: unknown): string {
  return computeConfigHash(config);
}

/**
 * Check if lockfile is up to date
 */
export async function isLockfileUpToDate(
  cwd: string,
  configs: Record<string, unknown>
): Promise<boolean> {
  const lockfile = await readLockfile(cwd);
  if (!lockfile) {
    return false;
  }
  
  for (const [product, config] of Object.entries(configs)) {
    const fsProduct = toFsProduct(product as string);
    const currentHash = computeConfigHash(config);
    const lockfileHash = lockfile.hashes[fsProduct];
    
    if (currentHash !== lockfileHash) {
      return false;
    }
  }
  
  return true;
}

/**
 * Validate lockfile schema
 */
export function validateLockfile(lockfileData: unknown): lockfileData is LockfileData {
  if (!lockfileData || typeof lockfileData !== 'object') {
    return false;
  }

  const data = lockfileData as Record<string, unknown>;

  if (data['schemaVersion'] !== '1.0') {
    return false;
  }

  if (!data['hashes'] || typeof data['hashes'] !== 'object') {
    return false;
  }

  if (!data['generatedAt'] || typeof data['generatedAt'] !== 'string') {
    return false;
  }

  return true;
}

/**
 * Get lockfile statistics
 */
export function getLockfileStats(lockfileData: LockfileData): {
  productCount: number;
  hasOrgPreset: boolean;
  hasProfile: boolean;
  hasPolicyBundle: boolean;
  generatedAt: Date;
} {
  return {
    productCount: Object.keys(lockfileData.hashes).length,
    hasOrgPreset: !!lockfileData.orgPreset,
    hasProfile: !!lockfileData.profile,
    hasPolicyBundle: !!lockfileData.policyBundle,
    generatedAt: new Date(lockfileData.generatedAt),
  };
}
