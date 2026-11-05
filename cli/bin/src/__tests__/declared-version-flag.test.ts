import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('declared version flag', () => {
  // case: S-284.17
  it.each([
    ['omitted', ['--version']],
    ['empty', ['--version', '', '--json']],
    ['next flag', ['--version', '--json']],
  ])('rejects a %s command version at the built CLI boundary', (_label, args) => {
    const result = spawnSync(process.execPath, [
      resolve('dist/bin.js'), 'release', 'artifact', 'publish', ...args,
    ], { encoding: 'utf8', cwd: resolve('../..') });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('KB_RUNTIME_INPUT_INVALID');
  });

  it('routes a supplied version to delivery', () => {
    const result = spawnSync(process.execPath, [
      resolve('dist/bin.js'), 'release', 'artifact', 'publish',
      '--flow', 'platform', '--version', '2.121.0-canary.test', '--target', 'local', '--json',
    ], { encoding: 'utf8', cwd: resolve('../..') });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Candidate delivery requires the hosted bundle digest');
  });

  it('keeps the bare global version command', () => {
    const result = spawnSync(process.execPath, [resolve('dist/bin.js'), '--version', '--json'], {
      encoding: 'utf8', cwd: resolve('../..'),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, version: expect.any(String) });
  });

  it('keeps the global version flag for a command that does not declare it', () => {
    const result = spawnSync(process.execPath, [resolve('dist/bin.js'), 'release', 'plan', '--version', '--json'], {
      encoding: 'utf8', cwd: resolve('../..'),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, version: expect.any(String) });
  });
});
