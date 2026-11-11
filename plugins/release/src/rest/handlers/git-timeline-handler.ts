/**
 * Git Timeline handler - Get git commit history and version preview
 *
 * Analyzes conventional commits since last tag and suggests next version
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type {
  GitTimelineResponse,
  GitCommit,
  GitTimelineInput,
} from '../../contracts/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveScopePath } from '../../shared/utils';

export default defineHandler({
  async execute(ctx, input: RestInput<GitTimelineInput>): Promise<GitTimelineResponse> {
    try {
    const scope = input.query?.scope || 'root';
    const cwd = ctx.cwd || process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    // Get scope path using proper package discovery
    const scopePath = await resolveScopePath(repoRoot, scope);

    // Get current version from package.json
    let currentVersion: string | undefined;
    try {
      const pkg = JSON.parse(await readFile(join(scopePath, 'package.json'), 'utf-8'));
      currentVersion = pkg.version;
    } catch {
      // No version found
    }

    // Get last git tag
    const lastTagResult = await ctx.api.shell.exec(
      'git',
      ['describe', '--tags', '--abbrev=0'],
      { cwd: scopePath }
    );
    const lastTag = lastTagResult.code === 0 ? lastTagResult.stdout.trim() : undefined;

    // Get commits since last tag (or all commits if no tag)
    const gitLogArgs = lastTag
      ? ['log', `${lastTag}..HEAD`, '--pretty=format:%H|%s|%an|%aI', '--']
      : ['log', '--pretty=format:%H|%s|%an|%aI', '--max-count=50', '--'];

    const logResult = await ctx.api.shell.exec('git', gitLogArgs, { cwd: scopePath });

    ctx.platform?.logger?.info?.('Git timeline log result', {
      code: logResult.code,
      stdout: logResult.stdout?.substring(0, 300),
      stderr: logResult.stderr?.substring(0, 300),
      args: gitLogArgs,
      cwd: scopePath,
      lastTag,
    });

    // Parse commits
    const commits: GitCommit[] = [];
    if (logResult.code === 0 && logResult.stdout) {
      const lines = logResult.stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const [sha, message, author, date] = line.split('|');
        if (!sha || !message) {continue;}

        const parsed = parseConventionalCommit(message);

        commits.push({
          sha: sha || '',
          shortSha: sha ? sha.substring(0, 7) : '',
          message: message || '',
          type: parsed.type,
          bump: parsed.bump,
          scope: parsed.scope,
          author: author || 'Unknown',
          date: date || new Date().toISOString(),
        });
      }
    }

    // Calculate suggested bump
    const suggestedBump = calculateSuggestedBump(commits);

    // Calculate suggested version
    let suggestedVersion: string | undefined;
    if (currentVersion && suggestedBump !== 'none') {
      suggestedVersion = bumpVersion(currentVersion, suggestedBump);
    }

    return {
      scope,
      currentVersion,
      suggestedVersion,
      suggestedBump,
      commits,
      unreleased: commits.length,
      lastTag,
      hasUnreleasedChanges: commits.length > 0,
    };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});

/**
 * Parse conventional commit message
 * Format: type(scope): subject
 * Examples:
 * - feat: add new feature → minor
 * - fix: bug fix → patch
 * - feat!: breaking change → major
 * - BREAKING CHANGE: → major
 */
function parseConventionalCommit(message: string): {
  type: GitCommit['type'];
  bump: GitCommit['bump'];
  scope?: string;
} {
  // Check for BREAKING CHANGE
  if (message.includes('BREAKING CHANGE') || message.includes('!:')) {
    return { type: 'BREAKING', bump: 'major' };
  }

  // Parse conventional commit format
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)/);

  if (!match) {
    return { type: 'unknown', bump: 'none' };
  }

  const [, type, scope] = match;

  // Type safety: if no type matched, return unknown
  if (!type) {
    return { type: 'unknown', bump: 'none', scope };
  }

  // Map type to bump
  let bump: GitCommit['bump'] = 'none';
  let commitType: GitCommit['type'] = 'unknown';

  switch (type.toLowerCase()) {
    case 'feat':
      commitType = 'feat';
      bump = 'minor';
      break;
    case 'fix':
      commitType = 'fix';
      bump = 'patch';
      break;
    case 'perf':
      commitType = 'perf';
      bump = 'patch';
      break;
    case 'chore':
      commitType = 'chore';
      bump = 'none';
      break;
    case 'docs':
      commitType = 'docs';
      bump = 'none';
      break;
    case 'refactor':
      commitType = 'refactor';
      bump = 'none';
      break;
    case 'test':
      commitType = 'test';
      bump = 'none';
      break;
    case 'style':
      commitType = 'style';
      bump = 'none';
      break;
    case 'ci':
      commitType = 'ci';
      bump = 'none';
      break;
    case 'build':
      commitType = 'build';
      bump = 'none';
      break;
    case 'revert':
      commitType = 'revert';
      bump = 'patch';
      break;
    default:
      commitType = 'unknown';
      bump = 'none';
  }

  return { type: commitType, bump, scope };
}

/**
 * Calculate suggested version bump based on commits
 */
function calculateSuggestedBump(commits: GitCommit[]): 'major' | 'minor' | 'patch' | 'none' {
  if (commits.length === 0) {return 'none';}

  // Priority: major > minor > patch > none
  let hasMajor = false;
  let hasMinor = false;
  let hasPatch = false;

  for (const commit of commits) {
    if (commit.bump === 'major') {hasMajor = true;}
    if (commit.bump === 'minor') {hasMinor = true;}
    if (commit.bump === 'patch') {hasPatch = true;}
  }

  if (hasMajor) {return 'major';}
  if (hasMinor) {return 'minor';}
  if (hasPatch) {return 'patch';}
  return 'none';
}

/**
 * Bump semver version
 */
function bumpVersion(version: string, bump: 'major' | 'minor' | 'patch'): string {
  const parts = version.split('.').map((v) => parseInt(v, 10));
  const [major = 0, minor = 0, patch = 0] = parts;

  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      return version;
  }
}

