/**
 * Tests for verifyPackage — focused on shell injection safety (H9).
 * Verifies that node --check and tar use spawnSync with arg arrays,
 * not shell-interpolated execSync strings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { verifyPackage } from '../../src/core/verifier.js';

const mockSpawnSync = vi.mocked(childProcess.spawnSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

function makePackageJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'my-pkg',
    version: '1.0.0',
    main: 'dist/index.js',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), pid: 1, output: [], signal: null });
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue(['my-pkg-1.0.0.tgz'] as any);
  mockReadFileSync.mockReturnValue(makePackageJson() as any);
});

describe('verifyPackage — shell injection safety (H9)', () => {
  it('calls spawnSync for npm pack with args array (no shell string)', () => {
    verifyPackage('/pkg/path');

    const npmCall = mockSpawnSync.mock.calls.find(([cmd]) => cmd === 'npm');
    expect(npmCall).toBeTruthy();
    expect(npmCall![1]).toEqual(expect.arrayContaining(['pack', '--pack-destination']));
    // No shell: true
    expect((npmCall![2] as Record<string, unknown>)?.shell).toBeFalsy();
  });

  it('calls spawnSync for tar with args array (no shell string)', () => {
    verifyPackage('/pkg/path');

    const tarCall = mockSpawnSync.mock.calls.find(([cmd]) => cmd === 'tar');
    expect(tarCall).toBeTruthy();
    expect(tarCall![1]).toEqual(expect.arrayContaining(['xzf']));
    expect((tarCall![2] as Record<string, unknown>)?.shell).toBeFalsy();
  });

  it('calls spawnSync for node --check with args array (no shell string)', () => {
    // Simulate extracted package.json with esmEntry
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      return makePackageJson({ main: 'dist/index.js' }) as any;
    });
    mockExistsSync.mockReturnValue(true);

    verifyPackage('/pkg/path');

    const nodeCall = mockSpawnSync.mock.calls.find(([cmd]) => cmd === 'node');
    expect(nodeCall).toBeTruthy();
    expect(nodeCall![1]).toEqual(expect.arrayContaining(['--check']));
    // Second arg must be array — not a shell string with interpolated path
    expect(Array.isArray(nodeCall![1])).toBe(true);
    expect((nodeCall![2] as Record<string, unknown>)?.shell).toBeFalsy();
  });

  it('node --check receives path containing shell metacharacters as a literal arg', () => {
    const evilEntry = 'dist/index.js; id';
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      return makePackageJson({ main: evilEntry }) as any;
    });

    verifyPackage('/pkg/path');

    // If node is called, the evil entry must appear as a single array element
    const nodeCall = mockSpawnSync.mock.calls.find(([cmd]) => cmd === 'node');
    if (nodeCall) {
      // The path is an element in the args array — not parsed by shell
      const args = nodeCall[1] as string[];
      const pathArg = args.find(a => a.includes('index.js'));
      expect(pathArg).toBeTruthy();
      // The semicolon is part of the path string, not a shell separator
      expect(pathArg).toContain('; id');
    }
    // No actual RCE — spawnSync doesn't invoke shell
  });

  it('skips private packages without calling spawnSync', () => {
    mockReadFileSync.mockReturnValue(makePackageJson({ private: true }) as any);

    const result = verifyPackage('/pkg/path');

    expect(result.success).toBe(true);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
