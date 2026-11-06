/**
 * Changelog save handler - Save edited changelog for a scope
 *
 * Writes to: .kb/release/plans/{scope}/current/changelog.md
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type {
  SaveChangelogRequest,
  SaveChangelogResponse,
} from '../../contracts/index.js';
import { mkdir } from 'node:fs/promises';
import { scopeToDir } from '../../shared/utils';

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, SaveChangelogRequest>): Promise<SaveChangelogResponse> {
    const scope = input.body?.scope || 'root';
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    const scopeDirName = scopeToDir(scope);
    const scopeDir = `${repoRoot}/.kb/release/plans/${scopeDirName}/current`;
    const changelogPath = `${scopeDir}/changelog.md`;

    try {
      // Ensure directory exists
      await mkdir(scopeDir, { recursive: true });

      // Write changelog
      await ctx.runtime.fs.writeFile(changelogPath, input.body?.markdown || '', { encoding: 'utf-8' });

      ctx.platform?.logger?.info?.('Changelog saved', { scope, path: changelogPath });

      return {
        success: true,
        scope,
        path: changelogPath,
      };
    } catch (error) {
      ctx.platform?.logger?.error?.(
        'Failed to save changelog',
        error instanceof Error ? error : undefined,
        { scope }
      );

      rethrowForRest(error);
    }
  },
});
