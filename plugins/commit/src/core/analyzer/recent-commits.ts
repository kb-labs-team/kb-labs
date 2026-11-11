/**
 * Recent commits analysis for style matching
 */

import { simpleGit, type SimpleGit } from "simple-git";

/**
 * Get recent commit messages for style reference
 *
 * @param cwd - Working directory
 * @param count - Number of commits to retrieve (default: 10)
 * @returns Array of commit messages (subject line only)
 */
export async function getRecentCommits(
  cwd: string,
  count: number = 10,
): Promise<string[]> {
  const git: SimpleGit = simpleGit(cwd);

  try {
    const log = await git.log({
      maxCount: count,
      format: {
        message: "%s", // Subject line only
      },
    });

    return log.all.map((commit) => commit.message);
  } catch {
    // Return empty array if no commits or error
    return [];
  }
}

/**
 * Detect the commit style from recent commits
 *
 * @returns Detected style hints
 */
export function detectCommitStyle(commits: string[]): {
  usesConventional: boolean;
  commonScopes: string[];
  avgLength: number;
} {
  if (commits.length === 0) {
    return {
      usesConventional: false,
      commonScopes: [],
      avgLength: 50,
    };
  }

  // Check for conventional commit pattern: type(scope)?: message
  const conventionalPattern =
    /^(feat|fix|docs|style|refactor|test|chore|ci|perf|build)(\([^)]+\))?!?:/i;
  const conventionalMatches = commits.filter((c) =>
    conventionalPattern.test(c),
  );
  const usesConventional = conventionalMatches.length >= commits.length * 0.5;

  // Extract scopes
  const scopePattern = /^\w+\(([^)]+)\)/;
  const scopes = commits
    .map((c) => {
      const match = c.match(scopePattern);
      return match ? match[1] : null;
    })
    .filter((s): s is string => s !== null);

  // Count scope frequency
  const scopeCounts = scopes.reduce<Record<string, number>>((acc, scope) => {
    acc[scope] = (acc[scope] || 0) + 1;
    return acc;
  }, {});

  // Get top 5 most common scopes
  const commonScopes = Object.entries(scopeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([scope]) => scope);

  // Calculate average message length
  const avgLength = Math.round(
    commits.reduce((sum, c) => sum + c.length, 0) / commits.length,
  );

  return {
    usesConventional,
    commonScopes,
    avgLength,
  };
}
