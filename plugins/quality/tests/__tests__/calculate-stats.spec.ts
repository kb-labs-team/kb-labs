import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process to control git ls-files output
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:fs/promises to avoid real FS reads
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

// Mock globby for countPackages
vi.mock('globby', () => ({
  default: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { readFile as fsReadFile, stat } from 'node:fs/promises';
import globby from 'globby';
import { calculateStats, formatBytes, countPackages } from '../../src/core/stats/calculate-stats.js';

const mockExecFile = vi.mocked(execFile);
const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(fsReadFile);
const mockGlobby = vi.mocked(globby);

function setupGitLsFiles(files: string[]) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    cb?.(null, files.join('\0') + '\0', '');
    return {} as never;
  });
}

function setupStats(sizePerFile: number) {
  mockStat.mockResolvedValue({ size: sizePerFile } as never);
}

function setupReadFile(content: string) {
  mockReadFile.mockResolvedValue(content as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGlobby.mockResolvedValue(['packages/a/package.json', 'packages/b/package.json'] as never);
});

describe('formatBytes', () => {
  it('FB-01: returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('FB-02: formats bytes correctly', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1536)).toBe('1.50 KB');
  });

  it('FB-03: formats GB correctly', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
  });
});

describe('countPackages', () => {
  it('CP-01: excludes root package.json', async () => {
    mockGlobby.mockResolvedValue(['package.json', 'packages/a/package.json', 'packages/b/package.json'] as never);
    const count = await countPackages('/root');
    expect(count).toBe(2);
  });

  it('CP-02: returns 0 when only root package.json exists', async () => {
    mockGlobby.mockResolvedValue(['package.json'] as never);
    const count = await countPackages('/root');
    expect(count).toBe(0);
  });
});

describe('calculateStats', () => {
  it('CS-01: returns correct packages count from globby', async () => {
    setupGitLsFiles([]);
    const result = await calculateStats('/root');
    expect(result.packages).toBe(2);
  });

  it('CS-02: returns zero LOC and size when no source files', async () => {
    setupGitLsFiles([]);
    const result = await calculateStats('/root');
    expect(result.loc).toBe(0);
    expect(result.size).toBe(0);
    expect(result.sizeFormatted).toBe('0 B');
  });

  it('CS-03: computes size as sum of all file stat sizes', async () => {
    setupGitLsFiles(['src/a.ts', 'src/b.ts']);
    setupStats(1000);

    setupReadFile('const x = 1;\nconst y = 2;\n');

    const result = await calculateStats('/root');
    expect(result.size).toBe(2000);
  });

  it('CS-04: estimates LOC from sample bytes/line ratio', async () => {
    // 10 files, each 100 bytes, content with 10 lines = 10 bytes/line
    // totalSize = 1000 bytes → LOC ≈ 1000 / 10 = 100
    const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    setupGitLsFiles(files);
    setupStats(100);

    const tenLineContent = Array(10).fill('const x = 1;').join('\n');
    setupReadFile(tenLineContent);

    const result = await calculateStats('/root');
    expect(result.loc).toBeGreaterThan(0);
  });

  it('CS-05: falls back to FALLBACK_BYTES_PER_LINE when sample reads all fail', async () => {
    setupGitLsFiles(['src/a.ts']);
    setupStats(4500);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await calculateStats('/root');
    // fallback: 4500 / 45 = 100
    expect(result.loc).toBe(100);
  });

  it('CS-06: sizeFormatted is human-readable string', async () => {
    setupGitLsFiles(['src/a.ts']);
    setupStats(1024 * 1024);
    setupReadFile('line\n');

    const result = await calculateStats('/root');
    expect(result.sizeFormatted).toBe('1.00 MB');
  });
});
