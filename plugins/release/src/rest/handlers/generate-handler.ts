/**
 * Generate release plan handler - Analyze changes and create release plan
 *
 * Writes: .kb/release/plans/{scope}/current/plan.json
 */

import { defineHandler, findRepoRoot, type RestInput, type PluginContextV3, useConfig, rethrowForRest } from '@kb-labs/sdk';
import type {
  GeneratePlanRequest,
  GeneratePlanResponse,
  ReleasePlan,
  PackageVersion,
} from '../../contracts/index.js';
import { RELEASE_CACHE_PREFIX } from '../../contracts/index.js';
import { planRelease, type ReleaseConfig, type VersionBump } from '../../core/index.js';
import { scopeToDir } from '../../shared/utils';

export default defineHandler({
  async execute(ctx, input: RestInput<unknown, GeneratePlanRequest>): Promise<GeneratePlanResponse> {
    try {
    const scope = input.body?.scope || 'root';
    const bump = input.body?.bump || 'auto';
    const useLLM = input.body?.useLLM ?? true;
    const cwd = ctx.cwd ?? process.cwd();
    const repoRoot = await findRepoRoot(cwd);

    ctx.platform?.logger?.info?.('Generating release plan', { scope, bump, useLLM });

    // Read versioningStrategy from kb.config.json release section
    const releaseConfig = await useConfig<ReleaseConfig>();

    // Create config for core planner
    const config: ReleaseConfig = {
      bump: bump as VersionBump,
      strategy: 'semver',
      registry: 'https://registry.npmjs.org',
      rollback: { enabled: true },
      versioningStrategy: releaseConfig?.versioningStrategy,
      packages: releaseConfig?.packages,
      scopes: releaseConfig?.scopes,
      publish: releaseConfig?.publish,
    };

    // Use core planner to discover packages and compute versions.
    // Always discover from repoRoot; scope is a filter applied inside planner.
    const corePlan = await planRelease({
      cwd: repoRoot,
      config,
      scope: scope !== 'root' ? scope : undefined,
      bumpOverride: bump as VersionBump | undefined,
    });

    let tokensUsed = 0;
    const confidences: number[] = [];

    // If LLM is enabled, enhance each package with AI reasoning
    const enhancedPackages: PackageVersion[] = [];

    for (const pkg of corePlan.packages) {
      let reason = 'Based on ' + pkg.bump + ' bump';
      let pkgConfidence = 0.7;

      if (useLLM && ctx.platform?.llm) {
        // Get git commits for this package to provide context to LLM
        const gitAnalysis = await analyzeGitCommits(ctx, pkg.path);

        if (gitAnalysis.commits.length > 0) {
          const llmResult = await analyzePlanWithLLM(ctx, {
            packageName: pkg.name,
            currentVersion: pkg.currentVersion || '0.0.0',
            nextVersion: pkg.nextVersion || '0.0.1',
            commits: gitAnalysis.commits,
            detectedBump: pkg.bump,
          });

          reason = llmResult.reason;
          pkgConfidence = llmResult.confidence;
          tokensUsed += llmResult.tokensUsed;
        } else {
          reason = 'No unreleased commits detected';
          pkgConfidence = 0.9;
        }
      }

      enhancedPackages.push({
        ...pkg,
        reason,
      });

      // Collect confidence scores for averaging
      if (pkgConfidence > 0) {
        confidences.push(pkgConfidence);
      }
    }

    // Calculate average confidence across all packages
    const confidence = confidences.length > 0
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0;

    const plan: ReleasePlan = {
      schemaVersion: '1.0',
      scope,
      packages: enhancedPackages,
      strategy: corePlan.strategy,
      registry: corePlan.registry,
      rollbackEnabled: corePlan.rollbackEnabled,
      channel: corePlan.channel,
      createdAt: new Date().toISOString(),
    };

    // Ensure directory exists
    const scopeDir = scopeToDir(scope);
    const planDir = repoRoot + '/.kb/release/plans/' + scopeDir + '/current';
    await ctx.runtime.fs.mkdir(planDir, { recursive: true });

    // Write plan
    const planPath = planDir + '/plan.json';
    await ctx.runtime.fs.writeFile(planPath, JSON.stringify(plan, null, 2), { encoding: 'utf-8' });

    // Invalidate cache
    const cacheKey = RELEASE_CACHE_PREFIX + 'plan:' + scope;
    await ctx.platform?.cache?.delete(cacheKey);

    // Track analytics
    await ctx.platform?.analytics?.track?.('release.plan.generated', {
      scope,
      packagesCount: plan.packages.length,
      bump,
      strategy: plan.strategy,
      useLLM,
      tokensUsed,
      confidence,
    });

    ctx.platform?.logger?.info?.('Release plan generated', {
      scope,
      packagesCount: plan.packages.length,
      useLLM,
      tokensUsed,
      confidence,
    });

    return {
      plan,
      planPath: '.kb/release/plans/' + scopeDir + '/current/plan.json',
      scope,
      tokensUsed,
      confidence,
    };
    } catch (err) {
      rethrowForRest(err);
    }
  }
});

