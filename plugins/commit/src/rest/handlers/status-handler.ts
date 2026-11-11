import { defineHandler, useConfig, type RestInput, type PluginContextV3, rethrowForRest } from '@kb-labs/sdk';
import { loadPlan } from '../../core/storage/index.js';
import { getGitStatus, getCurrentBranch } from '../../core/analyzer/index.js';
import { checkPlanStaleness } from '../../core/validator/index.js';
import { COMMIT_CACHE_PREFIX, type StatusResponse, type PlanStatus, type CommitPluginConfig, resolveCommitConfig } from '../../contracts/index.js';
import { resolveScopePath } from './scope-resolver';

const STATUS_CACHE_TTL = 5000; // 5 seconds

/**
 * GET /status handler
 *
 * Returns current status for a scope according to StatusResponse contract.
 * Uses ctx.platform.cache for git status caching.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ scope?: string }>): Promise<StatusResponse> {
    const scope = input.query?.scope || 'root';

    ctx.platform.logger.info(`[status-handler] Fetching status for scope: ${scope}`);

    try {
      // Load current plan
      const plan = await loadPlan(ctx.cwd, scope);
      ctx.platform.logger.info(`[status-handler] Plan loaded: ${!!plan}`);

      // Resolve scope to actual directory path (same as files-handler) — needed
      // for git status, branch lookup, and disambiguating which checkout/worktree
      // this Studio instance is pointed at.
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      // Get git status (with platform cache)
      let filesChanged = 0;
      let gitStatus: { staged: string[]; unstaged: string[]; untracked: string[] } | null = null;
      const cacheKey = `${COMMIT_CACHE_PREFIX}git-status:${scope}`;
      ctx.platform.logger.info(`[status-handler] Cache key: ${cacheKey}`);

      // Try to get from cache
      const cached = await ctx.platform.cache.get(cacheKey);
      ctx.platform.logger.info(`[status-handler] Cache hit: ${!!cached}`);

      if (cached !== null && cached !== undefined) {
        // Use cached value
        const cachedData = cached as { count: number; status: { staged: string[]; unstaged: string[]; untracked: string[] } | null };
        filesChanged = cachedData.count;
        gitStatus = cachedData.status;
      } else {
        ctx.platform.logger.info(`[status-handler] Resolved scope CWD: ${scopeCwd}`);

        gitStatus = await getGitStatus(scopeCwd);
        ctx.platform.logger.info(`[status-handler] Git status fetched - staged: ${gitStatus.staged.length}, unstaged: ${gitStatus.unstaged.length}, untracked: ${gitStatus.untracked.length}`);

        filesChanged =
          gitStatus.staged.length +
          gitStatus.unstaged.length +
          gitStatus.untracked.length;

        ctx.platform.logger.info(`[status-handler] Total files changed: ${filesChanged}`);

        // Cache the result
        await ctx.platform.cache.set(
          cacheKey,
          { count: filesChanged, status: gitStatus },
          STATUS_CACHE_TTL
        );
      }

      // Determine plan status
      let planStatus: PlanStatus = 'idle';
      let commitsApplied = 0;

      if (plan) {
        // Check if commits were applied (stored in cache after apply)
        const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
        const appliedData = await ctx.platform.cache.get(appliedCacheKey);

        if (appliedData) {
          const applied = appliedData as { commitsApplied: number; planCreatedAt?: string };
          // Only trust applied marker if it belongs to the current plan version.
          if (!applied.planCreatedAt || applied.planCreatedAt === plan.createdAt) {
            commitsApplied = applied.commitsApplied;
            planStatus = 'applied';
          } else {
            await ctx.platform.cache.delete(appliedCacheKey);
            planStatus = 'ready';
          }
        } else {
          planStatus = 'ready';
        }
      }

      const branch = await getCurrentBranch(scopeCwd).catch(() => undefined);

      // Proactively surface plan staleness — the same check `applyCommitPlan`
      // runs as a last-second guard, but here it's informational so Studio/CLI/MCP
      // can warn the user before they even attempt Apply.
      let planStale: boolean | undefined;
      let planStaleReason: string | undefined;
      if (plan) {
        const staleness = await checkPlanStaleness(scopeCwd, plan, scope);
        planStale = staleness.isStale;
        planStaleReason = staleness.isStale ? staleness.reason : undefined;
      }

      return {
        scope,
        hasPlan: !!plan,
        planStatus,
        filesChanged,
        commitsInPlan: plan?.commits.length || 0,
        commitsApplied,
        planTimestamp: plan?.createdAt,
        gitStatus: gitStatus || undefined,
        branch,
        workingDir: ctx.cwd,
        planStale,
        planStaleReason,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
