/**
 * Reset release plan handler - Delete current release plan and changelog
 *
 * Deletes: .kb/release/plans/{scope}/current/
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { ResetPlanRequest, ResetPlanResponse } from '../../contracts/index.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeToDir } from '../../shared/utils';

export default defineHandler({
  async execute(ctx, input: RestInput<ResetPlanRequest, unknown>): Promise<ResetPlanResponse> {
    try {
    const scope = input.query?.scope || 'root';
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    const scopeDirName = scopeToDir(scope);
    const scopeDir = join(repoRoot, '.kb/release/plans', scopeDirName, 'current');

    try {
      // Remove entire current directory for this scope
      await rm(scopeDir, { recursive: true, force: true });

      return {
        success: true,
        scope,
        message: `Release plan for scope "${scope}" has been reset`,
      };
    } catch (error) {
      return {
        success: false,
        scope,
        message: `Failed to reset plan: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
    } catch (err) {
      rethrowForRest(err);
    }
  }
});
