/**
 * Rollback - manages release snapshots and recovery
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ReleasePlan, PackageVersion } from './types';

export interface RollbackSnapshot {
  ts: string;
  packages: PackageVersion[];
}

// MAX_HISTORY = 5; // Future use for snapshot retention

/**
 * Save current state for potential rollback
 */
export async function saveSnapshot(options: {
  cwd: string;
  plan: ReleasePlan;
}): Promise<void> {
  const { cwd, plan } = options;
  
  const snapshot: RollbackSnapshot = {
    ts: new Date().toISOString(),
    packages: plan.packages.map(pkg => ({
      ...pkg,
      nextVersion: pkg.currentVersion, // Store current before update
    })),
  };

  const snapshotDir = join(cwd, '.kb', 'release');
  await mkdir(snapshotDir, { recursive: true });
  
  const snapshotPath = join(snapshotDir, 'backup.json');
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  
  // Cleanup old snapshots
  await cleanupOldSnapshots(snapshotDir);
}

/**
 * Restore from snapshot
 */
export async function restoreSnapshot(cwd: string): Promise<void> {
  const snapshotPath = join(cwd, '.kb', 'release', 'backup.json');
  
  if (!existsSync(snapshotPath)) {
    throw new Error('No backup snapshot found');
  }

  const snapshotContent = await readFile(snapshotPath, 'utf-8');
  const snapshot: RollbackSnapshot = JSON.parse(snapshotContent);

  // Restore package.json versions
  for (const pkg of snapshot.packages) {
    const packageJsonPath = join(pkg.path, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    
    packageJson.version = pkg.currentVersion;
    await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
  }
}

async function cleanupOldSnapshots(_snapshotDir: string): Promise<void> {
  // For now, just keep the latest backup.json
  // In the future, could maintain timestamped backups
  // and trim to MAX_HISTORY
}

