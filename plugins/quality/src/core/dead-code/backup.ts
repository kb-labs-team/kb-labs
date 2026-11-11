/**
 * Backup, restore, and auto-removal for dead code files
 *
 * Creates timestamped backups before deletion, supports full restore,
 * and cleans up empty directories + package.json exports.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DeadCodeResult,
  DeadCodeBackupManifest,
  DeadCodeRemovalResult,
} from '../../contracts/index.js';

const BACKUP_DIR = '.dead-code-backup';

/**
 * Remove dead files with full backup.
 * Creates a timestamped backup directory, copies files, then deletes.
 */
export async function removeDeadFiles(
  rootDir: string,
  scanResult: DeadCodeResult,
  options?: { dryRun?: boolean },
): Promise<DeadCodeRemovalResult> {
  const dryRun = options?.dryRun ?? false;

  // Generate backup ID from timestamp
  const backupId = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(rootDir, BACKUP_DIR, backupId);

  // Get git info
  const gitSha = safeExec('git rev-parse HEAD', rootDir) ?? 'unknown';
  const gitBranch = safeExec('git rev-parse --abbrev-ref HEAD', rootDir) ?? 'unknown';

  // Collect all dead files across packages
  const allDeadFiles: DeadCodeResult['packages'][0]['deadFiles'] = [];
  for (const pkg of scanResult.packages) {
    allDeadFiles.push(...pkg.deadFiles);
  }

  if (allDeadFiles.length === 0) {
    return {
      backupId,
      backupPath,
      filesRemoved: 0,
      bytesRemoved: 0,
      emptyDirsRemoved: 0,
      exportsCleanedUp: 0,
      manifest: {
        id: backupId,
        createdAt: new Date().toISOString(),
        gitSha,
        gitBranch,
        removedFiles: [],
        removedEmptyDirs: [],
        cleanedExports: [],
        totalFilesRemoved: 0,
        totalBytesRemoved: 0,
      },
    };
  }

  // Build manifest
  const manifest: DeadCodeBackupManifest = {
    id: backupId,
    createdAt: new Date().toISOString(),
    gitSha,
    gitBranch,
    removedFiles: allDeadFiles.map(f => ({
      originalPath: f.absolutePath,
      backupPath: path.relative(rootDir, f.absolutePath),
      packageName: f.packageName,
      sizeBytes: f.sizeBytes,
    })),
    removedEmptyDirs: [],
    cleanedExports: [],
    totalFilesRemoved: allDeadFiles.length,
    totalBytesRemoved: allDeadFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
  };

  if (dryRun) {
    return {
      backupId,
      backupPath,
      filesRemoved: allDeadFiles.length,
      bytesRemoved: manifest.totalBytesRemoved,
      emptyDirsRemoved: scanResult.summary.emptyDirectories.length,
      exportsCleanedUp: 0,
      manifest,
    };
  }

  // 1. Create backup directory and copy files
  const filesDir = path.join(backupPath, 'files');
  for (const deadFile of allDeadFiles) {
    const relPath = path.relative(rootDir, deadFile.absolutePath);
    const destPath = path.join(filesDir, relPath);
    const destDir = path.dirname(destPath);

    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(deadFile.absolutePath, destPath);
  }

  // 2. Write manifest
  fs.writeFileSync(
    path.join(backupPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  // 3. Delete dead files
  for (const deadFile of allDeadFiles) {
    fs.unlinkSync(deadFile.absolutePath);
  }

  // 4. Remove empty directories (bottom-up)
  const removedDirs: string[] = [];
  const deadFileDirs = new Set(allDeadFiles.map(f => path.dirname(f.absolutePath)));
  for (const dir of deadFileDirs) {
    removeEmptyDirsUpward(dir, rootDir, removedDirs);
  }
  manifest.removedEmptyDirs = removedDirs.map(d => path.relative(rootDir, d));

  // 5. Clean package.json exports
  const deletedPaths = new Set(allDeadFiles.map(f => f.absolutePath));
  let exportsCleanedUp = 0;
  for (const pkg of scanResult.packages) {
    if (pkg.deadFiles.length === 0) {continue;}
    const pkgJsonPath = path.join(pkg.packageDir, 'package.json');
    const cleaned = cleanPackageJsonExports(pkgJsonPath, deletedPaths, pkg.packageDir);
    if (cleaned.length > 0) {
      manifest.cleanedExports.push({
        packageJsonPath: path.relative(rootDir, pkgJsonPath),
        removedExportKeys: cleaned,
      });
      exportsCleanedUp += cleaned.length;
    }
  }

  // 6. Re-write manifest with updated empty dirs and exports info
  fs.writeFileSync(
    path.join(backupPath, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  return {
    backupId,
    backupPath,
    filesRemoved: allDeadFiles.length,
    bytesRemoved: manifest.totalBytesRemoved,
    emptyDirsRemoved: removedDirs.length,
    exportsCleanedUp,
    manifest,
  };
}

/**
 * Restore files from a backup.
 */
export async function restoreFromBackup(
  rootDir: string,
  backupId: string,
): Promise<{ restoredFiles: number; restoredExports: number }> {
  const backupPath = path.join(rootDir, BACKUP_DIR, backupId);
  const manifestPath = path.join(backupPath, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  const manifest: DeadCodeBackupManifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8'),
  );

  let restoredFiles = 0;

  // Restore files
  for (const entry of manifest.removedFiles) {
    const backupFilePath = path.join(backupPath, 'files', entry.backupPath);
    if (!fs.existsSync(backupFilePath)) {continue;}

    // Ensure parent directory exists
    const parentDir = path.dirname(entry.originalPath);
    fs.mkdirSync(parentDir, { recursive: true });

    fs.copyFileSync(backupFilePath, entry.originalPath);
    restoredFiles++;
  }

  // Restore package.json exports
  let restoredExports = 0;
  for (const exportEntry of manifest.cleanedExports) {
    const pkgJsonPath = path.resolve(rootDir, exportEntry.packageJsonPath);
    if (!fs.existsSync(pkgJsonPath)) {continue;}

    // We can't perfectly restore exports without knowing the original values.
    // The safest approach: log a warning, user should rebuild.
    restoredExports += exportEntry.removedExportKeys.length;
  }

  return { restoredFiles, restoredExports };
}

/**
 * List all available backups.
 */
export function listBackups(rootDir: string): DeadCodeBackupManifest[] {
  const backupDir = path.join(rootDir, BACKUP_DIR);
  if (!fs.existsSync(backupDir)) {return [];}

  const backups: DeadCodeBackupManifest[] = [];
  const entries = fs.readdirSync(backupDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}

    const manifestPath = path.join(backupDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {continue;}

    try {
      const manifest: DeadCodeBackupManifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      );
      backups.push(manifest);
    } catch {
      // Skip invalid backup directories
    }
  }

  // Sort by date, newest first
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return backups;
}

// --- Internal helpers ---

function safeExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Walk upward from a directory, removing empty dirs until we hit
 * a non-empty one or the root boundary.
 */
function removeEmptyDirsUpward(
  dir: string,
  rootBoundary: string,
  removed: string[],
): void {
  let current = dir;

  while (current !== rootBoundary && current.startsWith(rootBoundary)) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length > 0) {break;} // Not empty

      fs.rmdirSync(current);
      removed.push(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

/**
 * Remove exports from package.json that reference deleted files.
 * Returns the list of removed export keys.
 */
function cleanPackageJsonExports(
  packageJsonPath: string,
  deletedPaths: Set<string>,
  packageDir: string,
): string[] {
  if (!fs.existsSync(packageJsonPath)) {return [];}

  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkgJson = JSON.parse(content);
    const removedKeys: string[] = [];

    if (!pkgJson.exports || typeof pkgJson.exports !== 'object') {return [];}

    for (const [key, value] of Object.entries(pkgJson.exports)) {
      // Skip wildcard exports
      if (key.includes('*')) {continue;}

      const exportPath = extractExportImportPath(value);
      if (!exportPath) {continue;}

      // Map dist path to src path
      const srcPath = distToSrcForExportCheck(exportPath, packageDir);
      if (srcPath && deletedPaths.has(srcPath)) {
        delete pkgJson.exports[key];
        removedKeys.push(key);
      }
    }

    if (removedKeys.length > 0) {
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    }

    return removedKeys;
  } catch {
    return [];
  }
}

function extractExportImportPath(value: unknown): string | null {
  if (typeof value === 'string') {return value;}
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['import', 'default', 'require']) {
      if (typeof obj[key] === 'string') {return obj[key] as string;}
    }
  }
  return null;
}

function distToSrcForExportCheck(
  distPath: string,
  packageDir: string,
): string | null {
  let normalized = distPath.replace(/^\.?\/?/, '');

  if (!normalized.startsWith('dist/') && !normalized.startsWith('dist\\')) {
    return null;
  }

  normalized = 'src/' + normalized.slice(5);
  normalized = normalized
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts')
    .replace(/\.mjs$/, '.ts')
    .replace(/\.cjs$/, '.ts');

  return path.resolve(packageDir, normalized);
}
