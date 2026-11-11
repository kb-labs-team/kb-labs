/**
 * @module @kb-labs/review/core
 * Core orchestration logic for AI Review plugin.
 *
 * Coordinates heuristic engines, LLM analyzers, caching, and deduplication.
 */

export { ReviewOrchestrator, runReview } from './orchestrator.js';
export { PresetLoader, getPresetLoader, loadPreset, builtinPresets } from './presets/index.js';
export {
  resolveGitScope,
  discoverRepos,
  getReposWithChanges,
  type GitScopeOptions,
  type ScopedFiles,
} from './git-scope.js';

// Diff provider for LLM-Lite mode
export {
  DiffProvider,
  createDiffProvider,
  type DiffHunk,
  type FileDiff,
  type BatchDiffRequest,
  type BatchDiffResult,
} from './diff-provider.js';

// Findings cache for incremental review
export {
  FindingsCache,
  createFindingsCache,
  hashFileContent,
  findingSignature,
  type CachedFinding,
  type FileCacheEntry,
  type FindingsCacheData,
  type CacheLookupResult,
  type IncrementalResult,
} from './findings-cache.js';
