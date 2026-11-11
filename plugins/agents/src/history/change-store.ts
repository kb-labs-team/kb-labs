/**
 * ChangeStore — persists and queries file change snapshots.
 *
 * Design principles (vs old FileChangeTracker):
 * - No EventEmitter: events belong in middleware (AgentEventBus)
 * - No agentId/runId state: injected per-call by ChangeTrackingMiddleware
 * - No rollback I/O: rollback logic lives in middleware (uses workingDir from RunContext)
 * - Pure storage + query: save, load, list, cleanup
 */

import * as crypto from 'node:crypto';
import type { FileChange, FileChangeSummary, StorageConfig } from './types.js';
import { SnapshotStorage } from './snapshot-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateChangeId(): string {
  return `change-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function toSummary(change: FileChange): FileChangeSummary {
  return {
    changeId: change.id,
    filePath: change.filePath,
    operation: change.operation,
    timestamp: change.timestamp,
    linesAdded: change.metadata?.linesAdded,
    linesRemoved: change.metadata?.linesRemoved,
    isNew: !change.before,
    sizeAfter: change.after.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ChangeStore
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveChangeInput {
  sessionId: string;
  agentId: string;
  runId: string;
  filePath: string;
  operation: 'write' | 'patch' | 'delete';
  beforeContent: string | undefined;
  afterContent: string;
  metadata?: FileChange['metadata'];
}

export class ChangeStore {
  private readonly storage: SnapshotStorage;
  /** In-memory cache keyed by sessionId → changeId → FileChange */
  private readonly cache = new Map<string, Map<string, FileChange>>();

  constructor(workingDir: string, config?: Partial<StorageConfig>) {
    this.storage = new SnapshotStorage(workingDir, config);
  }

  // ── Write ────────────────────────────────────────────────────────────────

  async save(input: SaveChangeInput): Promise<FileChange> {
    const change: FileChange = {
      id: generateChangeId(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      runId: input.runId,
      filePath: input.filePath,
      operation: input.operation,
      timestamp: new Date().toISOString(),
      before: input.beforeContent !== undefined
        ? {
          content: input.beforeContent,
          hash: computeHash(input.beforeContent),
          size: Buffer.byteLength(input.beforeContent, 'utf-8'),
        }
        : undefined,
      after: {
        content: input.afterContent,
        hash: computeHash(input.afterContent),
        size: Buffer.byteLength(input.afterContent, 'utf-8'),
      },
      metadata: input.metadata,
    };

    await this.storage.saveSnapshot(input.sessionId, change);
    this._cache(input.sessionId).set(change.id, change);
    return change;
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  async get(sessionId: string, changeId: string): Promise<FileChange | null> {
    const cached = this._cache(sessionId).get(changeId);
    if (cached) {return cached;}
    const loaded = await this.storage.loadSnapshot(sessionId, changeId);
    if (loaded) {this._cache(sessionId).set(changeId, loaded);}
    return loaded;
  }

  async listSession(sessionId: string): Promise<FileChange[]> {
    return this.storage.listSnapshots(sessionId);
  }

  async listRun(sessionId: string, runId: string): Promise<FileChange[]> {
    const all = await this.listSession(sessionId);
    return all.filter((c) => c.runId === runId);
  }

  async listFile(sessionId: string, filePath: string): Promise<FileChange[]> {
    const all = await this.listSession(sessionId);
    return all.filter((c) => c.filePath === filePath);
  }

  /** Returns unique file paths touched in a session */
  async changedFiles(sessionId: string): Promise<string[]> {
    const all = await this.listSession(sessionId);
    return [...new Set(all.map((c) => c.filePath))];
  }

  // ── Summaries ─────────────────────────────────────────────────────────────

  async summariesForRun(sessionId: string, runId: string): Promise<FileChangeSummary[]> {
    const changes = await this.listRun(sessionId, runId);
    return changes.map(toSummary);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  async cleanup(): Promise<{ deleted: number; keptLast: number }> {
    return this.storage.cleanupOldSessions();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.storage.deleteSession(sessionId);
    this.cache.delete(sessionId);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _cache(sessionId: string): Map<string, FileChange> {
    let m = this.cache.get(sessionId);
    if (!m) {
      m = new Map();
      this.cache.set(sessionId, m);
    }
    return m;
  }
}
