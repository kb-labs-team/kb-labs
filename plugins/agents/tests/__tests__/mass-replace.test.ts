import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { createMassReplaceTool } from '../../src/tools/tools/filesystem/mass-replace.js';
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
  };
});

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

import { glob } from 'glob';

const mockExists = vi.mocked(fs.existsSync);
const mockStat = vi.mocked(fs.statSync);
const mockReadFile = vi.mocked(fs.readFileSync);
const mockWriteFile = vi.mocked(fs.writeFileSync);
const mockGlob = vi.mocked(glob);

// Minimal fs.Stats-compatible stub
function statStub(opts: { isDirectory: boolean; size?: number }): fs.Stats {
  return {
    isDirectory: () => opts.isDirectory,
    isFile: () => !opts.isDirectory,
    size: opts.size ?? 0,
  } as unknown as fs.Stats;
}

// statSync that returns dir stat for the scope path, file stat for .ts files
function scopeAndFileStat(p: fs.PathLike | number): fs.Stats {
  const s = String(p);
  return statStub({ isDirectory: !s.endsWith('.ts'), size: 100 });
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workingDir: '/project', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockReturnValue(false);
  mockGlob.mockResolvedValue([]);
});

// ─── Validation ────────────────────────────────────────────

describe('mass_replace — validation', () => {
  it('returns error when pattern is missing', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: '', replacement: 'y', scope: '.', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('VALIDATION_ERROR');
    expect(result.error).toContain('pattern');
  });

  it('returns error when scope is missing', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: '', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('VALIDATION_ERROR');
    expect(result.error).toContain('scope');
  });

  it('returns error when files pattern is missing', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: 'src', files: '' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('VALIDATION_ERROR');
    expect(result.error).toContain('files');
  });

  it('returns error for unknown mode', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: 'src', files: '**/*.ts', mode: 'fuzzy' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('VALIDATION_ERROR');
    expect(result.error).toContain('fuzzy');
  });
});

// ─── Path traversal ────────────────────────────────────────

describe('mass_replace — path traversal', () => {
  it('blocks scope outside workingDir', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: '../../../etc', files: '*.conf' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('PATH_TRAVERSAL_ERROR');
  });
});

// ─── Scope checks ──────────────────────────────────────────

describe('mass_replace — scope validation', () => {
  it('returns error when scope directory does not exist', async () => {
    mockExists.mockReturnValue(false);
    const tool = createMassReplaceTool(ctx());

    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: 'nonexistent', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('SCOPE_ERROR');
  });

  it('returns error when scope is not a directory', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: false }));
    const tool = createMassReplaceTool(ctx());

    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: 'file.ts', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('SCOPE_ERROR');
  });
});

// ─── No matches ────────────────────────────────────────────

describe('mass_replace — no matches', () => {
  it('returns success with zero counts when no files match', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: true }));
    mockGlob.mockResolvedValue([]);

    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: 'src', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(true);
    expect((result.metadata as Record<string, unknown>).filesMatched).toBe(0);
    expect((result.metadata as Record<string, unknown>).filesChanged).toBe(0);
    expect(result.output).toContain('No files matched');
  });
});

// ─── Too many files ────────────────────────────────────────

describe('mass_replace — file count limit', () => {
  it('returns error when glob matches more than MAX_FILES (100)', async () => {
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue(statStub({ isDirectory: true }));
    mockGlob.mockResolvedValue(Array.from({ length: 101 }, (_, i) => `file${i}.ts`));

    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'x', replacement: 'y', scope: 'src', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('TOO_MANY_FILES');
  });
});

// ─── Literal replacement ───────────────────────────────────

describe('mass_replace — literal mode', () => {
  beforeEach(() => {
    mockExists.mockReturnValue(true);
    mockStat.mockImplementation(scopeAndFileStat);
    mockGlob.mockResolvedValue(['index.ts']);
    mockReadFile.mockReturnValue('const foo = 1;\nconst foo = 2;\n');
  });

  it('replaces literal string in matching files', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'foo', replacement: 'bar', scope: 'src', files: '**/*.ts' }) as ToolResult;

    expect(result.success).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writtenContent = mockWriteFile.mock.calls[0]![1] as string;
    expect(writtenContent).toBe('const bar = 1;\nconst bar = 2;\n');
    expect((result.metadata as Record<string, unknown>).totalReplacements).toBe(2);
  });

  it('does not write when no replacements occur', async () => {
    mockReadFile.mockReturnValue('no match here');

    const tool = createMassReplaceTool(ctx());
    await tool.executor({ pattern: 'ZZZNOMATCH', replacement: 'x', scope: 'src', files: '**/*.ts' });

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('dry-run does not write file', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({ pattern: 'foo', replacement: 'bar', scope: 'src', files: '**/*.ts', dryRun: true }) as ToolResult;

    expect(result.success).toBe(true);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(result.output).toContain('DRY RUN');
  });
});

// ─── Regex mode ────────────────────────────────────────────

describe('mass_replace — regex mode', () => {
  beforeEach(() => {
    mockExists.mockReturnValue(true);
    mockStat.mockImplementation(scopeAndFileStat);
    mockGlob.mockResolvedValue(['main.ts']);
    mockReadFile.mockReturnValue('const Foo = 1;\nconst FOO = 2;\n');
  });

  it('applies regex replacement', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({
      pattern: 'Foo',
      replacement: 'Bar',
      scope: 'src',
      files: '**/*.ts',
      mode: 'regex',
    }) as ToolResult;

    expect(result.success).toBe(true);
    const written = mockWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain('Bar');
  });

  it('supports caseInsensitive flag', async () => {
    const tool = createMassReplaceTool(ctx());
    await tool.executor({
      pattern: 'foo',
      replacement: 'bar',
      scope: 'src',
      files: '**/*.ts',
      mode: 'regex',
      caseInsensitive: true,
    });

    const written = mockWriteFile.mock.calls[0]![1] as string;
    // Both 'Foo' and 'FOO' should be replaced
    expect(written).not.toContain('Foo');
    expect(written).not.toContain('FOO');
    expect(written).toBe('const bar = 1;\nconst bar = 2;\n');
  });

  it('returns error for invalid regex', async () => {
    const tool = createMassReplaceTool(ctx());
    const result = await tool.executor({
      pattern: '[invalid',
      replacement: 'x',
      scope: 'src',
      files: '**/*.ts',
      mode: 'regex',
    }) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('REGEX_ERROR');
  });
});


// ─── Tool definition ───────────────────────────────────────

describe('mass_replace — tool definition', () => {
  it('has correct name and required parameters', () => {
    const tool = createMassReplaceTool(ctx());
    const fn = tool.definition.function;

    expect(fn.name).toBe('mass_replace');
    expect(fn.parameters.required).toContain('pattern');
    expect(fn.parameters.required).toContain('replacement');
    expect(fn.parameters.required).toContain('scope');
    expect(fn.parameters.required).toContain('files');
  });
});
