import { defineHandler, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import {
  COMMIT_CACHE_PREFIX,
  type ResetResponse,
} from '../../contracts/index.js';
import { clearPlan } from '../../core/storage/index.js';

/**
 * DELETE /plan handler
 *
 * Deletes the current commit plan.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ scope?: string }, unknown>): Promise<ResetResponse> {
    const scope = input.query?.scope || 'root';

    try {
      await clearPlan(ctx.cwd, scope);
      const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
      await ctx.platform.cache.delete(appliedCacheKey);

      return {
        success: true,
        message: 'Commit plan deleted successfully',
        scope,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
