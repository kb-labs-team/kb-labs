/**
 * Changelog handler - Get changelog for a scope
 *
 * Reads: .kb/release/plans/{scope}/current/changelog.md
 * Cache: 15s TTL to avoid repeated file reads
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { ChangelogResponse, ChangelogInput } from '../../contracts/index.js';
import { RELEASE_CACHE_PREFIX } from '../../contracts/index.js';
import { scopeToDir } from '../../shared/utils';

const CACHE_TTL_MS = 15000; // 15 seconds

export default defineHandler({
  async execute(ctx, input: RestInput<ChangelogInput>): Promise<ChangelogResponse> {
    try {
      const scope = input.query?.scope || 'root';
      const cwd = ctx.cwd ?? process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const scopeDirName = scopeToDir(scope);
      const changelogPath = `${repoRoot}/.kb/release/plans/${scopeDirName}/current/changelog.md`;
      const cacheKey = `${RELEASE_CACHE_PREFIX}changelog:${scope}`;

      // Try cache first
      const cached = await ctx.platform?.cache?.get(cacheKey);
      if (cached !== undefined && cached !== null) {
        return {
          scope,
          markdown: cached as string,
          from: input.query?.from,
          to: input.query?.to,
        };
      }

      // Cache miss - read from file
      let markdown: string | undefined;
      try {
        markdown = await ctx.runtime.fs.readFile(changelogPath, 'utf-8');

        // Cache the result (only if file exists)
        if (markdown !== undefined) {
          await ctx.platform?.cache?.set(cacheKey, markdown, CACHE_TTL_MS);
        }
      } catch {
        // No changelog found - markdown will be undefined
      }

      return {
        scope,
        markdown,
        from: input.query?.from,
        to: input.query?.to,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  }
});
