/**
 * Git push operations
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import type { PushResult } from '../../contracts/index.js';
import type { PushOptions } from '../types';
import { getCurrentBranch, isProtectedBranch } from '../analyzer/git-status';

/**
 * Push commits to remote repository
 *
 * @param cwd - Working directory (repo root)
 * @param options - Push options
 * @returns Push result
 */
export async function pushCommits(cwd: string, options?: PushOptions): Promise<PushResult> {
  const git: SimpleGit = simpleGit(cwd);
  const remote = options?.remote || 'origin';

  try {
    // Get current branch
    const branch = await getCurrentBranch(cwd);

    // Warn about protected branches with force push
    if (options?.force && isProtectedBranch(branch)) {
      return {
        success: false,
        remote,
        branch,
        commitsPushed: 0,
        error: `Refusing to force push to protected branch '${branch}'. This is dangerous and disabled by default.`,
      };
    }

    // Check how many commits ahead of remote
    const commitsToPush = await countCommitsToPush(git, remote, branch);

    if (commitsToPush === 0) {
      return {
        success: true,
        remote,
        branch,
        commitsPushed: 0,
      };
    }

    // Push to remote
    const pushOptions = options?.force ? ['--force'] : [];
    await git.push(remote, branch, pushOptions);

    return {
      success: true,
      remote,
      branch,
      commitsPushed: commitsToPush,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = cleanGitError(raw);
    const branch = await getCurrentBranch(cwd).catch(() => 'unknown');

    return {
      success: false,
      remote,
      branch,
      commitsPushed: 0,
      error: message,
    };
  }
}

function cleanGitError(message: string): string {
  return message
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('hint:'))
    .join('\n')
    .trim();
}

/**
 * Count commits ahead of remote
 */
async function countCommitsToPush(
  git: SimpleGit,
  remote: string,
  branch: string
): Promise<number> {
  try {
    // First fetch to ensure we have latest remote refs
    await git.fetch(remote, branch);

    // Count commits between remote and local
    const result = await git.raw([
      'rev-list',
      '--count',
      `${remote}/${branch}..HEAD`,
    ]);

    return parseInt(result.trim(), 10) || 0;
  } catch {
    // If remote doesn't have the branch, all local commits need pushing
    try {
      const result = await git.raw(['rev-list', '--count', 'HEAD']);
      return parseInt(result.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }
}
