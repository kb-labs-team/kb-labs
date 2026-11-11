/**
 * Storage module
 * @module @kb-labs/commit/core/storage
 */

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
  cleanOldHistory,
  initStorage,
} from './plan-storage';
