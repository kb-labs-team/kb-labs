/**
 * Run release handler — thin adapter over core runReleasePipeline().
 */

import { defineHandler, findRepoRoot, type RestInput, useConfig, useLLM, rethrowForRest } from '@kb-labs/sdk';
import type {
  RunReleaseRequest,
  RunReleaseResponse,
} from '../../contracts/index.js';
import {
  runReleasePipeline,
  resolveScopePath,
  resolvePublishTag,
  resolvePublishRegistry,
  type ReleaseConfig,
  type ReleaseChannel,
  type PublishablePackage,
  type PublishResult,
} from '../../core/index.js';
import { publishPackagesProgrammatic } from '../../shared/publish-programmatic';
import { createChangelogGenerator } from '../../shared/changelog-factory';

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, RunReleaseRequest>): Promise<RunReleaseResponse> {
    try {
    const scope = input.body?.scope || 'root';
    const flow = input.body?.flow;
    const dryRun = input.body?.dryRun ?? false;
    const skipChecks = input.body?.skipChecks ?? false;
    const otp = input.body?.otp;
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);
    const scopeCwd = await resolveScopePath(repoRoot, scope);

    const baseConfig = await useConfig<ReleaseConfig>() ?? {};
    const channel: ReleaseChannel = input.body?.channel ?? baseConfig.channel ?? 'stable';
    const config: ReleaseConfig = { ...baseConfig, channel };

    // Changelog generator (with LLM if available)
    const llm = useLLM();
    const changelog = createChangelogGenerator(config, llm ?? undefined);

    // Programmatic publisher (token-based, no interactive OTP)
    const publisher = {
      async publish(packages: PublishablePackage[], opts: { dryRun?: boolean; access?: string; tag?: string; registry?: string }): Promise<PublishResult> {
        return publishPackagesProgrammatic({
          packages,
          packageManager: config.workspace?.type ?? config.publish?.packageManager ?? 'pnpm',
          dryRun: opts.dryRun,
          access: (opts.access as 'public' | 'restricted') ?? 'public',
          tag: opts.tag ?? resolvePublishTag(config, channel),
          registry: opts.registry ?? resolvePublishRegistry(config, channel),
          otp,
        });
      },
    };

    const result = await runReleasePipeline({
      cwd,
      repoRoot,
      scopeCwd,
      scope,
      flow,
      config,
      dryRun,
      skipChecks,
      checks: (flow ? config.flows?.[flow]?.checks : undefined)
           ?? config.scopes?.[scope]?.checks
           ?? config.checks ?? [],
      publisher,
      changelog,
      shell: ctx.api.shell,
      logger: ctx.platform?.logger,
    });

    // Track analytics
    await ctx.platform?.analytics?.track?.(result.success ? 'release.completed' : 'release.failed', {
      scope,
      packagesCount: result.plan.packages.length,
      publishedCount: result.report.result.published?.length ?? 0,
      dryRun,
      durationMs: result.report.result.timingMs,
    });

    return {
      scope,
      report: result.report as unknown as RunReleaseResponse['report'],
      success: result.success,
      errors: result.report.result.errors,
    };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
