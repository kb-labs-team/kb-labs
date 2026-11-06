import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  copyFileSync,
  rmSync,
} from 'fs';
import { join, dirname } from 'path';
import type { DevlinkBackup, DevlinkMode } from '../../contracts/index.js';

function getBackupsDir(rootDir: string): string {
  return join(rootDir, '.kb', 'devlink', 'backups');
}

function getMetaPath(backupDir: string): string {
  return join(backupDir, 'meta.json');
}

/**
 * Creates a backup of given package.json files before a mutation.
 * Returns the backup metadata.
 */
export function createBackup(
  rootDir: string,
  filePaths: string[],
  description: string,
  currentMode: DevlinkMode | null
): DevlinkBackup {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const backupDir = join(getBackupsDir(rootDir), id);
  mkdirSync(backupDir, { recursive: true });

  const backedUpFiles: string[] = [];

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {continue;}

    // Flatten the path for storage: replace / with __ to keep it flat
    const safeName = filePath.replace(/\//g, '__').replace(/:/g, '_');
    const destPath = join(backupDir, safeName);
    copyFileSync(filePath, destPath);
    backedUpFiles.push(filePath);
  }

  const meta: DevlinkBackup = {
    id,
    timestamp: new Date().toISOString(),
    description,
    files: backedUpFiles,
    modeAtBackup: currentMode,
  };

  writeFileSync(getMetaPath(backupDir), JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  // Auto-prune: keep only the 10 most recent backups
  pruneBackups(rootDir, 10);

  return meta;
}

/**
 * Lists all backups, sorted newest first.
 */
export function listBackups(rootDir: string): DevlinkBackup[] {
  const backupsDir = getBackupsDir(rootDir);
  if (!existsSync(backupsDir)) {return [];}

  const entries = readdirSync(backupsDir, { withFileTypes: true });
  const backups: DevlinkBackup[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    const metaPath = getMetaPath(join(backupsDir, entry.name));
    if (!existsSync(metaPath)) {continue;}

    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as DevlinkBackup;
      backups.push(meta);
    } catch {
      // Skip corrupted backups
    }
  }

  return backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Returns the most recent backup, or null if none exist.
 */
export function getLastBackup(rootDir: string): DevlinkBackup | null {
  const backups = listBackups(rootDir);
  return backups[0] ?? null;
}

/**
 * Restores package.json files from a specific backup.
 */
export function restoreBackup(rootDir: string, backupId: string): { restored: number; errors: string[] } {
  const backupDir = join(getBackupsDir(rootDir), backupId);
  const metaPath = getMetaPath(backupDir);

  if (!existsSync(metaPath)) {
    throw new Error(`Backup ${backupId} not found`);
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as DevlinkBackup;
  let restored = 0;
  const errors: string[] = [];

  for (const originalPath of meta.files) {
    const safeName = originalPath.replace(/\//g, '__').replace(/:/g, '_');
    const srcPath = join(backupDir, safeName);

    if (!existsSync(srcPath)) {
      errors.push(`Backup file missing: ${safeName}`);
      continue;
    }

    try {
      mkdirSync(dirname(originalPath), { recursive: true });
      copyFileSync(srcPath, originalPath);
      restored++;
    } catch (err) {
      errors.push(`Failed to restore ${originalPath}: ${String(err)}`);
    }
  }

  return { restored, errors };
}

/**
 * Remove oldest backups beyond the retention limit.
 */
export function pruneBackups(rootDir: string, maxBackups = 10): number {
  const backups = listBackups(rootDir); // sorted newest first
  if (backups.length <= maxBackups) {return 0;}

  const backupsDir = getBackupsDir(rootDir);
  let pruned = 0;

  for (const old of backups.slice(maxBackups)) {
    const dir = join(backupsDir, old.id);
    try {
      rmSync(dir, { recursive: true, force: true });
      pruned++;
    } catch { /* skip */ }
  }

  return pruned;
}
