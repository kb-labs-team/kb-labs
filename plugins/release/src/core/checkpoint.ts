/**
 * Release checkpoint — persists publish state across pipeline runs.
 *
 * Written after successful npm publish, updated per git root after each
 * commit/tag/push. Allows recovery from partial failures without
 * re-publishing already-published packages or re-bumping versions.
 *
 * File: <repoRoot>/.kb/release/checkpoint.json
 * Deleted automatically after full pipeline success.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitRootState {
  committed: boolean;
  tagged: string[];
  pushed: boolean;
}

export interface ReleaseCheckpoint {
  /** Identifies this checkpoint — must match current plan to be usable. */
  flow: string;
  /** Lockstep version (all packages same) or 'independent'. */
  version: string;
  publishedPackages: Array<{
    name: string;
    version: string;
    path: string;
    gitRoot: string;
  }>;
  /** Per git-root git operation state. Key = absolute path. */
  gitRoots: Record<string, GitRootState>;
  createdAt: string;
  completedAt?: string;
}

function checkpointPath(repoRoot: string): string {
  return join(repoRoot, '.kb', 'release', 'checkpoint.json');
}

export function loadCheckpoint(repoRoot: string): ReleaseCheckpoint | null {
  const path = checkpointPath(repoRoot);
  if (!existsSync(path)) {return null;}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ReleaseCheckpoint;
  } catch {
    return null;
  }
}

export function writeCheckpoint(repoRoot: string, checkpoint: Omit<ReleaseCheckpoint, 'createdAt'>): void {
  mkdirSync(join(repoRoot, '.kb', 'release'), { recursive: true });
  const data: ReleaseCheckpoint = { ...checkpoint, createdAt: new Date().toISOString() };
  writeFileSync(checkpointPath(repoRoot), JSON.stringify(data, null, 2));
}

export function updateCheckpointGitRoot(repoRoot: string, gitRoot: string, state: GitRootState): void {
  const checkpoint = loadCheckpoint(repoRoot);
  if (!checkpoint) {return;}
  checkpoint.gitRoots[gitRoot] = state;
  writeFileSync(checkpointPath(repoRoot), JSON.stringify(checkpoint, null, 2));
}

export function markCheckpointComplete(repoRoot: string): void {
  const checkpoint = loadCheckpoint(repoRoot);
  if (!checkpoint) {return;}
  checkpoint.completedAt = new Date().toISOString();
  writeFileSync(checkpointPath(repoRoot), JSON.stringify(checkpoint, null, 2));
}

export function deleteCheckpoint(repoRoot: string): void {
  try { unlinkSync(checkpointPath(repoRoot)); } catch { /* already gone */ }
}

/**
 * Check if an existing checkpoint is usable for the current release.
 * A checkpoint is usable if it matches flow + version and publish is done but git is not.
 */
export function isCheckpointResumable(
  checkpoint: ReleaseCheckpoint,
  flow: string,
  version: string,
): boolean {
  if (checkpoint.completedAt) {return false;}
  if (checkpoint.flow !== flow) {return false;}
  if (checkpoint.version !== version && version !== 'independent') {return false;}
  // Usable if publish happened but at least one git root is not fully pushed
  return checkpoint.publishedPackages.length > 0 &&
    Object.values(checkpoint.gitRoots).some(s => !s.pushed);
}
