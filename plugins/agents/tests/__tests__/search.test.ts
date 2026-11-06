import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { execa } from 'execa';
import {
  createGlobSearchTool,
  createGrepSearchTool,
  createFindDefinitionTool,
  createCodeStatsTool,
} from '../../src/tools/tools/search/search.js';
import type { ToolContext } from '../../src/tools/types.js';

// execa is used instead of execSync — all calls are array-based (no shell)
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    readdirSync: vi.fn(() => []),
  };
});

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

function ctx(workingDir = '/test/project'): ToolContext {
  return { workingDir };
}

/** Default success result for execa (no output). */
const emptyResult = { stdout: '', exitCode: 0, stderr: '' } as ReturnType<typeof execa> extends Promise<infer R> ? R : never;

beforeEach(() => {
  vi.clearAllMocks();
  // Directory exists by default
  mockExistsSync.mockReturnValue(true);
  mockStatSync.mockReturnValue({ isDirectory: () => true } as unknown as ReturnType<typeof fs.statSync>);
  mockReaddirSync.mockReturnValue([]);
  mockExeca.mockResolvedValue(emptyResult);
});

// ─── validateDirectory (shared across tools) ─────────────────

describe('directory validation', () => {
  it('should return error when directory does not exist (glob_search)', async () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([
      { name: 'src', isDirectory: () => true, isFile: () => false },
      { name: 'packages', isDirectory: () => true, isFile: () => false },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    const tool = createGlobSearchTool(ctx());

    const result = await tool.executor({ pattern: '*.ts', directory: 'agent-tools' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Directory "agent-tools" not found');
    expect(result.output).toContain('Use "." to search from project root');
    expect(result.output).toContain('Available directories: packages, src');
  });

  it('should return error when directory does not exist (grep_search)', async () => {
    mockExistsSync.mockReturnValue(false);
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'Foo', directory: 'nonexistent' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Directory "nonexistent" not found');
  });

  it('should return error when directory does not exist (find_definition)', async () => {
    mockExistsSync.mockReturnValue(false);
    const tool = createFindDefinitionTool(ctx());

    const result = await tool.executor({ name: 'MyClass', directory: 'bad-dir' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Directory "bad-dir" not found');
  });

  it('should return error when directory does not exist (code_stats)', async () => {
    mockExistsSync.mockReturnValue(false);
    const tool = createCodeStatsTool(ctx());

    const result = await tool.executor({ directory: 'missing' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Directory "missing" not found');
  });

  it('should show resolved path in error', async () => {
    mockExistsSync.mockReturnValue(false);
    const tool = createGlobSearchTool(ctx('/root'));

    const result = await tool.executor({ pattern: '*.ts', directory: 'agent-tools' });

    expect(result.output).toContain('/root/agent-tools');
  });

  it('should filter hidden dirs and node_modules from hints', async () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([
      { name: '.git', isDirectory: () => true, isFile: () => false },
      { name: '.kb', isDirectory: () => true, isFile: () => false },
      { name: 'node_modules', isDirectory: () => true, isFile: () => false },
      { name: 'src', isDirectory: () => true, isFile: () => false },
      { name: 'README.md', isDirectory: () => false, isFile: () => true },
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    const tool = createGlobSearchTool(ctx());

    const result = await tool.executor({ pattern: '*.ts', directory: 'bad' });

    expect(result.output).toContain('src');
    expect(result.output).not.toContain('.git');
    expect(result.output).not.toContain('node_modules');
    expect(result.output).not.toContain('README.md');
  });

  it('should not validate when directory is "."', async () => {
    const tool = createGlobSearchTool(ctx());

    await tool.executor({ pattern: '*.ts' });

    // Validation passed — execa (find) was invoked
    expect(mockExeca).toHaveBeenCalled();
  });
});

// ─── glob_search ───────────────────────────────────────────

describe('glob_search', () => {
  it('should return found files', async () => {
    mockExeca.mockResolvedValue({
      ...emptyResult,
      stdout: '/test/project/src/foo.ts\n/test/project/src/bar.ts\n',
    });
    const tool = createGlobSearchTool(ctx());

    const result = await tool.executor({ pattern: '*.ts' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Found 2 file(s)');
    expect(result.output).toContain('src/foo.ts');
    expect(result.output).toContain('src/bar.ts');
  });

  it('should return "No files found" with hint on empty output', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '\n' });
    const tool = createGlobSearchTool(ctx());

    const result = await tool.executor({ pattern: '*.xyz' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No files found');
    expect(result.output).toContain('glob_search matches filenames only');
    expect(result.output).toContain('grep_search');
    expect(result.output).toContain('find_definition');
  });

  it('should handle timeout', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true });
    mockExeca.mockRejectedValue(err);
    const tool = createGlobSearchTool(ctx());

    const result = await tool.executor({ pattern: '*.ts' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should handle general errors', async () => {
    mockExeca.mockRejectedValue(new Error('permission denied'));
    const tool = createGlobSearchTool(ctx());

    const result = await tool.executor({ pattern: '*.ts' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('permission denied');
  });

  it('should include default excludes in args', async () => {
    const tool = createGlobSearchTool(ctx());

    await tool.executor({ pattern: '*.ts' });

    const [, args] = mockExeca.mock.calls[0]!;
    const argsStr = (args as string[]).join(' ');
    expect(argsStr).toContain('node_modules');
    expect(argsStr).toContain('dist');
    expect(argsStr).toContain('.git');
  });

  it('should use custom excludes when provided', async () => {
    const tool = createGlobSearchTool(ctx());

    await tool.executor({ pattern: '*.ts', exclude: ['custom_dir'] });

    const [, args] = mockExeca.mock.calls[0]!;
    const argsStr = (args as string[]).join(' ');
    expect(argsStr).toContain('custom_dir');
    expect(argsStr).toContain('node_modules');
  });

  it('should search everywhere with empty exclude', async () => {
    const tool = createGlobSearchTool(ctx());

    await tool.executor({ pattern: '*.ts', exclude: [] });

    const [, args] = mockExeca.mock.calls[0]!;
    // empty excludes array falls back to defaults
    const argsStr = (args as string[]).join(' ');
    expect(argsStr).toContain('node_modules');
  });

  it('should resolve directory relative to workingDir', async () => {
    const tool = createGlobSearchTool(ctx('/root'));

    await tool.executor({ pattern: '*.ts', directory: 'sub/dir' });

    const [, args] = mockExeca.mock.calls[0]!;
    // First positional arg to find is the path
    expect((args as string[])[0]).toContain('/root/sub/dir');
  });
});

// ─── grep_search ───────────────────────────────────────────

describe('grep_search', () => {
  it('should return matches with file paths and lines', async () => {
    mockExeca.mockResolvedValue({
      ...emptyResult,
      stdout:
        '/test/project/src/app.ts:10:import { Foo } from "./foo";\n' +
        '/test/project/src/bar.ts:5:const x = Foo;\n',
    });
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'Foo' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Found 2 match(es)');
    expect(result.output).toContain('src/app.ts:10');
    expect(result.output).toContain('src/bar.ts:5');
  });

  it('should treat exit code 1 as no matches (not error)', async () => {
    // grep exits 1 when nothing matched — with reject:false this resolves normally
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '', exitCode: 1 });
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'nonexistent' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches found');
  });

  it('should suggest filePattern when no matches and no filePattern', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '', exitCode: 1 });
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'nonexistent' });

    expect(result.output).toContain('Try adding filePattern');
  });

  it('should not suggest filePattern when filePattern already provided', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '', exitCode: 1 });
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'nonexistent', filePattern: '*.ts' });

    expect(result.output).not.toContain('Try adding filePattern');
  });

  it('should handle timeout', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true });
    mockExeca.mockRejectedValue(err);
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'foo' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should add --include when filePattern provided', async () => {
    const tool = createGrepSearchTool(ctx());

    await tool.executor({ pattern: 'foo', filePattern: '*.ts' });

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args as string[]).toContain('--include=*.ts');
  });

  it('should support pagination via offset/limit', async () => {
    mockExeca.mockResolvedValue({
      ...emptyResult,
      stdout:
        '/test/project/src/a.ts:1:Foo\n' +
        '/test/project/src/b.ts:2:Foo\n' +
        '/test/project/src/c.ts:3:Foo\n',
    });
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'Foo', offset: 1, limit: 1 });

    expect(result.success).toBe(true);
    expect(result.output).toContain('showing 1, offset=1, limit=1');
    expect(result.output).toContain('src/b.ts:2');
    expect((result.metadata as Record<string, unknown>)?.nextOffset).toBe(2);
  });

  it('should fallback to literal mode for invalid regex in auto mode', async () => {
    mockExeca
      .mockResolvedValueOnce({ ...emptyResult, stdout: '', exitCode: 2, stderr: 'grep: parentheses not balanced' })
      .mockResolvedValueOnce({ ...emptyResult, stdout: '/test/project/src/a.ts:1:useLLM(\n', exitCode: 0 });

    const tool = createGrepSearchTool(ctx());
    const result = await tool.executor({ pattern: 'useLLM\\(' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('literal fallback');
    expect((result.metadata as Record<string, unknown>)?.modeUsed).toBe('literal');
  });

  it('should include default excludes', async () => {
    const tool = createGrepSearchTool(ctx());

    await tool.executor({ pattern: 'foo' });

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args as string[]).toContain('--exclude-dir=node_modules');
    expect(args as string[]).toContain('--exclude-dir=dist');
  });

  it('should use custom excludes', async () => {
    const tool = createGrepSearchTool(ctx());

    await tool.executor({ pattern: 'foo', exclude: ['vendor'] });

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args as string[]).toContain('--exclude-dir=vendor');
    expect(args as string[]).toContain('--exclude-dir=node_modules');
  });

  it('should return "No matches" with hint on empty output', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '\n' });
    const tool = createGrepSearchTool(ctx());

    const result = await tool.executor({ pattern: 'foo' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches found');
    expect(result.output).toContain('Try adding filePattern');
  });
});

