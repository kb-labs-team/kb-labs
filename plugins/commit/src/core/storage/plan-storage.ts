/**
 * Commit plan runtime storage in the project's KB state directory.
 */

/* eslint-disable no-await-in-loop -- Sequential file operations required for plan cleanup and history management */

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { CommitPlan, ApplyResult, GitStatusSnapshot } from '../../contracts/index.js';
import { CommitPlanSchema, GitStatusSnapshotSchema } from '../../contracts/index.js';
import { resolveRuntimeStatePath } from '@kb-labs/sdk/adapters';
import { getFileSummaries } from '../analyzer/file-summary';

const COMMIT_STATE_SEGMENTS = ['commit'] as const;
const PLANS_DIR = 'plans';
const CURRENT_DIR = 'current';
const HISTORY_DIR = 'history';
const PLAN_FILE = 'plan.json';
const STATUS_FILE = 'status.json';
const RESULT_FILE = 'result.json';
const MAX_HISTORY_ENTRIES = 30; // Keep last 30 history entries

/**
 * Normalize scope string for use in file paths
 * @example "@kb-labs/mind" -> "@kb-labs-mind"
 * @example "packages/core/**" -> "packages-core"
 */
function normalizeScopeForPath(scope: string): string {
  return scope
    .replace(/\//g, '-')
    .replace(/\*/g, '')
    .replace(/\./g, '-')
    .replace(/:/g, '-');
}

/**
 * Get path to commit storage directory
 */
export function getCommitStoragePath(cwd: string): string {
  return resolveRuntimeStatePath(cwd, COMMIT_STATE_SEGMENTS);
}

/**
 * Get path to scope-specific plan directory
 */
export function getScopePlanDir(cwd: string, scope: string = 'root'): string {
  const scopeDir = normalizeScopeForPath(scope);
  return join(getCommitStoragePath(cwd), PLANS_DIR, scopeDir);
}

/**
 * Get path to current plan file for a scope
 */
export function getCurrentPlanPath(cwd: string, scope: string = 'root'): string {
  return join(getScopePlanDir(cwd, scope), CURRENT_DIR, PLAN_FILE);
}

/**
 * Get path to current status file for a scope
 */
export function getCurrentStatusPath(cwd: string, scope: string = 'root'): string {
  return join(getScopePlanDir(cwd, scope), CURRENT_DIR, STATUS_FILE);
}

/**
 * Save commit plan to storage
 */
export async function savePlan(cwd: string, plan: CommitPlan, scope: string = 'root'): Promise<void> {
  const planPath = getCurrentPlanPath(cwd, scope);
  const statusPath = getCurrentStatusPath(cwd, scope);

  // Ensure directory exists
  await mkdir(dirname(planPath), { recursive: true });

  // Save plan
  await writeFile(planPath, JSON.stringify(plan, null, 2));

  // Save status snapshot — use git status already captured in the plan
  const status = plan.gitStatus;
  const allFiles = [...status.staged, ...status.unstaged, ...status.untracked];
  const summaries = await getFileSummaries(cwd, allFiles);

  const snapshot: GitStatusSnapshot = {
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    status,
    summaries,
  };

  await writeFile(statusPath, JSON.stringify(snapshot, null, 2));
}

/**
 * Load current commit plan from storage
 */
export async function loadPlan(cwd: string, scope: string = 'root'): Promise<CommitPlan | null> {
  const planPath = getCurrentPlanPath(cwd, scope);

  try {
    const content = await readFile(planPath, 'utf-8');
    const data = JSON.parse(content);

    // Validate with schema
    const result = CommitPlanSchema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `Commit plan is corrupted and cannot be loaded. Run 'kb commit:generate' to create a new plan.\n` +
        result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
      );
    }

    return result.data;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `Commit plan file is not valid JSON. Run 'kb commit:generate' to create a new plan.`,
      );
    }
    // Re-throw corruption errors (thrown above) and file-not-found returns null
    if (err instanceof Error && err.message.startsWith('Commit plan is corrupted')) {
      throw err;
    }
    return null;
  }
}

/**
 * Load current status snapshot from storage
 */
export async function loadStatus(cwd: string, scope: string = 'root'): Promise<GitStatusSnapshot | null> {
  const statusPath = getCurrentStatusPath(cwd, scope);

  try {
    const content = await readFile(statusPath, 'utf-8');
    const data = JSON.parse(content);

    const result = GitStatusSnapshotSchema.safeParse(data);
    if (!result.success) {
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
}

/**
 * Check if a plan exists
 * Returns false for missing plans; throws for corrupted plans so the caller can surface the error.
 */
export async function hasPlan(cwd: string, scope: string = 'root'): Promise<boolean> {
  const plan = await loadPlan(cwd, scope);
  return plan !== null;
}

/**
 * Clear current commit plan
 */
export async function clearPlan(cwd: string, scope: string = 'root'): Promise<void> {
  const currentDir = join(getScopePlanDir(cwd, scope), CURRENT_DIR);

  try {
    await rm(currentDir, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

/**
 * Save plan and result to history
 */
export async function saveToHistory(
  cwd: string,
  plan: CommitPlan,
  result: ApplyResult,
  scope: string = 'root'
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const historyDir = join(getScopePlanDir(cwd, scope), HISTORY_DIR, timestamp);

  await mkdir(historyDir, { recursive: true });

  await writeFile(join(historyDir, PLAN_FILE), JSON.stringify(plan, null, 2));
  await writeFile(join(historyDir, RESULT_FILE), JSON.stringify(result, null, 2));

  // Clean old history entries after saving new one
  await cleanOldHistory(cwd, scope);
}

/**
 * List history entries
 */
export async function listHistory(
  cwd: string,
  scope: string = 'root'
): Promise<Array<{ timestamp: string; path: string }>> {
  const historyDir = join(getScopePlanDir(cwd, scope), HISTORY_DIR);

  try {
    const entries = await readdir(historyDir, { withFileTypes: true });

    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        timestamp: e.name,
        path: join(historyDir, e.name),
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)); // Newest first
  } catch {
    return [];
  }
}

/**
 * Clean old history entries, keeping only the most recent N entries
 */
export async function cleanOldHistory(
  cwd: string,
  scope: string = 'root',
  maxEntries: number = MAX_HISTORY_ENTRIES
): Promise<void> {
  const entries = await listHistory(cwd, scope);

  // If we have more entries than the limit, delete the oldest ones
  if (entries.length > maxEntries) {
    const toDelete = entries.slice(maxEntries); // Keep first N (newest), delete rest

    for (const entry of toDelete) {
      try {
        await rm(entry.path, { recursive: true, force: true });
      } catch {
        // Ignore errors if directory doesn't exist or can't be deleted
      }
    }
  }
}

/**
 * Initialize storage directory structure
 */
export async function initStorage(cwd: string, scope: string = 'root'): Promise<void> {
  const dirs = [
    join(getScopePlanDir(cwd, scope), CURRENT_DIR),
    join(getScopePlanDir(cwd, scope), HISTORY_DIR),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * List all scopes with plans
 */
export async function listScopes(cwd: string): Promise<string[]> {
  const plansDir = join(getCommitStoragePath(cwd), PLANS_DIR);

  try {
    const entries = await readdir(plansDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
