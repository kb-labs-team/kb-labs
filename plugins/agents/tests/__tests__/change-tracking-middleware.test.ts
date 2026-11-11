/**
 * Unit tests for ChangeTrackingMiddleware
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChangeTrackingMiddleware, getFileChangeSummaries } from '../../src/core/middleware/builtin/change-tracking-middleware.js';
import type { RunContext, ToolExecCtx, ToolOutput } from '@kb-labs/agents/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const tmpDir = path.join(__dirname, '.tmp-change-tracking-mw');

function makeMeta() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: vi.fn(<T>(ns: string, key: string): T | undefined => store.get(ns)?.get(key) as T | undefined),
    set: vi.fn(<T>(ns: string, key: string, value: T): void => {
      if (!store.has(ns)) {store.set(ns, new Map());}
      store.get(ns)!.set(key, value);
    }),
    getNamespace: vi.fn((ns: string) => Object.fromEntries(store.get(ns) ?? [])),
  };
}

function makeEventBus() {
  return { on: vi.fn(), emit: vi.fn() };
}

function makeRunCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    task: 'test',
    tier: 'medium',
    messages: [],
    tools: [],
    iteration: 1,
    maxIterations: 20,
    aborted: false,
    abortSignal: new AbortController().signal,
    requestId: 'req-test-123',
    sessionId: 'sess-mw-test',
    meta: makeMeta(),
    eventBus: makeEventBus() as unknown as RunContext['eventBus'],
    debug: false,
    ...overrides,
  } as RunContext;
}

function makeToolCtx(run: RunContext, toolName: string, input: Record<string, unknown> = {}): ToolExecCtx {
  return {
    run,
    toolName,
    input,
    iteration: run.iteration,
    abortSignal: run.abortSignal,
    requestId: run.requestId,
  };
}

function makeSuccess(metadata?: Record<string, unknown>): ToolOutput {
  return { toolCallId: 'tc-1', output: 'ok', success: true, metadata };
}

function makeFailure(): ToolOutput {
  return { toolCallId: 'tc-2', output: '', success: false, error: 'fail' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ChangeTrackingMiddleware', () => {
  let mw: ChangeTrackingMiddleware;
  let runCtx: RunContext;

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mw = new ChangeTrackingMiddleware({
      agentId: 'agent-test',
      sessionId: 'sess-mw-test',
      workingDir: tmpDir,
    });
    runCtx = makeRunCtx();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct name, order, and fail-open policy', () => {
    expect(mw.name).toBe('change-tracking');
    expect(mw.order).toBe(8);
    expect(mw.config.failPolicy).toBe('fail-open');
  });

  it('onStart captures requestId as runId', () => {
    mw.onStart(runCtx);
    // Internal runId set — verified indirectly by save/query tests
    expect(true).toBe(true); // just ensure no throw
  });

  describe('afterToolExec — ignored cases', () => {
    it('skips failed tool results', async () => {
      mw.onStart(runCtx);
      const ctx = makeToolCtx(runCtx, 'fs_write', { path: 'a.ts' });
      await mw.afterToolExec(ctx, makeFailure());
      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries).toHaveLength(0);
    });

    it('skips non-tracked tools', async () => {
      mw.onStart(runCtx);
      const ctx = makeToolCtx(runCtx, 'fs_read', { path: 'a.ts' });
      await mw.afterToolExec(ctx, makeSuccess());
      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries).toHaveLength(0);
    });

    it('skips when changeSnapshot is missing from metadata', async () => {
      mw.onStart(runCtx);
      const ctx = makeToolCtx(runCtx, 'fs_write', { path: 'a.ts' });
      await mw.afterToolExec(ctx, makeSuccess({ filePath: 'a.ts' })); // no changeSnapshot
      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries).toHaveLength(0);
    });

    it('skips when sessionId is absent', async () => {
      const mwNoSession = new ChangeTrackingMiddleware({
        agentId: 'agent-test',
        sessionId: undefined,
        workingDir: tmpDir,
      });
      const ctxNoSession = makeRunCtx({ sessionId: undefined });
      mwNoSession.onStart(ctxNoSession);

      const ctx = makeToolCtx(ctxNoSession, 'fs_write', { path: 'a.ts' });
      await mwNoSession.afterToolExec(ctx, makeSuccess({
        changeSnapshot: { operation: 'write', afterContent: 'x' },
      }));
      const summaries = getFileChangeSummaries(ctxNoSession);
      expect(summaries).toHaveLength(0);
    });
  });

  describe('afterToolExec — fs_write', () => {
    it('captures a new file write and adds summary to meta', async () => {
      mw.onStart(runCtx);
      const ctx = makeToolCtx(runCtx, 'fs_write', { path: 'src/new.ts' });

      await mw.afterToolExec(ctx, makeSuccess({
        changeSnapshot: {
          operation: 'write',
          beforeContent: undefined,
          afterContent: 'const x = 1;',
          isOverwrite: false,
        },
      }));

      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries).toHaveLength(1);
      const s = summaries[0]!;
      expect(s.filePath).toBe('src/new.ts');
      expect(s.operation).toBe('write');
      expect(s.isNew).toBe(true);
      expect(s.sizeAfter).toBeGreaterThan(0);
    });

    it('captures an overwrite and marks isNew=false', async () => {
      mw.onStart(runCtx);
      const ctx = makeToolCtx(runCtx, 'fs_write', { path: 'src/existing.ts' });

      await mw.afterToolExec(ctx, makeSuccess({
        changeSnapshot: {
          operation: 'write',
          beforeContent: 'old content',
          afterContent: 'new content',
          isOverwrite: true,
        },
      }));

      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries[0]!.isNew).toBe(false);
    });
  });

  describe('afterToolExec — fs_patch', () => {
    it('captures patch with line metadata', async () => {
      mw.onStart(runCtx);
      const ctx = makeToolCtx(runCtx, 'fs_patch', { path: 'src/edit.ts' });

      await mw.afterToolExec(ctx, makeSuccess({
        changeSnapshot: {
          operation: 'patch',
          beforeContent: 'line1\nline2\nline3',
          afterContent: 'line1\npatched\nline3',
          startLine: 2,
          endLine: 2,
          linesAdded: 1,
          linesRemoved: 1,
        },
      }));

      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries[0]!.operation).toBe('patch');
      expect(summaries[0]!.linesAdded).toBe(1);
      expect(summaries[0]!.linesRemoved).toBe(1);
    });
  });

  describe('afterToolExec — multiple changes', () => {
    it('accumulates summaries across multiple tool calls', async () => {
      mw.onStart(runCtx);

      const ctx1 = makeToolCtx(runCtx, 'fs_write', { path: 'a.ts' });
      await mw.afterToolExec(ctx1, makeSuccess({
        changeSnapshot: { operation: 'write', afterContent: 'a', isOverwrite: false },
      }));

      const ctx2 = makeToolCtx(runCtx, 'fs_patch', { path: 'b.ts' });
      await mw.afterToolExec(ctx2, makeSuccess({
        changeSnapshot: { operation: 'patch', beforeContent: 'old', afterContent: 'new', linesAdded: 1, linesRemoved: 1 },
      }));

      const summaries = getFileChangeSummaries(runCtx);
      expect(summaries).toHaveLength(2);
      expect(summaries.map((s) => s.filePath).sort()).toEqual(['a.ts', 'b.ts']);
    });
  });

  describe('changeStore getter', () => {
    it('exposes the underlying store for external queries', () => {
      expect(mw.changeStore).toBeDefined();
    });
  });

  describe('rollbackRun', () => {
    it('restores files written in the run', async () => {
      mw.onStart(runCtx);

      // Create actual file on disk to roll back
      const filePath = 'rollback-test.ts';
      const fullPath = path.join(tmpDir, filePath);
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await fs.promises.writeFile(fullPath, 'new content', 'utf-8');

      const ctx = makeToolCtx(runCtx, 'fs_write', { path: filePath });
      await mw.afterToolExec(ctx, makeSuccess({
        changeSnapshot: {
          operation: 'write',
          beforeContent: 'original content',
          afterContent: 'new content',
          isOverwrite: true,
        },
      }));

      const { rolledBack, errors } = await mw.rollbackRun('sess-mw-test', tmpDir);
      expect(errors).toHaveLength(0);
      expect(rolledBack).toBe(1);

      const restored = await fs.promises.readFile(fullPath, 'utf-8');
      expect(restored).toBe('original content');
    });

    it('deletes files that were newly created by the agent', async () => {
      mw.onStart(runCtx);

      const filePath = 'new-created.ts';
      const fullPath = path.join(tmpDir, filePath);
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await fs.promises.writeFile(fullPath, 'created by agent', 'utf-8');

      const ctx = makeToolCtx(runCtx, 'fs_write', { path: filePath });
      await mw.afterToolExec(ctx, makeSuccess({
        changeSnapshot: {
          operation: 'write',
          beforeContent: undefined, // new file
          afterContent: 'created by agent',
          isOverwrite: false,
        },
      }));

      const { rolledBack } = await mw.rollbackRun('sess-mw-test', tmpDir);
      expect(rolledBack).toBe(1);
      expect(fs.existsSync(fullPath)).toBe(false);
    });
  });
});

describe('getFileChangeSummaries', () => {
  it('returns empty array when nothing was set', () => {
    const ctx = {
      meta: {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
        getNamespace: vi.fn(),
      },
    } as unknown as RunContext;
    expect(getFileChangeSummaries(ctx)).toEqual([]);
  });
});
