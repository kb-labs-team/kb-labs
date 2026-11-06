import { defineHandler, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import {
  COMMIT_CACHE_PREFIX,
  type PatchPlanRequest,
  type PatchPlanResponse,
  ConventionalTypeSchema,
} from '../../contracts/index.js';
import { loadPlan, savePlan } from '../../core/storage/index.js';

/**
 * PATCH /plan handler
 *
 * Edits a single commit's message, type, scope, or body in the stored plan
 * without triggering LLM regeneration.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, PatchPlanRequest>): Promise<PatchPlanResponse> {
    try {
      const { scope = 'root', commitId, message, type, scope_: commitScope, body } = input.body ?? {};

      if (!commitId) {
        throw new Error('commitId is required');
      }

      const plan = await loadPlan(ctx.cwd, scope);
      if (!plan) {
        throw new Error('No commit plan found. Generate a plan first.');
      }

      const commitIndex = plan.commits.findIndex(c => c.id === commitId);
      if (commitIndex === -1) {
        throw new Error(`Commit "${commitId}" not found in plan`);
      }

      const commit = plan.commits[commitIndex]!;

      if (message !== undefined) {
        commit.message = message;
      }
      if (type !== undefined) {
        const parsed = ConventionalTypeSchema.safeParse(type);
        if (parsed.success) {
          commit.type = parsed.data;
        }
      }
      if (commitScope !== undefined) {
        commit.scope = commitScope || undefined;
      }
      if (body !== undefined) {
        commit.body = body || undefined;
      }

      plan.commits[commitIndex] = commit;
      await savePlan(ctx.cwd, plan, scope);

      // Plan content changed => previously applied state is stale.
      const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
      await ctx.platform.cache.delete(appliedCacheKey);

      return {
        success: true,
        scope,
        commitId,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
