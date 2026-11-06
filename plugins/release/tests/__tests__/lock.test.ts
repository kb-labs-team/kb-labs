import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { acquireLock } from '../../src/core/lock';

function makeRoot(): string {
  const root = join(tmpdir(), `lock-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe('acquireLock', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates a lock file and returns a release function', () => {
    const release = acquireLock(root, 'platform');
    const lockPath = join(root, '.kb', 'release', 'release.lock');
    const data = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(data.pid).toBe(process.pid);
    expect(data.flow).toBe('platform');
    release();
  });

  it('release removes the lock file', () => {
    const release = acquireLock(root, 'platform');
    release();
    expect(() => readFileSync(join(root, '.kb', 'release', 'release.lock'), 'utf-8')).toThrow();
  });

  it('release is idempotent — calling twice does not throw', () => {
    const release = acquireLock(root, 'platform');
    release();
    expect(() => release()).not.toThrow();
  });

  it('throws if another live process holds the lock', () => {
    // Simulate a live lock for current PID (we are alive)
    mkdirSync(join(root, '.kb', 'release'), { recursive: true });
    writeFileSync(
      join(root, '.kb', 'release', 'release.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), flow: 'platform' }),
    );
    expect(() => acquireLock(root, 'platform')).toThrow(/Another release is already running/);
  });

  it('overwrites a stale lock from a dead process (PID 1 is init, not us)', () => {
    // PID 999999999 is guaranteed dead
    mkdirSync(join(root, '.kb', 'release'), { recursive: true });
    writeFileSync(
      join(root, '.kb', 'release', 'release.lock'),
      JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }),
    );
    // Should not throw — stale lock is overwritten
    const release = acquireLock(root);
    const data = JSON.parse(readFileSync(join(root, '.kb', 'release', 'release.lock'), 'utf-8'));
    expect(data.pid).toBe(process.pid);
    release();
  });

  it('proceeds when lock file is corrupted/missing', () => {
    mkdirSync(join(root, '.kb', 'release'), { recursive: true });
    writeFileSync(join(root, '.kb', 'release', 'release.lock'), 'not json');
    const release = acquireLock(root);
    release();
  });
});
