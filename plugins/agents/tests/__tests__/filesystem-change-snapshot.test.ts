/**
 * Tests that fs_write and fs_patch embed changeSnapshot in result.metadata
 * for consumption by ChangeTrackingMiddleware.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { createFsWriteTool, createFsPatchTool } from '../../src/tools/tools/filesystem/filesystem.js';
import type { ToolContext } from '../../src/tools/types.js';

// ─── Mock node:fs ─────────────────────────────────────────────────────────────

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
  };
});

const mockExists = vi.mocked(fs.existsSync);
const mockStat = vi.mocked(fs.statSync);
const mockReadFile = vi.mocked(fs.readFileSync);
const mockWrite = vi.mocked(fs.writeFileSync);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/workspace',
    sessionId: 'sess-1',
    filesRead: new Set(),
    filesReadHash: new Map(),
    ...overrides,
  };
}

// ─── fs_write ─────────────────────────────────────────────────────────────────

describe('fs_write — changeSnapshot in metadata', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStat.mockReturnValue({ isDirectory: () => false, size: 10 } as unknown as fs.Stats);
  });

  it('includes changeSnapshot with operation=write and no beforeContent for new file', async () => {
    mockExists.mockReturnValue(false); // new file

    const tool = createFsWriteTool(makeContext());
    const result = await tool.executor({ path: 'src/new.ts', content: 'const x = 1;' });

    expect(result.success).toBe(true);
    const snap = (result.metadata as Record<string, unknown>)?.['changeSnapshot'] as Record<string, unknown>;
    expect(snap).toBeDefined();
    expect(snap['operation']).toBe('write');
    expect(snap['beforeContent']).toBeUndefined();
    expect(snap['afterContent']).toBe('const x = 1;');
    expect(snap['isOverwrite']).toBe(false);
  });

  it('includes changeSnapshot with beforeContent for overwrite', async () => {
    mockExists.mockReturnValue(true); // existing file
    mockReadFile.mockReturnValue('old content');

    const tool = createFsWriteTool(makeContext());
    const result = await tool.executor({ path: 'src/existing.ts', content: 'new content' });

    expect(result.success).toBe(true);
    const snap = (result.metadata as Record<string, unknown>)?.['changeSnapshot'] as Record<string, unknown>;
    expect(snap['beforeContent']).toBe('old content');
    expect(snap['afterContent']).toBe('new content');
    expect(snap['isOverwrite']).toBe(true);
  });

  it('does NOT include changeSnapshot when write fails (path validation)', async () => {
    const tool = createFsWriteTool(makeContext());
    // path traversal
    const result = await tool.executor({ path: '../../etc/passwd', content: 'evil' });

    expect(result.success).toBe(false);
    expect((result.metadata as Record<string, unknown> | undefined)?.['changeSnapshot']).toBeUndefined();
  });
});

// ─── fs_patch ─────────────────────────────────────────────────────────────────

describe('fs_patch — changeSnapshot in metadata', () => {
  const filePath = 'src/edit.ts';
  const originalContent = 'line1\nline2\nline3';

  beforeEach(() => {
    vi.resetAllMocks();
    mockExists.mockReturnValue(true);
    mockStat.mockReturnValue({ isDirectory: () => false, size: 100 } as unknown as fs.Stats);
    mockReadFile.mockReturnValue(originalContent);
  });

  it('includes changeSnapshot with operation=patch and line metadata', async () => {
    const context = makeContext({
      filesRead: new Set([filePath]),
      filesReadHash: new Map([[filePath, 'any-hash']]), // skip hash check
    });

    // Bypass the hash check: make computed hash match stored hash
    // We need to mock crypto — simpler: just don't provide filesReadHash so protection skips
    const contextNoHashCheck = makeContext({ filesRead: new Set([filePath]) });

    const tool = createFsPatchTool(contextNoHashCheck);
    const result = await tool.executor({
      path: filePath,
      startLine: 2,
      endLine: 2,
      newContent: 'patched',
    });

    expect(result.success).toBe(true);
    const snap = (result.metadata as Record<string, unknown>)?.['changeSnapshot'] as Record<string, unknown>;
    expect(snap).toBeDefined();
    expect(snap['operation']).toBe('patch');
    expect(snap['beforeContent']).toBe(originalContent);
    expect(snap['afterContent']).toBe('line1\npatched\nline3');
    expect(snap['startLine']).toBe(2);
    expect(snap['endLine']).toBe(2);
    expect(snap['linesAdded']).toBe(1);
    expect(snap['linesRemoved']).toBe(1);
  });

  it('does NOT include changeSnapshot when patch fails (unread file)', async () => {
    const context = makeContext(); // filesRead is empty
    const tool = createFsPatchTool(context);
    const result = await tool.executor({
      path: filePath,
      startLine: 2,
      endLine: 2,
      newContent: 'x',
    });

    expect(result.success).toBe(false);
    expect((result.metadata as Record<string, unknown> | undefined)?.['changeSnapshot']).toBeUndefined();
  });
});
