/**
 * Release lock — prevents concurrent release runs.
 *
 * Creates `.kb/release/release.lock` with current PID.
 * On acquire: fails if another live process holds the lock.
 * On release: removes the lock file.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface LockData {
  pid: number;
  startedAt: string;
  flow?: string;
}

function lockPath(repoRoot: string): string {
  return join(repoRoot, '.kb', 'release', 'release.lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the release lock.
 * Returns a release function — call it in a finally block.
 * Throws if another release is already running.
 */
export function acquireLock(repoRoot: string, flow?: string): () => void {
  const path = lockPath(repoRoot);

  // Check if lock exists and belongs to a live process
  try {
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as LockData;
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another release is already running (PID ${existing.pid}, started ${existing.startedAt}, flow: ${existing.flow ?? 'unknown'}). ` +
        `If this is stale, delete: ${path}`
      );
    }
    // Stale lock from a dead process — overwrite it
  } catch (err) {
    if (err instanceof Error && err.message.includes('Another release')) {throw err;}
    // File doesn't exist or is unreadable — proceed
  }

  mkdirSync(join(repoRoot, '.kb', 'release'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), flow } satisfies LockData));

  return () => {
    try { unlinkSync(path); } catch { /* already removed */ }
  };
}