/**
 * Analyze git commits to get context for package
 */
async function analyzeGitCommits(ctx: PluginContextV3, pkgPath: string): Promise<{
  commits: Array<{ type: string; message: string; sha: string }>;
}> {
  try {
    ctx.platform?.logger?.info?.('Starting git analysis', { pkgPath });

    // Get last git tag
    const lastTagResult = await ctx.api.shell.exec(
      'git',
      ['describe', '--tags', '--abbrev=0'],
      { cwd: pkgPath }
    );
    const lastTag = lastTagResult.code === 0 ? lastTagResult.stdout.trim() : undefined;

    ctx.platform?.logger?.info?.('Got last tag', { lastTag, code: lastTagResult.code });

    // Get commits since last tag
    const gitLogArgs = lastTag
      ? ['log', lastTag + '..HEAD', '--pretty=format:%H|%s', '--max-count=20']
      : ['log', '--pretty=format:%H|%s', '--max-count=20'];

    ctx.platform?.logger?.info?.('Executing git log', { args: gitLogArgs });

    const logResult = await ctx.api.shell.exec('git', gitLogArgs, { cwd: pkgPath });

  ctx.platform?.logger?.info?.('Git log result', {
    code: logResult.code,
    stdout: logResult.stdout?.substring(0, 200),
    stderr: logResult.stderr?.substring(0, 200),
    args: gitLogArgs,
    cwd: pkgPath,
  });

    const commits: Array<{ type: string; message: string; sha: string }> = [];
    if (logResult.code === 0 && logResult.stdout) {
      const lines = logResult.stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const parts = line.split('|');
        const sha = parts[0];
        const message = parts[1];
        if (!sha || !message) {continue;}

        const parsed = parseConventionalCommit(message);
        commits.push({
          sha: sha.substring(0, 7),
          message,
          type: parsed.type,
        });
      }
    }

    return { commits };
  } catch (error) {
    ctx.platform?.logger?.error?.('Git analysis failed', error instanceof Error ? error : undefined);
    return { commits: [] };
  }
}

/**
 * Parse conventional commit message
 */
function parseConventionalCommit(message: string): { type: string } {
  if (message.includes('BREAKING CHANGE') || message.includes('!:')) {
    return { type: 'BREAKING' };
  }

  const match = message.match(/^(\w+)(?:\([^)]+\))?!?:\s*(.+)/);
  if (!match) {
    return { type: 'unknown' };
  }

  const type = match[1];
  if (!type) {return { type: 'unknown' };}

  return { type: type.toLowerCase() };
}

/**
 * Analyze plan using LLM to provide reasoning for version bump
 */
async function analyzePlanWithLLM(
  ctx: PluginContextV3,
  input: {
    packageName: string;
    currentVersion: string;
    nextVersion: string;
    commits: Array<{ type: string; message: string; sha: string }>;
    detectedBump: string;
  }
): Promise<{ reason: string; tokensUsed: number; confidence: number }> {
  const { packageName, currentVersion, nextVersion, commits, detectedBump } = input;

  // Build commit list
  const commitList = commits.length > 0
    ? commits.slice(0, 10).map(c => '- [' + c.sha + '] ' + c.type + ': ' + c.message).join('\n')
    : '(No unreleased commits)';

  const prompt = 'You are analyzing a release plan for a package to provide clear reasoning for the version bump.\n\nPackage: ' + packageName + '\nCurrent version: ' + currentVersion + '\nNext version: ' + nextVersion + '\nDetected bump: ' + detectedBump + '\n\nRecent commits:\n' + commitList + '\n\nYour task:\nProvide a clear, concise reason (1-2 sentences) explaining WHY this version bump is appropriate based on the commits.\n\nFocus on:\n- What changed (new features, bug fixes, breaking changes)\n- Why it requires this specific bump type\n\nRespond ONLY with valid JSON in this format:\n{\n  "reason": "Brief explanation (1-2 sentences focusing on what changed)",\n  "confidence": 0.0-1.0\n}';

  try {
    const response = await ctx.platform!.llm!.complete(prompt, {
      maxTokens: 200,
      temperature: 0.3,
    });

    const parsed = JSON.parse(response.content);

    return {
      reason: parsed.reason || detectedBump + ' bump based on commit analysis',
      tokensUsed: response.usage.completionTokens + response.usage.promptTokens,
      confidence: parsed.confidence || 0.7,
    };
  } catch (error) {
    ctx.platform?.logger?.error?.(
      'LLM reasoning failed, using simple explanation',
      error instanceof Error ? error : undefined
    );

    // Fallback to simple explanation
    const typeCount: Record<string, number> = {};
    commits.forEach(c => {
      typeCount[c.type] = (typeCount[c.type] || 0) + 1;
    });

    const summary = Object.entries(typeCount)
      .map(entry => entry[1] + ' ' + entry[0])
      .join(', ');

    return {
      reason: commits.length > 0
        ? 'Based on ' + commits.length + ' commit(s): ' + summary
        : 'No unreleased changes',
      tokensUsed: 0,
      confidence: 0.6,
    };
  }
}
