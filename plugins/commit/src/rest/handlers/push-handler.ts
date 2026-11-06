import { defineHandler, useConfig, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import {
  COMMIT_CACHE_PREFIX,
  type PushRequest,
  type PushResponse,
  type CommitPluginConfig,
  resolveCommitConfig,
} from '../../contracts/index.js';
import { pushCommits } from '../../core/applier/index.js';
import { loadPlan, saveToHistory, clearPlan } from '../../core/storage/index.js';
import { resolveScopePath } from './scope-resolver';

/**
 * POST /push handler
 *
 * Pushes commits to the remote repository.
 * After successful push, saves plan to history and clears current plan.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, PushRequest>): Promise<PushResponse> {
    const { scope = 'root', remote, force } = input.body ?? {};
    const startTime = Date.now();

    try {
      // Load the plan before pushing (we'll need it for history)
      const plan = await loadPlan(ctx.cwd, scope);

      // Resolve scope to actual directory path
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      // Push commits (git runs FROM scopeCwd)
      const result = await pushCommits(scopeCwd, { remote, force, scope });

      // After successful push, save to history and clear the plan
      if (result.success && plan) {
        // Save to history with push result
        await saveToHistory(ctx.cwd, plan, {
          success: true,
          appliedCommits: [],
          errors: []
        }, scope);

        // Clear current plan
        await clearPlan(ctx.cwd, scope);

        // Clear applied status cache
        const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
        await ctx.platform.cache.delete(appliedCacheKey);
      }

      // Track success/failure
      if (ctx.platform.analytics) {
        if (result.success) {
          await ctx.platform.analytics.track('commit.push.success', {
            scope,
            remote,
            force,
            commitsPushed: plan?.commits.length || 0,
            durationMs: Date.now() - startTime,
          });
        } else {
          await ctx.platform.analytics.track('commit.push.failed', {
            scope,
            remote,
            force,
            error: result.error,
            durationMs: Date.now() - startTime,
          });
        }
      }

      return {
        result,
        scope,
      };
    } catch (error) {
      // Track error
      if (ctx.platform.analytics) {
        await ctx.platform.analytics.track('commit.push.error', {
          scope,
          remote,
          force,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        });
      }

      rethrowForRest(error);
    }
  },
});