// ─── find_definition ───────────────────────────────────────

describe('find_definition', () => {
  it('should find class definition', async () => {
    mockExeca.mockResolvedValue({
      ...emptyResult,
      stdout: '/test/project/src/registry.ts:7:export class ToolRegistry {\n',
    });
    const tool = createFindDefinitionTool(ctx());

    const result = await tool.executor({ name: 'ToolRegistry' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Found definition(s) for "ToolRegistry"');
    expect(result.output).toContain('src/registry.ts:7');
  });

  it('should return "No definition found" with hints on exit code 1', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '', exitCode: 1 });
    const tool = createFindDefinitionTool(ctx());

    const result = await tool.executor({ name: 'NonExistent' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No definition found');
    expect(result.output).toContain('grep_search');
    expect(result.output).toContain('glob_search');
    expect(result.output).toContain('*nonexistent*');
  });

  it('should handle timeout', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true });
    mockExeca.mockRejectedValue(err);
    const tool = createFindDefinitionTool(ctx());

    const result = await tool.executor({ name: 'Foo' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should use custom filePattern', async () => {
    const tool = createFindDefinitionTool(ctx());

    await tool.executor({ name: 'Foo', filePattern: '*.py' });

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args as string[]).toContain('--include=*.py');
    // Should NOT have default .ts includes when custom is specified
    expect((args as string[]).some(a => a.startsWith('--include=') && a.includes('.ts'))).toBe(false);
  });

  it('should search with language-agnostic patterns', async () => {
    const tool = createFindDefinitionTool(ctx());

    await tool.executor({ name: 'MyClass' });

    const [, args] = mockExeca.mock.calls[0]!;
    // The pattern is the argument after -E
    const eIdx = (args as string[]).indexOf('-E');
    const patternArg = eIdx >= 0 ? (args as string[])[eIdx + 1] : (args as string[]).find(a => a.includes('MyClass')) ?? '';
    expect(patternArg).toContain('class MyClass');
    expect(patternArg).toContain('interface MyClass');
    expect(patternArg).toContain('function MyClass');
    expect(patternArg).toContain('def MyClass');
    expect(patternArg).toContain('fn MyClass');
  });

  it('should include default excludes', async () => {
    const tool = createFindDefinitionTool(ctx());

    await tool.executor({ name: 'Foo' });

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args as string[]).toContain('--exclude-dir=node_modules');
    expect(args as string[]).toContain('--exclude-dir=dist');
  });

  it('should show directory name in "no definition" message', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '', exitCode: 1 });
    const tool = createFindDefinitionTool(ctx());

    const result = await tool.executor({ name: 'Foo', directory: 'src' });

    expect(result.output).toContain('in src');
  });

  it('should show "project root" when directory is default', async () => {
    mockExeca.mockResolvedValue({ ...emptyResult, stdout: '', exitCode: 1 });
    const tool = createFindDefinitionTool(ctx());

    const result = await tool.executor({ name: 'Foo' });

    expect(result.output).toContain('in project root');
  });
});

