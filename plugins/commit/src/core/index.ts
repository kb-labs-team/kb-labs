/**
 * KB Labs Commit Core
 *
 * Core business logic for AI-powered commit generation.
 *
 * @module @kb-labs/commit/core
 */

// Types
export * from './types';

// Analyzer
export {
  getGitStatus,
  getAllChangedFiles,
  hasChanges,
  getCurrentBranch,
  isProtectedBranch,
  getFileSummaries,
  formatFileSummary,
  getFileDiff,
  getRecentCommits,
  detectCommitStyle,
} from './analyzer';
export type { FileDiff } from './analyzer';

// Generator
export {
  generateCommitPlan,
  buildPrompt,
  parseResponse,
  SYSTEM_PROMPT,
  generateHeuristicPlan,
} from './generator';

// Applier
export { applyCommitPlan, formatCommitMessage, pushCommits } from './applier';

// Validator
export { validatePlanIntegrity, checkPlanStaleness, groupFilesByRepo } from './validator';

// Storage
export {
  getCommitStoragePath,
  getCurrentPlanPath,
  getCurrentStatusPath,
  savePlan,
  loadPlan,
  loadStatus,
  hasPlan,
  clearPlan,
  saveToHistory,
  listHistory,
  initStorage,
} from './storage';
