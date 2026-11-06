import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
  createFsReadTool,
  createFsWriteTool,
  createFsListTool,
  createFsPatchTool,
} from '../../src/tools/tools/filesystem/filesystem.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { ToolResult } from '@kb-labs/agents/contracts';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

const mockExists = vi.mocked(fs.existsSync);
const mockStat = vi.mocked(fs.statSync);
const mockReadFile = vi.mocked(fs.readFileSync);
const mockWriteFile = vi.mocked(fs.writeFileSync);
const mockReaddir = vi.mocked(fs.readdirSync);

// Minimal fs.Stats-compatible stub
function statStub(opts: { isDirectory: boolean; size?: number }): fs.Stats {
  return {
    isDirectory: () => opts.isDirectory,
    isFile: () => !opts.isDirectory,
    size: opts.size ?? 0,
  } as unknown as fs.Stats;
}

function ctx(workingDir = '/project'): ToolContext {
  return { workingDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockReturnValue(false);
});

// ─── Path traversal ────────────────────────────────────────

describe('path traversal protection', () => {
  it('fs_read blocks paths outside workingDir', async () => {
    const tool = createFsReadTool(ctx('/project'));
    const result = await tool.executor({ path: '../../../etc/passwd' }) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('PATH_VALIDATION_FAILED');
  });

  it('fs_write blocks paths outside workingDir', async () => {
    const tool = createFsWriteTool(ctx('/project'));
    const result = await tool.executor({ path: '../secret.txt', content: 'x' }) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('PATH_VALIDATION_FAILED');
  });
});

// ─── fs_read ───────────────────────────────────────────────

describe('fs_read', () => {
  it('returns FILE_NOT_FOUND when file does not exist', async () => {
    mockExists.mockReturnValue(false);
    const tool = createFsReadTool(ctx());

    const result = await tool.executor({ path: 'missing.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('FILE_NOT_FOUND');
    expect(result.errorDetails?.retryable).toBe(true);
  });

  it('returns NOT_A_FILE when path is a directory', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: true, size: 0 }));
    const tool = createFsReadTool(ctx());

    const result = await tool.executor({ path: 'src' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('NOT_A_FILE');
  });

  it('returns FILE_TOO_LARGE for oversized files', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false, size: 600_000 }));
    const tool = createFsReadTool(ctx());

    const result = await tool.executor({ path: 'big.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('FILE_TOO_LARGE');
    expect(result.errorDetails?.retryable).toBe(true);
  });

  it('reads file and returns content', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false, size: 100 }));
    mockReadFile.mockReturnValue('line1\nline2\nline3\n');
    const tool = createFsReadTool(ctx());

    const result = await tool.executor({ path: 'file.ts', offset: 1, limit: 3 }) as ToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toContain('line1');
    expect(result.output).toContain('line2');
  });

  it('returns OFFSET_OUT_OF_RANGE when offset exceeds file length', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false, size: 50 }));
    mockReadFile.mockReturnValue('line1\nline2\n');
    const tool = createFsReadTool(ctx());

    const result = await tool.executor({ path: 'file.ts', offset: 999 }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('OFFSET_OUT_OF_RANGE');
  });

  it('includes line numbers in output', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false, size: 50 }));
    mockReadFile.mockReturnValue('const x = 1;\nconst y = 2;\n');
    const tool = createFsReadTool(ctx());

    const result = await tool.executor({ path: 'file.ts', offset: 1, limit: 10 }) as ToolResult;

    expect(result.output).toContain('1');
    expect(result.output).toContain('const x = 1');
  });
});

// ─── fs_write ──────────────────────────────────────────────

describe('fs_write', () => {
  it('writes file and returns success', async () => {
    mockExists.mockReturnValue(false);
    mockStat.mockReturnValue(statStub({ isDirectory: false }));
    const tool = createFsWriteTool(ctx());

    const result = await tool.executor({ path: 'new.ts', content: 'export const x = 1;' }) as ToolResult;

    expect(result.success).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });

  it('rejects content larger than maxWriteSize', async () => {
    mockExists.mockReturnValue(false);
    const tool = createFsWriteTool(ctx());
    const bigContent = 'x'.repeat(1_100_000); // > 1MB

    const result = await tool.executor({ path: 'big.ts', content: bigContent }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('CONTENT_TOO_LARGE');
  });

  it('write succeeds even without prior read (no edit protection on fs_write)', async () => {
    // fs_write has no read-before-write protection — that lives in fs_patch
    mockExists.mockReturnValue(false);
    mockStat.mockReturnValue(statStub({ isDirectory: false }));
    const filesRead = new Set<string>(); // empty
    const tool = createFsWriteTool({ ...ctx(), filesRead });

    const result = await tool.executor({ path: 'new.ts', content: 'content' }) as ToolResult;

    expect(result.success).toBe(true);
  });
});

// ─── fs_patch ──────────────────────────────────────────────

describe('fs_patch', () => {
  it('blocks editing a file that was not read (edit protection)', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false, size: 100 }));
    mockReadFile.mockReturnValue('line1\nline2\nline3\n');

    const filesRead = new Set<string>(); // empty — file not read yet
    const tool = createFsPatchTool({ ...ctx(), filesRead });

    const result = await tool.executor({
      path: 'existing.ts',
      startLine: 1,
      endLine: 1,
      newContent: 'replaced',
    }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('CANNOT_EDIT_UNREAD_FILE');
  });
});

// ─── fs_list ───────────────────────────────────────────────

describe('fs_list', () => {
  it('returns DIRECTORY_NOT_FOUND for non-existent directory', async () => {
    mockExists.mockReturnValue(false);
    const tool = createFsListTool(ctx());

    const result = await tool.executor({ path: 'nonexistent' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('DIRECTORY_NOT_FOUND');
  });

  it('returns entries for existing directory', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: true }));
    mockReaddir.mockReturnValue([
      { name: 'foo.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'bar', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    ] as any);

    const tool = createFsListTool(ctx());
    const result = await tool.executor({ path: '.' }) as ToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toContain('foo.ts');
    expect(result.output).toContain('bar');
  });

  it('returns NOT_A_DIRECTORY when path is a file', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false }));
    const tool = createFsListTool(ctx());

    const result = await tool.executor({ path: 'file.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.errorDetails?.code).toBe('NOT_A_DIRECTORY');
  });
});
