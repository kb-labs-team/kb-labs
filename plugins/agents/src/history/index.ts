/**
 * File change history system for KB Labs Agents
 *
 * Provides: change tracking, snapshot persistence, conflict detection.
 * Integration: use ChangeTrackingMiddleware from @kb-labs/agents/core to wire into SDK pipeline.
 */

export { ChangeStore, computeHash, toSummary } from './change-store.js';
export { SnapshotStorage } from './snapshot-storage.js';
export { ConflictDetector } from './conflict-detector.js';
export { generateUnifiedDiff, countDiffLines } from './diff-generator.js';

export type {
  FileChange,
  FileChangeSummary,
  StorageConfig,
} from './types.js';

// Public rollback/conflict contracts live in agent-contracts, re-exported for convenience
export type { RollbackResult, ConflictInfo } from '../contracts/index.js';

export type { SaveChangeInput } from './change-store.js';

export type {
  ConflictType,
  DetectedConflict,
  ConflictCheckInput,
} from './conflict-detector.js';
