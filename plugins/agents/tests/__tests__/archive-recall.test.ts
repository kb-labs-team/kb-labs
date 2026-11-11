import { describe, it, expect } from 'vitest';
import { createArchiveRecallTool } from '../../src/tools/tools/memory/archive-recall';
import type { IArchiveMemory, ToolContext } from '../../src/tools/types';

function createMockArchive(
  overrides: Partial<IArchiveMemory> = {}
): IArchiveMemory {
  return {
    recallByFilePath: () => null,
    search: () => [],
    getArchivedFilePaths: () => [],
    hasFile: () => false,
    getSummaryHint: () => '',
    recallByToolName: () => [],
    recallByIteration: () => [],
    ...overrides,
  };
}

function createContext(archive?: IArchiveMemory): ToolContext {
  return {
    workingDir: '/test',
    archiveMemory: archive,
  } as unknown as ToolContext;
}

describe('archive_recall tool', () => {
  // ── Mode 1: file_path ───────────────────────────────────────────

  describe('file_path mode', () => {
    it('should return full content of last read', async () => {
      const archive = createMockArchive({
        recallByFilePath: (fp) =>
          fp === '/src/index.ts'
            ? {
                id: 'a_1',
                iteration: 3,
                toolName: 'fs_read',
                toolInput: { path: '/src/index.ts' },
                fullOutput: 'export function hello() {}',
                outputLength: 26,
                estimatedTokens: 7,
                timestamp: '2026-01-01T00:00:00Z',
                filePath: '/src/index.ts',
              }
            : null,
      });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ file_path: '/src/index.ts' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('export function hello() {}');
      expect(result.output).toContain('iteration 3');
    });

    it('should return error for non-archived file', async () => {
      const archive = createMockArchive({
        recallByFilePath: () => null,
        getArchivedFilePaths: () => ['/a.ts', '/b.ts'],
      });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ file_path: '/nonexistent.ts' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('File not found in archive');
      expect(result.output).toContain('/a.ts');
    });
  });

  // ── Mode 2: keyword ─────────────────────────────────────────────

  describe('keyword mode', () => {
    it('should return matched results', async () => {
      const archive = createMockArchive({
        search: (kw, limit) => [
          {
            id: 'a_1',
            iteration: 1,
            toolName: 'grep_search',
            toolInput: {},
            fullOutput: 'Found interface Foo at line 5',
            outputLength: 29,
            estimatedTokens: 8,
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
      });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ keyword: 'interface', limit: 3 });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Found interface Foo');
      expect(result.output).toContain('1 result(s)');
    });

    it('should handle no results', async () => {
      const archive = createMockArchive({ search: () => [] });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ keyword: 'nonexistent' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No archived outputs contain');
    });
  });

  // ── Mode 3: list_files ──────────────────────────────────────────

  describe('list_files mode', () => {
    it('should list all archived file paths', async () => {
      const archive = createMockArchive({
        getArchivedFilePaths: () => ['/src/a.ts', '/src/b.ts', '/src/c.ts'],
      });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ list_files: true });

      expect(result.success).toBe(true);
      expect(result.output).toContain('3 file(s) archived');
      expect(result.output).toContain('/src/a.ts');
    });

    it('should handle empty archive', async () => {
      const archive = createMockArchive({ getArchivedFilePaths: () => [] });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ list_files: true });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No files archived');
    });
  });

  // ── Mode 4: tool_name ──────────────────────────────────────────

  describe('tool_name mode', () => {
    it('should return recent outputs of a specific tool', async () => {
      const archive = createMockArchive({
        recallByToolName: (name) =>
          name === 'grep_search'
            ? [
                {
                  id: 'a_1',
                  iteration: 2,
                  toolName: 'grep_search',
                  toolInput: {},
                  fullOutput: 'match at line 10',
                  outputLength: 16,
                  estimatedTokens: 4,
                  timestamp: '2026-01-01T00:00:00Z',
                },
              ]
            : [],
      });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ tool_name: 'grep_search' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('grep_search');
      expect(result.output).toContain('match at line 10');
    });
  });

  // ── Mode 5: iteration ──────────────────────────────────────────

  describe('iteration mode', () => {
    it('should return all outputs from specific iteration', async () => {
      const archive = createMockArchive({
        recallByIteration: (iter) =>
          iter === 5
            ? [
                {
                  id: 'a_1',
                  iteration: 5,
                  toolName: 'fs_read',
                  toolInput: {},
                  fullOutput: 'file content',
                  outputLength: 12,
                  estimatedTokens: 3,
                  timestamp: '2026-01-01T00:00:00Z',
                  filePath: '/src/x.ts',
                },
                {
                  id: 'a_2',
                  iteration: 5,
                  toolName: 'grep_search',
                  toolInput: {},
                  fullOutput: 'grep result',
                  outputLength: 11,
                  estimatedTokens: 3,
                  timestamp: '2026-01-01T00:00:00Z',
                },
              ]
            : [],
      });

      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({ iteration: 5 });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 output(s) from iteration 5');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should return error when no archiveMemory in context', async () => {
      const tool = createArchiveRecallTool(createContext(undefined));
      const result = await tool.executor({ file_path: '/test.ts' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Archive memory not available');
    });

    it('should return error when no query parameters provided', async () => {
      const archive = createMockArchive();
      const tool = createArchiveRecallTool(createContext(archive));
      const result = await tool.executor({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Specify at least one query parameter');
    });
  });
});
