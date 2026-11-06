/**
 * Snapshot storage - persist file change snapshots to disk
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileChange, StorageConfig } from './types.js';

const DEFAULT_CONFIG: Required<StorageConfig> = {
  basePath: '.kb/agents/sessions',
  maxSessions: 30,
  maxAgeDays: 30,
  maxTotalSizeMb: 500,
};

/**
 * Storage for file change snapshots
 */
export class SnapshotStorage {
  private workingDir: string;
  private config: Required<StorageConfig>;

  constructor(workingDir: string, config?: Partial<StorageConfig>) {
    this.workingDir = workingDir;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Save snapshot to disk
   */
  async saveSnapshot(sessionId: string, change: FileChange): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    const snapshotsDir = path.join(sessionDir, 'snapshots');

    // Ensure directories exist
    await fs.promises.mkdir(snapshotsDir, { recursive: true });

    // Write snapshot file
    const snapshotPath = path.join(snapshotsDir, `${change.id}.json`);
    await fs.promises.writeFile(
      snapshotPath,
      JSON.stringify(change, null, 2),
      'utf-8'
    );

    // Update index
    await this.updateIndex(sessionId, change);
  }

  /**
   * Load snapshot by ID
   */
  async loadSnapshot(sessionId: string, changeId: string): Promise<FileChange | null> {
    try {
      const snapshotPath = path.join(
        this.getSessionDir(sessionId),
        'snapshots',
        `${changeId}.json`
      );

      const content = await fs.promises.readFile(snapshotPath, 'utf-8');
      return JSON.parse(content) as FileChange;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        // Corrupted JSON - return null instead of throwing
        return null;
      }
      throw error;
    }
  }

  /**
   * List all snapshots for session
   */
  async listSnapshots(sessionId: string): Promise<FileChange[]> {
    try {
      const indexPath = path.join(this.getSessionDir(sessionId), 'index.json');
      const content = await fs.promises.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content) as SessionIndex;

      // Load full snapshots
      const changes: FileChange[] = [];
      for (const changeId of index.changes) {
        const change = await this.loadSnapshot(sessionId, changeId);
        if (change) {
          changes.push(change);
        }
      }

      // Sort by timestamp (chronological order)
      changes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      return changes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Index missing - fall back to reading snapshots directory directly
        const snapshotsDir = path.join(this.getSessionDir(sessionId), 'snapshots');

        try {
          const files = await fs.promises.readdir(snapshotsDir);
          const changes: FileChange[] = [];

          for (const file of files) {
            if (file.endsWith('.json')) {
              const changeId = file.replace('.json', '');
              const change = await this.loadSnapshot(sessionId, changeId);
              if (change) {
                changes.push(change);
              }
            }
          }

          // Sort by timestamp
          changes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

          return changes;
        } catch {
          return [];
        }
      }
      throw error;
    }
  }

  /**
   * Delete all snapshots for session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);

    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore if doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Cleanup old sessions based on retention policy
   */
  async cleanupOldSessions(): Promise<{ deleted: number; keptLast: number }> {
    const _sessionsBaseDir = path.join(this.workingDir, this.config.basePath);

    try {
      const sessions = await this.listAllSessions();

      // Sort by creation time (newest first)
      sessions.sort((a, b) => b.createdAt - a.createdAt);

      let deleted = 0;

      // Delete by count (keep last N)
      if (sessions.length > this.config.maxSessions) {
        const toDelete = sessions.slice(this.config.maxSessions);

        for (const session of toDelete) {
          await this.deleteSession(session.id);
          deleted++;
        }
      }

      // Delete by age
      const now = Date.now();
      const maxAge = this.config.maxAgeDays * 24 * 60 * 60 * 1000;

      for (const session of sessions) {
        if (now - session.createdAt > maxAge) {
          await this.deleteSession(session.id);
          deleted++;
        }
      }

      return {
        deleted,
        keptLast: Math.min(sessions.length, this.config.maxSessions),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { deleted: 0, keptLast: 0 };
      }
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get session directory path
   */
  private getSessionDir(sessionId: string): string {
    return path.join(this.workingDir, this.config.basePath, sessionId);
  }

  /**
   * Update session index
   */
  private async updateIndex(sessionId: string, change: FileChange): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    const indexPath = path.join(sessionDir, 'index.json');

    let index: SessionIndex;

    try {
      const content = await fs.promises.readFile(indexPath, 'utf-8');
      index = JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Create new index
        index = {
          sessionId,
          createdAt: new Date().toISOString(),
          changes: [],
        };
      } else {
        throw error;
      }
    }

    // Add change to index
    if (!index.changes.includes(change.id)) {
      index.changes.push(change.id);
    }

    // Write index
    await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  /**
   * List all sessions with metadata
   */
  private async listAllSessions(): Promise<SessionMetadata[]> {
    const _sessionsBaseDir = path.join(this.workingDir, this.config.basePath);

    try {
      const sessionDirs = await fs.promises.readdir(_sessionsBaseDir);

      const sessions: SessionMetadata[] = [];

      for (const sessionId of sessionDirs) {
        const sessionDir = path.join(_sessionsBaseDir, sessionId);
        const stats = await fs.promises.stat(sessionDir);

        if (stats.isDirectory()) {
          sessions.push({
            id: sessionId,
            createdAt: stats.mtimeMs,
          });
        }
      }

      return sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Internal Types
// ═══════════════════════════════════════════════════════════════════════

interface SessionIndex {
  sessionId: string;
  createdAt: string;
  changes: string[]; // Array of change IDs
}

interface SessionMetadata {
  id: string;
  createdAt: number; // Timestamp
}
