import { defineHandler, useConfig, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import {
  COMMIT_CACHE_PREFIX,
  type ApplyRequest,
  type ApplyResponse,
  type CommitPluginConfig,
  resolveCommitConfig,
} from '../../contracts/index.js';
import { applyCommitPlan } from '../../core/applier/index.js';
import { loadPlan } from '../../core/storage/index.js';
import { resolveScopePath } from './scope-resolver';
import { relative, normalize } from 'node:path';

/**
 * POST /apply handler
 *
 * Applies the current commit plan by creating git commits.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, ApplyRequest>): Promise<ApplyResponse> {
    const { scope = 'root', force, commitIds } = input.body ?? {};
    const startTime = Date.now();

    try {
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});

      // Resolve scope to actual directory path (for nested git repos)
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      // Load the plan first (plan stored in root, but paths are relative to repoRoot)
      const plan = await loadPlan(ctx.cwd, scope);
      if (!plan) {
        throw new Error('No commit plan found. Generate a plan first with POST /generate');
      }

      // Transform file paths from repoRoot-relative to scopeCwd-relative
      // Plan files: "kb-labs-commit-plugin/packages/commit-cli/src/file.ts"
      // scopeCwd: "/absolute/path/kb-labs/kb-labs-commit-plugin"
      // ctx.cwd: "/absolute/path/kb-labs"
      // Need: "packages/commit-cli/src/file.ts"

      // Use path.relative() for proper cross-platform path handling
      const scopeRelative = normalize(relative(ctx.cwd, scopeCwd));

      // Helper to strip scope prefix from file path
      const stripScopePrefix = (filePath: string): string => {
        // Normalize path separators (handles Windows vs Unix)
        const normalizedPath = normalize(filePath);
        const normalizedPrefix = normalize(scopeRelative);

        // If file starts with scope prefix, strip it
        if (normalizedPath.startsWith(normalizedPrefix + '/') ||
            normalizedPath.startsWith(normalizedPrefix + '\\')) {
          return normalizedPath.slice(normalizedPrefix.length + 1);
        }

        // If exact match (shouldn't happen for files, but handle it)
        if (normalizedPath === normalizedPrefix) {
          return '';
        }

        // File doesn't start with prefix - return as-is (shouldn't happen)
        return filePath;
      };

      const transformedPlan = {
        ...plan,
        gitStatus: {
          staged: plan.gitStatus.staged.map(stripScopePrefix),
          unstaged: plan.gitStatus.unstaged.map(stripScopePrefix),
          untracked: plan.gitStatus.untracked.map(stripScopePrefix),
        },
        commits: plan.commits.map(commit => ({
          ...commit,
          files: commit.files.map(stripScopePrefix),
        })),
      };

      // Filter commits if specific commitIds requested (selective apply)
      if (commitIds && commitIds.length > 0) {
        const commitIdSet = new Set(commitIds);
        transformedPlan.commits = transformedPlan.commits.filter(c => commitIdSet.has(c.id));

        if (transformedPlan.commits.length === 0) {
          throw new Error('None of the specified commitIds found in plan');
        }

        // When selectively applying commits, align gitStatus to selected files only.
        // Otherwise plan integrity checks may rightfully fail on intentionally skipped commits.
        const selectedFiles = new Set(transformedPlan.commits.flatMap(c => c.files));
        transformedPlan.gitStatus = {
          staged: transformedPlan.gitStatus.staged.filter(f => selectedFiles.has(f)),
          unstaged: transformedPlan.gitStatus.unstaged.filter(f => selectedFiles.has(f)),
          untracked: transformedPlan.gitStatus.untracked.filter(f => selectedFiles.has(f)),
        };
      }

      // Apply commits (git runs FROM scopeCwd, not ctx.cwd!)
      // Reset applied status before attempt to avoid stale "Applied" badge after failed runs.
      const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
      await ctx.platform.cache.delete(appliedCacheKey);

      const result = await applyCommitPlan(scopeCwd, transformedPlan, { force, scope });

      // Store applied status in cache for status tracking
      if (result.success) {
        await ctx.platform.cache.set(
          appliedCacheKey,
          {
            commitsApplied: result.appliedCommits.length,
            planCreatedAt: plan.createdAt,
          },
          60 * 60 * 1000 // 1 hour TTL
        );
      }

      // Track success/failure
      if (ctx.platform.analytics) {
        if (result.success) {
          await ctx.platform.analytics.track('commit.apply.success', {
            scope,
            force,
            commitsApplied: result.appliedCommits.length,
            durationMs: Date.now() - startTime,
          });
        } else {
          await ctx.platform.analytics.track('commit.apply.failed', {
            scope,
            force,
            commitsApplied: result.appliedCommits.length,
            errors: result.errors,
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
        await ctx.platform.analytics.track('commit.apply.error', {
          scope,
          force,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        });
      }

      rethrowForRest(error);
    }
  },
});
