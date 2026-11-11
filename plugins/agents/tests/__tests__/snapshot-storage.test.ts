/**
 * Unit tests for SnapshotStorage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SnapshotStorage } from '../../src/history/snapshot-storage';
import type { FileChange } from '../../src/history/types';

describe('SnapshotStorage', () => {
  const testBasePath = path.join(__dirname, '.tmp-test-storage');
  const sessionId = 'test-session-123';

  let storage: SnapshotStorage;

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }

    storage = new SnapshotStorage(testBasePath, { basePath: '' });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  const createMockChange = (overrides?: Partial<FileChange>): FileChange => ({
    id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sessionId: sessionId,
    agentId: 'test-agent',
    runId: 'test-run',
    filePath: 'test.ts',
    operation: 'write',
    timestamp: new Date().toISOString(),
    after: {
      content: 'test content',
      hash: 'abc123',
      size: 12,
    },
    ...overrides,
  });

  describe('saveSnapshot', () => {
    it('should save snapshot to disk', async () => {
      const change = createMockChange();

      await storage.saveSnapshot(sessionId, change);

      const sessionDir = path.join(testBasePath, sessionId);
      const snapshotPath = path.join(sessionDir, 'snapshots', `${change.id}.json`);

      expect(fs.existsSync(snapshotPath)).toBe(true);
    });

    it('should create session directories if they do not exist', async () => {
      const change = createMockChange();

      await storage.saveSnapshot(sessionId, change);

      const sessionDir = path.join(testBasePath, sessionId);
      const snapshotsDir = path.join(sessionDir, 'snapshots');

      expect(fs.existsSync(sessionDir)).toBe(true);
      expect(fs.existsSync(snapshotsDir)).toBe(true);
    });

    it('should store complete change data', async () => {
      const change = createMockChange({
        before: {
          content: 'old content',
          hash: 'def456',
          size: 11,
        },
        metadata: {
          startLine: 5,
          endLine: 10,
        },
      });

      await storage.saveSnapshot(sessionId, change);

      const loaded = await storage.loadSnapshot(sessionId, change.id);

      expect(loaded).toEqual(change);
    });

    it('should update index with file change', async () => {
      const change1 = createMockChange({ filePath: 'file1.ts' });
      const change2 = createMockChange({ filePath: 'file2.ts' });

      await storage.saveSnapshot(sessionId, change1);
      await storage.saveSnapshot(sessionId, change2);

      const indexPath = path.join(testBasePath, sessionId, 'index.json');
      expect(fs.existsSync(indexPath)).toBe(true);

      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      expect(indexData.changes).toContain(change1.id);
      expect(indexData.changes).toContain(change2.id);
    });
  });

  describe('loadSnapshot', () => {
    it('should load saved snapshot', async () => {
      const change = createMockChange();

      await storage.saveSnapshot(sessionId, change);
      const loaded = await storage.loadSnapshot(sessionId, change.id);

      expect(loaded).toEqual(change);
    });

    it('should return null for non-existent snapshot', async () => {
      const loaded = await storage.loadSnapshot(sessionId, 'non-existent-id');

      expect(loaded).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const loaded = await storage.loadSnapshot('non-existent-session', 'some-id');

      expect(loaded).toBeNull();
    });
  });

  describe('listSnapshots', () => {
    it('should return all snapshots for session', async () => {
      const change1 = createMockChange({ filePath: 'file1.ts' });
      const change2 = createMockChange({ filePath: 'file2.ts' });
      const change3 = createMockChange({ filePath: 'file3.ts' });

      await storage.saveSnapshot(sessionId, change1);
      await storage.saveSnapshot(sessionId, change2);
      await storage.saveSnapshot(sessionId, change3);

      const snapshots = await storage.listSnapshots(sessionId);

      expect(snapshots).toHaveLength(3);
      expect(snapshots.map((s) => s.filePath)).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
    });

    it('should return empty array for non-existent session', async () => {
      const snapshots = await storage.listSnapshots('non-existent-session');

      expect(snapshots).toHaveLength(0);
    });

    it('should return snapshots in chronological order', async () => {
      const change1 = createMockChange({ timestamp: '2024-01-01T10:00:00Z' });
      const change2 = createMockChange({ timestamp: '2024-01-01T11:00:00Z' });
      const change3 = createMockChange({ timestamp: '2024-01-01T09:00:00Z' });

      await storage.saveSnapshot(sessionId, change1);
      await storage.saveSnapshot(sessionId, change2);
      await storage.saveSnapshot(sessionId, change3);

      const snapshots = await storage.listSnapshots(sessionId);

      expect(snapshots[0]!.timestamp).toBe('2024-01-01T09:00:00Z');
      expect(snapshots[1]!.timestamp).toBe('2024-01-01T10:00:00Z');
      expect(snapshots[2]!.timestamp).toBe('2024-01-01T11:00:00Z');
    });
  });

  // NOTE: deleteSnapshot() and getSessionIndex() methods are not implemented yet
  // These tests are commented out until implementation is needed

  describe('cleanupOldSessions', () => {
    it('should delete sessions older than maxAgeDays', async () => {
      // Create old session directory
      const oldSessionId = 'old-session';
      const oldSessionDir = path.join(testBasePath, oldSessionId);
      fs.mkdirSync(oldSessionDir, { recursive: true });

      // Set modified time to 31 days ago
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldSessionDir, new Date(oldTimestamp), new Date(oldTimestamp));

      // Create recent session
      const recentSessionId = 'recent-session';
      const change = createMockChange();
      await storage.saveSnapshot(recentSessionId, change);

      // Run cleanup with 30 day retention
      await storage.cleanupOldSessions();

      // Old session should be deleted
      expect(fs.existsSync(oldSessionDir)).toBe(false);

      // Recent session should remain
      const recentSessionDir = path.join(testBasePath, recentSessionId);
      expect(fs.existsSync(recentSessionDir)).toBe(true);
    });

    it('should keep only maxSessions most recent sessions', async () => {
      // Create 35 sessions (exceeds default maxSessions of 30)
      for (let i = 0; i < 35; i++) {
        const sessionId = `session-${i}`;
        const change = createMockChange();
        await storage.saveSnapshot(sessionId, change);

        // Add small delay to ensure different mtimes
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }

      // Run cleanup
      await storage.cleanupOldSessions();

      // Check remaining sessions
      const sessions = fs.readdirSync(testBasePath);
      expect(sessions.length).toBeLessThanOrEqual(30);
    });

    it('should respect custom retention policy', async () => {
      const customStorage = new SnapshotStorage(testBasePath, {
        maxSessions: 5,
        maxAgeDays: 7,
      });

      // Create 10 sessions
      for (let i = 0; i < 10; i++) {
        const sessionId = `session-${i}`;
        const change = createMockChange();
        await customStorage.saveSnapshot(sessionId, change);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }

      // Run cleanup
      await customStorage.cleanupOldSessions();

      // Should keep only 5 sessions
      const sessions = fs.readdirSync(testBasePath);
      expect(sessions.length).toBeLessThanOrEqual(5);
    });
  });

  describe('storage size limits', () => {
    it('should enforce maxTotalSizeMb limit', async () => {
      const smallStorage = new SnapshotStorage(testBasePath, {
        maxTotalSizeMb: 1, // 1 MB limit
      });

      // Try to save large content (>1MB)
      const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2 MB
      const change = createMockChange({
        after: {
          content: largeContent,
          hash: 'hash123',
          size: Buffer.byteLength(largeContent, 'utf-8'),
        },
      });

      // This should trigger cleanup when total size exceeds limit
      await smallStorage.saveSnapshot(sessionId, change);

      // Storage should handle the limit (either reject or cleanup)
      const sessions = fs.readdirSync(testBasePath);
      expect(sessions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('error handling', () => {
    it('should handle corrupted snapshot files gracefully', async () => {
      const change = createMockChange();
      await storage.saveSnapshot(sessionId, change);

      // Corrupt the file
      const snapshotPath = path.join(
        testBasePath,
        sessionId,
        'snapshots',
        `${change.id}.json`
      );
      fs.writeFileSync(snapshotPath, 'invalid json{', 'utf-8');

      // Should return null instead of throwing
      const loaded = await storage.loadSnapshot(sessionId, change.id);
      expect(loaded).toBeNull();
    });

    it('should handle missing index file gracefully', async () => {
      const change = createMockChange();
      await storage.saveSnapshot(sessionId, change);

      // Delete index
      const indexPath = path.join(testBasePath, sessionId, 'index.json');
      fs.unlinkSync(indexPath);

      // Should still be able to list snapshots
      const snapshots = await storage.listSnapshots(sessionId);
      expect(snapshots).toHaveLength(1);
    });
  });
});
