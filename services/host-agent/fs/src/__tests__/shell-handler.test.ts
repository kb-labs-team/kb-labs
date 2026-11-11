import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShellHandler } from '../shell-handler.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function createTestDir(): string {
  const dir = join(tmpdir(), `kb-shell-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ShellHandler', () => {
  let testDir: string;
  let handler: ShellHandler;

  beforeEach(() => {
    testDir = createTestDir();
    handler = new ShellHandler({ allowedPaths: [testDir] });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('executes simple command', async () => {
    const result = await handler.handle({
      type: 'call',
      requestId: '1',
      adapter: 'shell',
      method: 'exec',
      args: ['echo "hello world"', { cwd: testDir }],
    }) as { stdout: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('returns exit code on failure', async () => {
    const result = await handler.handle({
      type: 'call',
      requestId: '2',
      adapter: 'shell',
      method: 'exec',
      args: ['false', { cwd: testDir }],
    }) as { exitCode: number };

    expect(result.exitCode).not.toBe(0);
  });

  it('blocks dangerous commands', async () => {
    await expect(
      handler.handle({
        type: 'call',
        requestId: '3',
        adapter: 'shell',
        method: 'exec',
        args: ['rm -rf /', {}],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it('blocks fork bombs', async () => {
    await expect(
      handler.handle({
        type: 'call',
        requestId: '4',
        adapter: 'shell',
        method: 'exec',
        args: [':(){ :|:& };:', {}],
      }),
    ).rejects.toThrow(/blocked/i);
  });

  it('rejects cwd outside allowedPaths', async () => {
    await expect(
      handler.handle({
        type: 'call',
        requestId: '5',
        adapter: 'shell',
        method: 'exec',
        args: ['ls', { cwd: '/etc' }],
      }),
    ).rejects.toThrow(/access denied/i);
  });

  it('throws on unknown method', async () => {
    await expect(
      handler.handle({
        type: 'call',
        requestId: '6',
        adapter: 'shell',
        method: 'unknown',
        args: [],
      }),
    ).rejects.toThrow(/unknown shell method/i);
  });

  it('captures stderr on error', async () => {
    const result = await handler.handle({
      type: 'call',
      requestId: '7',
      adapter: 'shell',
      method: 'exec',
      args: ['ls /nonexistent_path_xyz_123', { cwd: testDir }],
    }) as { stderr: string; exitCode: number };

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
