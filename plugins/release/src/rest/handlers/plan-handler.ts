/**
 * Plan handler - Get current release plan for a scope
 *
 * Reads: .kb/release/plans/{scope}/current/plan.json
 * Cache: 15s TTL to avoid repeated file reads
 */

import { defineHandler, findRepoRoot, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type { PlanResponse, ReleasePlan, PlanInput } from '../../contracts/index.js';
import { RELEASE_CACHE_PREFIX } from '../../contracts/index.js';
import { scopeToDir } from '../../shared/utils';

const CACHE_TTL_MS = 15000; // 15 seconds

export default defineHandler({
  async execute(ctx, input: RestInput<PlanInput>): Promise<PlanResponse> {
    try {
    const scope = input.query?.scope || 'root';
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    ctx.platform?.logger?.info?.('Plan handler called', { scope, query: input.query });

    const scopeDirName = scopeToDir(scope);
    const planPath = `${repoRoot}/.kb/release/plans/${scopeDirName}/current/plan.json`;
    const cacheKey = `${RELEASE_CACHE_PREFIX}plan:${scope}`;

    // Try cache first
    const cached = await ctx.platform?.cache?.get(cacheKey);
    if (cached !== undefined && cached !== null) {
      ctx.platform?.logger?.info?.('Returning cached plan response', {
        scope,
        hasPlan: (cached as PlanResponse).hasPlan,
        fromCache: true
      });
      return cached as PlanResponse;
    }

    // Cache miss - read from file
    let raw: string;
    try {
      raw = await ctx.runtime.fs.readFile(planPath, 'utf-8');
    } catch (error) {
      // No plan found for this scope
      ctx.platform?.logger?.info?.('No plan found for scope', {
        scope,
        planPath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      const response: PlanResponse = {
        hasPlan: false,
        scope,
      };
      // Cache negative result too (shorter TTL)
      await ctx.platform?.cache?.set(cacheKey, response, 5000); // 5s for "not found"
      return response;
    }

    try {
      const plan: ReleasePlan = JSON.parse(raw);
      const response: PlanResponse = {
        hasPlan: true,
        plan,
        scope,
      };

      ctx.platform?.logger?.info?.('Plan loaded successfully', { scope, hasPlan: true });

      // Cache successful result
      await ctx.platform?.cache?.set(cacheKey, response, CACHE_TTL_MS);
      return response;
    } catch (error) {
      ctx.platform?.logger?.error?.(
        'Failed to parse release plan',
        error instanceof Error ? error : undefined,
        { scope }
      );

      const response: PlanResponse = {
        hasPlan: false,
        scope,
      };
      return response;
    }
    } catch (err) {
      rethrowForRest(err);
    }
  }
});
