/**
 * Git history range resolution with tag discovery and shallow clone detection
 */

import simpleGit from 'simple-git';
import type { GitRange } from './types';

/**
 * Resolve git range from various sources (tags, refs, dates)
 */
export async function resolveGitRange(options: {
  cwd: string;
  from?: string;
  to?: string;
  sinceTag?: string;
  /** Glob for tags produced by the active release flow, e.g. `platform-v*`. */
  tagGlob?: string;
  autoUnshallow?: boolean;
  requireSignedTags?: boolean;
}): Promise<GitRange> {
  const { cwd, from, to = 'HEAD', sinceTag, tagGlob, autoUnshallow, requireSignedTags } = options;
  
  const git = simpleGit(cwd);
  
  // Handle shallow clone detection
  if (sinceTag || from) {
    await ensureHistoryDepth(git, sinceTag || from || 'HEAD', 'HEAD', autoUnshallow);
  }
  
  // Resolve 'from' ref
  // For first release (no tags), use first commit instead of HEAD~1
  // An explicit boundary always wins over automatic tag discovery.
  const lastTag = sinceTag || from ? null : await findLastTag(git, requireSignedTags, tagGlob);
  const fromRef = sinceTag || from || lastTag || await findFirstCommit(git);
  const toRef = to;

  return { from: fromRef, to: toRef };
}

/**
 * Find first commit in repository history
 * Returns parent of first commit (non-existent) to include first commit in range
 */
async function findFirstCommit(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    // Get first commit hash using rev-list
    const result = await git.raw(['rev-list', '--max-parents=0', 'HEAD']);
    const firstCommit = result.trim();
    // Return parent notation to include first commit in git log range
    // first^ means "parent of first commit" which doesn't exist, so git log first^..HEAD includes first commit
    return `${firstCommit}^`;
  } catch (error) {
    // Fallback to HEAD~1 if we can't find first commit
    return 'HEAD~1';
  }
}

/**
 * Find last release tag
 */
export async function findLastTag(
  git: ReturnType<typeof simpleGit>,
  requireSigned?: boolean,
  tagGlob?: string,
): Promise<string | null> {
  try {
    // `git describe` finds the nearest tag reachable from HEAD. Unlike a
    // lexical sort of `git tag`, this neither crosses into another flow nor
    // picks an old tag merely because its name sorts later.
    const args = ['describe', '--tags', '--abbrev=0'];
    if (tagGlob) { args.push('--match', tagGlob); }
    args.push('HEAD');
    const recentTag = (await git.raw(args)).trim();

    if (!recentTag) { return null; }
    if (!requireSigned) { return recentTag; }

    const signed = await filterSignedTags(git, [recentTag]);
    return signed[0] ?? null;
  } catch (error) {
    // No tags or error, return null
    return null;
  }
}

/**
 * Find last tag for specific package
 */
export async function findPackageTag(
  git: ReturnType<typeof simpleGit>,
  packageName: string,
  requireSigned?: boolean
): Promise<string | null> {
  try {
    const tags = await git.tags();
    
    // Match package tag patterns: @scope/package@1.0.0 or @pkg@1.0.0
    const packageRegex = new RegExp(`@${packageName.replace('@', '')}@v?\\d+\\.\\d+\\.\\d+`);
    
    const packageTags = tags.all.filter(tag => packageRegex.test(tag));
    
    const candidateTags = requireSigned
      ? await filterSignedTags(git, packageTags)
      : packageTags;
    
    return candidateTags
      .sort()
      .reverse()[0] || null;
  } catch {
    return null;
  }
}

/**
 * Filter to only signed tags
 */
async function filterSignedTags(
  git: ReturnType<typeof simpleGit>,
  tags: string[]
): Promise<string[]> {
  const signed: string[] = [];
  
  for (const tag of tags) {
    try {
      // Check if tag is signed: git cat-file tag <tag> contains PGP signature
      const content = await git.raw(['cat-file', 'tag', tag]);
      if (content.includes('-----BEGIN PGP SIGNATURE-----')) {
        signed.push(tag);
      }
    } catch {
      // Invalid tag or not signed, skip
    }
  }
  
  return signed;
}

/**
 * Ensure we have full git history (detect and fix shallow clones)
 */
async function ensureHistoryDepth(
  git: ReturnType<typeof simpleGit>,
  from: string,
  to: string,
  autoUnshallow?: boolean
): Promise<void> {
  try {
    // Try to get commit count between from and to
    await git.raw(['rev-list', '--count', `${from}..${to}`]);
  } catch (error) {
    // Shallow clone detected - commits not available
    if (autoUnshallow) {
      console.log('⚠️  Shallow clone detected. Fetching full history...');
      try {
        await git.fetch(['--prune', '--unshallow', '--tags']);
      } catch (fetchError) {
        throw new Error(
          'Shallow clone detected. Full history fetch failed. ' +
          'Run manually: git fetch --unshallow --tags'
        );
      }
    } else {
      throw new Error(
        'Shallow clone detected. Use --auto-unshallow flag or run: ' +
        'git fetch --unshallow --tags'
      );
    }
  }
}

/**
 * Parse git URL to extract host/owner/repo
 */
export function parseGitUrl(url: string): {
  host: string;
  owner: string;
  repo: string;
} | null {
  // Match: https://github.com/owner/repo.git
  // Match: git@github.com:owner/repo.git
  const match = url.match(/(?:https:\/\/([^/]+)|git@([^:]+):)(?:.*?\/)?([^/]+)\/([^/]+)(?:\.git)?$/);
  
  if (!match) {return null;}
  
  const host = match[1] || match[2] || '';
  const owner = match[3] || '';
  const repo = match[4] || '';
  
  return { host, owner, repo };
}

