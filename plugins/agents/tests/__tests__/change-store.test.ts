/**
 * Unit tests for ChangeStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChangeStore, computeHash, toSummary } from '../../src/history/change-store.js';

describe('ChangeStore', () => {
  const tmpDir = path.join(__dirname, '.tmp-change-store');
  const sessionId = 'sess-abc';
  const agentId = 'agent-1';
  const runId = 'run-001';

  let store: ChangeStore;

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store = new ChangeStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────
  // save
  // ─────────────────────────────────────────────────────────────

  describe('save', () => {
    it('saves a new file write and returns correct FileChange', async () => {
      const change = await store.save({
        sessionId,
        agentId,
        runId,
        filePath: 'src/foo.ts',
        operation: 'write',
        beforeContent: undefined,
        afterContent: 'const x = 1;',
      });

      expect(change.id).toMatch(/^change-/);
      expect(change.sessionId).toBe(sessionId);
      expect(change.agentId).toBe(agentId);
      expect(change.runId).toBe(runId);
      expect(change.filePath).toBe('src/foo.ts');
      expect(change.operation).toBe('write');
      expect(change.before).toBeUndefined();
      expect(change.after.content).toBe('const x = 1;');
      expect(change.after.hash).toBe(computeHash('const x = 1;'));
      expect(change.after.size).toBe(Buffer.byteLength('const x = 1;', 'utf-8'));
    });

    it('saves an overwrite with before content', async () => {
      const before = 'old content';
      const after = 'new content';
      const change = await store.save({
        sessionId,
        agentId,
        runId,
        filePath: 'src/bar.ts',
        operation: 'write',
        beforeContent: before,
        afterContent: after,
        metadata: { isOverwrite: true },
      });

      expect(change.before?.content).toBe(before);
      expect(change.before?.hash).toBe(computeHash(before));
      expect(change.after.content).toBe(after);
      expect(change.metadata?.isOverwrite).toBe(true);
    });

    it('saves a patch with line metadata', async () => {
      const change = await store.save({
        sessionId,
        agentId,
        runId,
        filePath: 'src/baz.ts',
        operation: 'patch',
        beforeContent: 'line1\nline2\nline3',
        afterContent: 'line1\npatched\nline3',
        metadata: { startLine: 2, endLine: 2, linesAdded: 1, linesRemoved: 1 },
      });

      expect(change.operation).toBe('patch');
      expect(change.metadata?.startLine).toBe(2);
      expect(change.metadata?.linesAdded).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // get
  // ─────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns the change from in-memory cache', async () => {
      const saved = await store.save({
        sessionId, agentId, runId,
        filePath: 'x.ts', operation: 'write',
        beforeContent: undefined, afterContent: 'hello',
      });

      const loaded = await store.get(sessionId, saved.id);
      expect(loaded).toEqual(saved);
    });

    it('returns the change from disk when not in cache', async () => {
      const saved = await store.save({
        sessionId, agentId, runId,
        filePath: 'y.ts', operation: 'write',
        beforeContent: undefined, afterContent: 'world',
      });

      // Create fresh store instance (no in-memory cache)
      const freshStore = new ChangeStore(tmpDir);
      const loaded = await freshStore.get(sessionId, saved.id);
      expect(loaded?.id).toBe(saved.id);
      expect(loaded?.after.content).toBe('world');
    });

    it('returns null for unknown changeId', async () => {
      const result = await store.get(sessionId, 'change-nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // listSession / listRun / listFile
  // ─────────────────────────────────────────────────────────────

  describe('listSession', () => {
    it('returns all changes in the session in chronological order', async () => {
      const c1 = await store.save({ sessionId, agentId, runId, filePath: 'a.ts', operation: 'write', beforeContent: undefined, afterContent: 'a' });
      const c2 = await store.save({ sessionId, agentId, runId: 'run-002', filePath: 'b.ts', operation: 'write', beforeContent: undefined, afterContent: 'b' });

      const all = await store.listSession(sessionId);
      expect(all.length).toBe(2);
      // Chronological: c1 before c2
      expect(new Date(all[0]!.timestamp) <= new Date(all[1]!.timestamp)).toBe(true);
      const ids = all.map((c) => c.id);
      expect(ids).toContain(c1.id);
      expect(ids).toContain(c2.id);
    });

    it('returns empty array for unknown session', async () => {
      const result = await store.listSession('no-such-session');
      expect(result).toEqual([]);
    });
  });

  describe('listRun', () => {
    it('filters changes by runId', async () => {
      await store.save({ sessionId, agentId, runId: 'run-A', filePath: 'a.ts', operation: 'write', beforeContent: undefined, afterContent: 'a' });
      const c2 = await store.save({ sessionId, agentId, runId: 'run-B', filePath: 'b.ts', operation: 'write', beforeContent: undefined, afterContent: 'b' });

      const runB = await store.listRun(sessionId, 'run-B');
      expect(runB.length).toBe(1);
      expect(runB[0]!.id).toBe(c2.id);
    });
  });

  describe('listFile', () => {
    it('filters changes by filePath', async () => {
      const c1 = await store.save({ sessionId, agentId, runId, filePath: 'target.ts', operation: 'write', beforeContent: undefined, afterContent: 'v1' });
      await store.save({ sessionId, agentId, runId, filePath: 'other.ts', operation: 'write', beforeContent: undefined, afterContent: 'v2' });
      const c3 = await store.save({ sessionId, agentId, runId, filePath: 'target.ts', operation: 'patch', beforeContent: 'v1', afterContent: 'v1 patched' });

      const forTarget = await store.listFile(sessionId, 'target.ts');
      expect(forTarget.length).toBe(2);
      const ids = forTarget.map((c) => c.id);
      expect(ids).toContain(c1.id);
      expect(ids).toContain(c3.id);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // changedFiles
  // ─────────────────────────────────────────────────────────────

  describe('changedFiles', () => {
    it('returns unique file paths', async () => {
      await store.save({ sessionId, agentId, runId, filePath: 'a.ts', operation: 'write', beforeContent: undefined, afterContent: '' });
      await store.save({ sessionId, agentId, runId, filePath: 'a.ts', operation: 'patch', beforeContent: '', afterContent: 'x' });
      await store.save({ sessionId, agentId, runId, filePath: 'b.ts', operation: 'write', beforeContent: undefined, afterContent: '' });

      const files = await store.changedFiles(sessionId);
      expect(files.sort()).toEqual(['a.ts', 'b.ts']);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // summariesForRun
  // ─────────────────────────────────────────────────────────────

  describe('summariesForRun', () => {
    it('returns FileChangeSummary objects with no before/after content', async () => {
      await store.save({
        sessionId, agentId, runId,
        filePath: 'z.ts', operation: 'patch',
        beforeContent: 'old', afterContent: 'new',
        metadata: { startLine: 5, endLine: 5, linesAdded: 1, linesRemoved: 1 },
      });

      const summaries = await store.summariesForRun(sessionId, runId);
      expect(summaries.length).toBe(1);
      const s = summaries[0]!;
      expect(s.filePath).toBe('z.ts');
      expect(s.operation).toBe('patch');
      expect(s.isNew).toBe(false);
      expect(s.linesAdded).toBe(1);
      expect(s.linesRemoved).toBe(1);
      expect('content' in s).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // deleteSession
  // ─────────────────────────────────────────────────────────────

  describe('deleteSession', () => {
    it('removes all snapshots from disk', async () => {
      await store.save({ sessionId, agentId, runId, filePath: 'f.ts', operation: 'write', beforeContent: undefined, afterContent: 'x' });

      await store.deleteSession(sessionId);

      const after = await store.listSession(sessionId);
      expect(after).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // toSummary helper
  // ─────────────────────────────────────────────────────────────

  describe('toSummary', () => {
    it('produces a summary without content', async () => {
      const change = await store.save({
        sessionId, agentId, runId,
        filePath: 'new-file.ts', operation: 'write',
        beforeContent: undefined, afterContent: 'hello world',
      });

      const summary = toSummary(change);
      expect(summary.changeId).toBe(change.id);
      expect(summary.filePath).toBe('new-file.ts');
      expect(summary.isNew).toBe(true);
      expect(summary.sizeAfter).toBe(change.after.size);
      expect('before' in summary).toBe(false);
      expect('after' in summary).toBe(false);
    });
  });
});
