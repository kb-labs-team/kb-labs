/**
 * @module @kb-labs/core-config/user-config/file-lock
 *
 * Minimal advisory file lock: an exclusive-create `<target>.lock` file that
 * holds the owner pid and timestamp. Competing writers wait with a short
 * backoff; a lock whose owner is dead (or that is older than `staleMs`) is
 * reclaimed. This serialises `kb config set` invocations that run against the
 * same file (for example a CLI call and the host at the same time).
 *
 * There is no project-registry lock helper in the tree yet (ADR-0044 owns the
 * registry); when one lands this module should be replaced by it.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface FileLockOptions {
  /** Give up after this many milliseconds. Default 5000. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. Default 30000. */
  staleMs?: number;
  /** Delay between attempts. Default 15. */
  retryDelayMs?: number;
}

export class FileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for lock ${lockPath}`);
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const [stat, raw] = await Promise.all([fsp.stat(lockPath), fsp.readFile(lockPath, 'utf8')]);
    if (Date.now() - stat.mtimeMs > staleMs) {
      return true;
    }
    const pid = Number.parseInt(raw.split('\n')[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
  } catch {
    // The lock vanished (or is unreadable) between checks: not stale; the next attempt retries.
    return false;
  }
}

/**
 * Run `fn` while holding the lock for `targetPath`. The lock is always
 * released, including when `fn` throws.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const { timeoutMs = 5000, staleMs = 30_000, retryDelayMs = 15 } = options;
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Parent directory does not exist yet.
        await fsp.mkdir(path.dirname(lockPath), { recursive: true });
        continue;
      }
      if (code !== 'EEXIST') {
        throw error;
      }
      if (await isStale(lockPath, staleMs)) {
        await fsp.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(lockPath, timeoutMs);
      }
      await sleep(retryDelayMs);
    }
  }

  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true });
  }
}
