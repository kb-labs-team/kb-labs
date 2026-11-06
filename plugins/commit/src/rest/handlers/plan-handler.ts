import { defineHandler, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import { loadPlan } from '../../core/storage/index.js';
import type { PlanResponse } from '../../contracts/index.js';

/**
 * GET /plan handler
 *
 * Returns the current commit plan for Studio.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ scope?: string }, unknown>): Promise<PlanResponse> {
    const scope = input.query?.scope || 'root';

    try {
      const plan = await loadPlan(ctx.cwd, scope);

      if (!plan || plan.commits.length === 0) {
        return {
          hasPlan: false,
          scope,
        };
      }

      return {
        hasPlan: true,
        plan,
        scope,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
