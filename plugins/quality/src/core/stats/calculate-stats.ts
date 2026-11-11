/**
 * Calculate monorepo statistics
 *
 * Fast path: git ls-files (index read, no FS traversal) + stat (metadata only) +
 * sampling 200 files to calibrate bytes-per-line ratio for the LOC estimate.
 */

import { readFile as fsReadFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import globby from 'globby';

const LOC_SAMPLE_SIZE = 200;
const FALLBACK_BYTES_PER_LINE = 45;

async function readTextFile(f: string): Promise<string | null> {
  try {
    return await fsReadFile(f, 'utf8');
  } catch {
    return null;
  }
}

export interface MonorepoStats {
  packages: number;
  loc: number;
  size: number;
  sizeFormatted: string;
}

const SOURCE_PATTERNS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.go'];

async function getSourceFiles(rootDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATTERNS],
      { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) { return resolve([]); }
        resolve(
          stdout
            .split('\0')
            .filter(Boolean)
            .map(f => path.join(rootDir, f))
        );
      }
    );
  });
}

async function estimateLoc(files: string[], totalSize: number): Promise<number> {
  if (files.length === 0) { return 0; }

  const indices = new Set<number>();
  while (indices.size < Math.min(LOC_SAMPLE_SIZE, files.length)) {
    indices.add(Math.floor(Math.random() * files.length));
  }
  const sample = Array.from(indices).map(i => files[i]).filter((f): f is string => f !== undefined);

  const contents = await Promise.all(sample.map(readTextFile));

  let sampleBytes = 0;
  let sampleLines = 0;
  for (const c of contents) {
    if (!c) { continue; }
    sampleBytes += Buffer.byteLength(c, 'utf-8');
    sampleLines += c.split('\n').length;
  }

  const bytesPerLine = sampleLines > 0 ? sampleBytes / sampleLines : FALLBACK_BYTES_PER_LINE;
  return Math.round(totalSize / bytesPerLine);
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) { return '0 B'; }

  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(2)} ${units[i]}`;
}

/**
 * Count packages in monorepo
 */
export async function countPackages(rootDir: string): Promise<number> {
  const packageJsonFiles = await globby('**/package.json', {
    cwd: rootDir,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.kb/**'],
    absolute: false,
    deep: 6,
  });

  return packageJsonFiles.filter(p => p !== 'package.json').length;
}

/**
 * Calculate all stats at once
 */
export async function calculateStats(rootDir: string): Promise<MonorepoStats> {
  const [files, packages] = await Promise.all([
    getSourceFiles(rootDir),
    countPackages(rootDir),
  ]);

  const fileStats = await Promise.all(files.map(f => stat(f).catch(() => null)));
  const size = fileStats.reduce((sum, s) => sum + (s ? s.size : 0), 0);

  const loc = await estimateLoc(files, size);

  return {
    packages,
    loc,
    size,
    sizeFormatted: formatBytes(size),
  };
}

// Keep named exports for external callers
export async function calculateLinesOfCode(rootDir: string): Promise<number> {
  const files = await getSourceFiles(rootDir);
  const fileStats = await Promise.all(files.map(f => stat(f).catch(() => null)));
  const size = fileStats.reduce((sum, s) => sum + (s ? s.size : 0), 0);
  return estimateLoc(files, size);
}

export async function calculateSize(rootDir: string): Promise<number> {
  const files = await getSourceFiles(rootDir);
  const fileStats = await Promise.all(files.map(f => stat(f).catch(() => null)));
  return fileStats.reduce((sum, s) => sum + (s ? s.size : 0), 0);
}
