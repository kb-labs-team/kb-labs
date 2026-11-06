/**
 * quality:check-builds - Check build status across monorepo
 *
 * Analyzes build status including:
 * - Build failures with error messages
 * - Stale builds (dist/ older than src/)
 * - Build duration tracking
 */

import { defineCommand, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import type { BuildCheckResult } from '../../contracts/index.js';
import { CACHE_KEYS } from '../../contracts/index.js';
import { checkBuilds } from '../../core/builds/index.js';
import type { CheckBuildsFlags } from './flags.js';

// Input type with backward compatibility
type CheckBuildsInput = CheckBuildsFlags & { argv?: string[] };

export default defineCommand({
  id: 'quality:check-builds',
  description: 'Check build status across monorepo',

  handler: {
    async execute(
      ctx: PluginCommandContextV3,
      input: CheckBuildsInput
    ): Promise<CommandResult<BuildCheckResult>> {
      const { ui, platform } = ctx;

      // V3: Flags may come wrapped in input.flags or passed directly
      const flags = ('flags' in input && typeof (input as { flags?: unknown }).flags === 'object' && (input as { flags?: unknown }).flags !== null)
        ? (input as { flags: CheckBuildsInput }).flags
        : input;

      // Check cache unless refresh requested
      const cacheKey = `${CACHE_KEYS.BUILDS}:${flags.package || 'all'}`;

      if (!flags.refresh) {
        const cached = await platform.cache.get<BuildCheckResult>(cacheKey);
        if (cached) {
          outputBuildCheck({ ...cached, cached: true }, flags, ui);
          return cached.failing > 0
            ? { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Build failures found', hint: 'Review the failed package builds, then rerun `kb quality check-builds`.', diagnostics: cached.failures.map((failure) => ({ code: 'KB_QUALITY_BUILD_FAILED', severity: 'error', path: failure.package, message: failure.error })) } }
            : cached;
        }
      }

      // Run build check
      const result = await checkBuilds(ctx.cwd, {
        packageFilter: flags.package,
        timeout: flags.timeout ? Number(flags.timeout) : 30000,
      });

      // Cache results for 10 minutes
      await platform.cache.set(cacheKey, result, 10 * 60 * 1000);

      // Track analytics
      await platform.analytics.track('quality:check-builds', {
        totalPackages: result.totalPackages,
        passing: result.passing,
        failing: result.failing,
        staleBuilds: result.staleBuilds.length,
        duration: result.duration,
        packageSpecific: !!flags.package,
      });

      // Output results
      outputBuildCheck({ ...result, cached: false }, flags, ui);

      return result.failing > 0
        ? { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Build failures found', hint: 'Review the failed package builds, then rerun `kb quality check-builds`.', diagnostics: result.failures.map((failure) => ({ code: 'KB_QUALITY_BUILD_FAILED', severity: 'error', path: failure.package, message: failure.error })) } }
        : result;
    },
  },
});

/**
 * Output build check results
 */
function outputBuildCheck(
  result: BuildCheckResult & { cached?: boolean },
  flags: Record<string, unknown>,
  ui: PluginCommandContextV3['ui']
) {
  if (flags.json) {
    return;
  }

  // Build sections
  const sections: Array<{ header: string; items: string[] }> = [];

  // Status section
  const statusIcon = result.failing === 0 ? '✅' : '❌';
  const statusText = result.failing === 0 ? 'All builds passing' : 'Build failures detected';
  const statusItems = [
    `${statusIcon} ${statusText}`,
    `Passing: ${result.passing} package(s)`,
    result.failing > 0 ? `Failing: ${result.failing} package(s)` : null,
  ].filter(Boolean) as string[];

  sections.push({ header: 'Build Status', items: statusItems });

  // Failed packages
  if (result.failures.length > 0) {
    const failureItems: string[] = [];
    for (const failure of result.failures.slice(0, 5)) {
      failureItems.push(`• ${failure.package}`);
      // Show first line of error
      const firstLine = failure.error.split('\n')[0];
      failureItems.push(`  ${firstLine?.substring(0, 80) || 'Build failed'}`);
    }

    if (result.failures.length > 5) {
      failureItems.push(`... and ${result.failures.length - 5} more failures`);
    }

    sections.push({ header: '❌ Failed Packages', items: failureItems });
  }

  // Stale builds
  if (result.staleBuilds.length > 0) {
    const staleItems = result.staleBuilds.slice(0, 5).map((s) => `• ${s.package}`);

    if (result.staleBuilds.length > 5) {
      staleItems.push(`... and ${result.staleBuilds.length - 5} more`);
    }

    sections.push({
      header: '⚠️  Stale Builds (dist/ older than src/)',
      items: staleItems,
    });
  }

  // Summary
  const summaryItems = [
    `Total packages: ${result.totalPackages}`,
    `Duration: ${(result.duration / 1000).toFixed(1)}s`,
    result.cached ? '💾 Cached (use --refresh to recheck)' : '🔄 Fresh check',
  ];

  sections.push({ header: 'Summary', items: summaryItems });

  const title =
    result.failing === 0
      ? '✅ All Builds Passing'
      : `❌ ${result.failing} Build Failure(s) Detected`;

  ui?.success?.('Build check completed', {
    title,
    sections,
  });
}