// ─── code_stats ────────────────────────────────────────────

describe('code_stats', () => {
  it('should return aggregate stats', async () => {
    // First call: find returns file paths
    mockExeca
      .mockResolvedValueOnce({
        ...emptyResult,
        stdout: '/test/project/src/app.ts\n/test/project/src/bar.tsx\n',
      })
      // Second call: wc -l on found files
      .mockResolvedValueOnce({
        ...emptyResult,
        stdout: '  100 /test/project/src/app.ts\n   50 /test/project/src/bar.tsx\n  150 total',
      });

    const tool = createCodeStatsTool(ctx());
    const result = await tool.executor({});

    expect(result.success).toBe(true);
    expect(result.output).toContain('150 total');
    // 2 files found by find
    expect(result.output).toContain('2');
  });

  it('should count extensions from found files', async () => {
    mockExeca
      .mockResolvedValueOnce({
        ...emptyResult,
        stdout: '/test/project/src/app.ts\n/test/project/src/bar.tsx\n/test/project/src/util.ts\n',
      })
      .mockResolvedValueOnce({
        ...emptyResult,
        stdout: '300 total',
      });

    const tool = createCodeStatsTool(ctx());
    const result = await tool.executor({});

    expect(result.success).toBe(true);
    expect(result.output).toContain('ts');
    expect(result.output).toContain('tsx');
  });

  it('should pass custom extensions to find args', async () => {
    mockExeca
      .mockResolvedValueOnce({ ...emptyResult, stdout: '' })
      .mockResolvedValueOnce({ ...emptyResult, stdout: '0 total' });

    const tool = createCodeStatsTool(ctx());
    await tool.executor({ extensions: 'py,rs' });

    const [, args] = mockExeca.mock.calls[0]!;
    const argsStr = (args as string[]).join(' ');
    expect(argsStr).toContain('*.py');
    expect(argsStr).toContain('*.rs');
    // Should not have default extensions
    expect(argsStr).not.toContain('*.ts');
  });

  it('should handle errors', async () => {
    mockExeca.mockRejectedValue(new Error('disk error'));
    const tool = createCodeStatsTool(ctx());

    const result = await tool.executor({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('disk error');
  });
});

// ─── Shell injection safety (H7) ───────────────────────────
// With execa, args are passed as an array — no shell interpretation.
// User-supplied values appear as-is in array elements (safe by design).

describe('shell injection safety (array args — no shell)', () => {
  const INJECTION = '$(id)';
  const BACKTICK = '`id`';

  describe('glob_search — pattern injection', () => {
    it('passes pattern as raw array arg (shell metacharacters not interpreted)', async () => {
      const tool = createGlobSearchTool(ctx());

      await tool.executor({ pattern: INJECTION });

      const [cmd, args] = mockExeca.mock.calls[0]!;
      expect(cmd).toBe('find');
      // Pattern is passed to -iname as an array element — never shell-interpreted
      const iIdx = (args as string[]).indexOf('-iname');
      expect(iIdx).toBeGreaterThan(-1);
      expect((args as string[])[iIdx + 1]).toBe(INJECTION);
    });

    it('passes backtick pattern as raw array arg', async () => {
      const tool = createGlobSearchTool(ctx());

      await tool.executor({ pattern: BACKTICK });

      const [, args] = mockExeca.mock.calls[0]!;
      const iIdx = (args as string[]).indexOf('-iname');
      expect((args as string[])[iIdx + 1]).toBe(BACKTICK);
    });

    it('passes workingDir path as raw array arg', async () => {
      const tool = createGlobSearchTool(ctx('/proj/$(id)'));

      await tool.executor({ pattern: '*.ts' });

      const [, args] = mockExeca.mock.calls[0]!;
      // First positional arg to find is the search path
      expect((args as string[])[0]).toContain('/proj/$(id)');
    });

    it('passes user-supplied excludes as raw array args', async () => {
      const tool = createGlobSearchTool(ctx());

      await tool.executor({ pattern: '*.ts', exclude: ['$(evil)'] });

      const [, args] = mockExeca.mock.calls[0]!;
      expect((args as string[]).some(a => a.includes('$(evil)'))).toBe(true);
    });
  });

  describe('grep_search — filePattern injection', () => {
    it('passes filePattern as raw array arg', async () => {
      const tool = createGrepSearchTool(ctx());

      await tool.executor({ pattern: 'foo', filePattern: `*.ts ${INJECTION}` });

      const [, args] = mockExeca.mock.calls[0]!;
      expect(args as string[]).toContain(`--include=*.ts ${INJECTION}`);
    });

    it('passes user-supplied excludes as raw array args', async () => {
      const tool = createGrepSearchTool(ctx());

      await tool.executor({ pattern: 'foo', exclude: [INJECTION] });

      const [, args] = mockExeca.mock.calls[0]!;
      expect(args as string[]).toContain(`--exclude-dir=${INJECTION}`);
    });
  });

  describe('find_definition — name and filePattern injection', () => {
    it('passes name inside pattern array arg (not shell-interpreted)', async () => {
      const tool = createFindDefinitionTool(ctx());

      await tool.executor({ name: `Foo" ${INJECTION}` });

      const [, args] = mockExeca.mock.calls[0]!;
      // The whole pattern is one array element — shell can't break out of it
      const patternArg = (args as string[]).find(a => a.includes('Foo"'));
      expect(patternArg).toBeDefined();
      expect(patternArg).toContain(`Foo" ${INJECTION}`);
    });

    it('passes filePattern as raw array arg', async () => {
      const tool = createFindDefinitionTool(ctx());

      await tool.executor({ name: 'Foo', filePattern: `*.py ${INJECTION}` });

      const [, args] = mockExeca.mock.calls[0]!;
      expect(args as string[]).toContain(`--include=*.py ${INJECTION}`);
    });
  });

  describe('code_stats — extensions injection', () => {
    it('passes extension wildcards as raw array args', async () => {
      mockExeca
        .mockResolvedValueOnce({ ...emptyResult, stdout: '' })
        .mockResolvedValueOnce({ ...emptyResult, stdout: '0 total' });
      const tool = createCodeStatsTool(ctx());

      await tool.executor({ extensions: `ts,${INJECTION}` });

      const [, args] = mockExeca.mock.calls[0]!;
      // Extension wildcard appears as raw array element — no shell quoting needed
      expect((args as string[]).some(a => a.includes(`*.${INJECTION}`))).toBe(true);
    });
  });
});
