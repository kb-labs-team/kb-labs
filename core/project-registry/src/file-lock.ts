import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ProjectRegistryError } from './errors.js';

export interface FileLockOptions {
  /** How long to wait for the lock before failing with `KB_PROJECT_REGISTRY_LOCKED`. Default 10s. */
  timeoutMs?: number;
  /** A lock older than this whose owner cannot be shown alive is considered abandoned. Default 30s. */
  staleMs?: number;
  /** Base delay between attempts (jittered). Default 15ms. */
  retryMs?: number;
}

interface LockPayload {
  pid: number;
  token: string;
  createdAt: number;
}

const DEFAULTS = { timeoutMs: 10_000, staleMs: 30_000, retryMs: 15 } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function parsePayload(raw: string): LockPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as LockPayload).pid === 'number' &&
      typeof (value as LockPayload).token === 'string' &&
      typeof (value as LockPayload).createdAt === 'number'
    ) {
      return value as LockPayload;
    }
  } catch {
    // A writer may still be between create and write; treated as "unknown owner".
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<{ raw: string; ageMs: number } | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
    return { raw, ageMs: Date.now() - stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Removes the lock if it is provably abandoned. The lock is first moved aside
 * with an atomic rename, so of several concurrent breakers only one wins; if
 * the file we moved turns out to be a different (live) lock, it is put back.
 */
async function breakIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const observed = await readLock(lockPath);
  if (!observed) {
    return true; // vanished: the caller can simply retry
  }
  const payload = parsePayload(observed.raw);
  const abandoned = payload
    ? !isProcessAlive(payload.pid) || Date.now() - payload.createdAt > staleMs
    : observed.ageMs > staleMs;
  if (!abandoned) {
    return false;
  }
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
  const moved = await fs.readFile(aside, 'utf8').catch(() => '');
  if (moved !== observed.raw) {
    // We displaced a lock that was taken after our check: restore it if the slot is free.
    await fs.link(aside, lockPath).catch(() => undefined);
  }
  await fs.unlink(aside).catch(() => undefined);
  return true;
}

async function acquire(lockPath: string, options: Required<FileLockOptions>): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        const payload: LockPayload = { pid: process.pid, token, createdAt: Date.now() };
        await handle.writeFile(JSON.stringify(payload));
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    if (await breakIfStale(lockPath, options.staleMs)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ProjectRegistryError(
        'KB_PROJECT_REGISTRY_LOCKED',
        `Timed out after ${options.timeoutMs}ms waiting for the registry lock.`,
        { timeoutMs: String(options.timeoutMs) },
      );
    }
    await sleep(options.retryMs + Math.floor(Math.random() * options.retryMs));
  }
}

async function release(lockPath: string, token: string): Promise<void> {
  const current = await readLock(lockPath).catch(() => null);
  if (current && parsePayload(current.raw)?.token === token) {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

/** Runs `fn` while holding an exclusive, cross-process lock file at `lockPath`. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const resolved: Required<FileLockOptions> = { ...DEFAULTS, ...options };
  const token = await acquire(lockPath, resolved);
  try {
    return await fn();
  } finally {
    await release(lockPath, token);
  }
}
