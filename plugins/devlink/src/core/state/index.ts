import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { DevlinkState, DevlinkPlan } from '../../contracts/index.js';

const DEFAULT_STATE: DevlinkState = {
  currentMode: null,
  lastApplied: null,
  frozenAt: null,
};

function getStatePath(rootDir: string): string {
  return join(rootDir, '.kb', 'devlink', 'state.json');
}

function getLockPath(rootDir: string): string {
  return join(rootDir, '.kb', 'devlink', 'lock.json');
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

// ─── State ────────────────────────────────────────────────────────────────────

export function loadState(rootDir: string): DevlinkState {
  const statePath = getStatePath(rootDir);
  if (!existsSync(statePath)) {return { ...DEFAULT_STATE };}

  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as DevlinkState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(rootDir: string, state: DevlinkState): void {
  const statePath = getStatePath(rootDir);
  ensureDir(statePath);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// ─── Lock / Freeze ────────────────────────────────────────────────────────────

export interface LockFile {
  frozenAt: string;
  plan: DevlinkPlan;
}

export function freeze(rootDir: string, currentPlan: DevlinkPlan): LockFile {
  const lock: LockFile = {
    frozenAt: new Date().toISOString(),
    plan: currentPlan,
  };

  const lockPath = getLockPath(rootDir);
  ensureDir(lockPath);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf-8');

  // Update state.frozenAt
  const state = loadState(rootDir);
  saveState(rootDir, { ...state, frozenAt: lock.frozenAt });

  return lock;
}

export function loadLock(rootDir: string): LockFile | null {
  const lockPath = getLockPath(rootDir);
  if (!existsSync(lockPath)) {return null;}

  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockFile;
  } catch {
    return null;
  }
}
