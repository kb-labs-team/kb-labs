/**
 * File change history types
 */

export type { FileChangeSummary } from '../contracts/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core snapshot types (internal to agent-history)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single file change snapshot.
 * Captured by ChangeTrackingMiddleware via afterToolExec.
 * agentId / runId are middleware context — not tool concerns.
 */
export interface FileChange {
  /** Unique change ID */
  id: string;

  /** Session ID for grouping changes */
  sessionId: string;

  /** Agent ID that made the change (injected by middleware) */
  agentId: string;

  /** Run ID — enables per-run/per-turn filtering and rollback */
  runId: string;

  /** File path relative to working directory */
  filePath: string;

  /** Operation type */
  operation: 'write' | 'patch' | 'delete';

  /** ISO timestamp when change was captured */
  timestamp: string;

  /** Snapshot before the change (undefined = new file) */
  before?: {
    content: string;
    hash: string;
    size: number;
  };

  /** Snapshot after the change */
  after: {
    content: string;
    hash: string;
    size: number;
  };

  /** Whether this change has been approved by the user */
  approved?: boolean;

  /** ISO timestamp when change was approved */
  approvedAt?: string;

  /** Operation-specific metadata from tool output */
  metadata?: {
    // fs_patch specific
    startLine?: number;
    endLine?: number;
    linesAdded?: number;
    linesRemoved?: number;

    // fs_write specific
    isOverwrite?: boolean;

    // fs_delete specific
    wasDeleted?: boolean;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage config
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  /** Base path relative to workingDir. Default: '.kb/agents/sessions' */
  basePath: string;
  /** Max sessions to keep. Default: 30 */
  maxSessions?: number;
  /** Max age in days. Default: 30 */
  maxAgeDays?: number;
  /** Max total storage in MB. Default: 500 */
  maxTotalSizeMb?: number;
}
