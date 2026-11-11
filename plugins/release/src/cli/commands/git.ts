/**
 * Release git command — commit, tag, and push release changes.
 * Atomic step: reads plan, runs git ops, emits output marker for workflow.
 */

import { defineCommand, type CLIInput, type CommandResult, type PluginCommandContextV3, useLoader, useConfig } from '@kb-labs/sdk';
import {
  planRelease,
  commitAndTagRelease,
  resolveScopePath,
  type ReleaseConfig,
  type ReleaseChannel,
  type VersionBump,
} from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';
import { resolvePlan } from '../../shared/resolve-plan';

interface GitFlags {
  scope?: string;
  flow?: string;
  bump?: 'patch' | 'minor' | 'major' | 'auto';
  channel?: ReleaseChannel;
  'dry-run'?: boolean;
  'no-verify'?: boolean;
  json?: boolean;
}

type ReleaseGitResult = CommandResult<unknown>;

function buildGitSections(
  result: { committed: boolean; tagged: string[]; pushed: boolean },
  dryRun: boolean,
  symbols: { success: string; warning: string },
): Array<{ header?: string; items: string[] }> {
  if (dryRun) {
    return [{ items: [`${symbols.warning} Dry-run: no git operations performed`] }];
  }

  return [
    {
      header: 'Git Operations',
      items: [
        `${result.committed ? symbols.success : symbols.warning} Commit: ${result.committed ? 'created' : 'skipped'}`,
        `${result.tagged.length > 0 ? symbols.success : symbols.warning} Tags: ${result.tagged.length > 0 ? result.tagged.join(', ') : 'none'}`,
        `${result.pushed ? symbols.success : symbols.warning} Push: ${result.pushed ? 'done' : 'skipped'}`,
      ],
    },
  ];
}

export default defineCommand({
  id: 'release:git',
  description: 'Commit, tag, and push release changes',

  handler: {
    async intent(ctx: PluginCommandContextV3, input: CLIInput<GitFlags>) {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);
      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = {
        ...fileConfig,
        ...(flags.bump && { bump: flags.bump }),
        ...(flags.channel && { channel: flags.channel }),
      };

      const plan = await planRelease({
        cwd: repoRoot,
        config,
        scope: flags.scope,
        flow: flags.flow,
        bumpOverride: flags.bump as VersionBump | undefined,
        channel: config.channel,
      });

      return {
        summary: `Commit, tag, and push release for ${plan.packages.length} package(s)`,
        operations: [
          { type: 'create' as const, resource: 'git-commit', details: { packages: plan.packages.length } },
          ...plan.packages.map(p => ({
            type: 'create' as const,
            resource: 'git-tag',
            details: { tag: `${p.name}@${p.nextVersion ?? 'unknown'}` },
          })),
          { type: 'create' as const, resource: 'git-push', details: { scope: flags.scope ?? 'root' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<GitFlags>): Promise<ReleaseGitResult> {
      const { flags } = input;
      const noVerify = flags['no-verify'] ?? false;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = {
        ...fileConfig,
        ...(flags.bump && { bump: flags.bump }),
        ...(flags.channel && { channel: flags.channel }),
      };

      const planLoader = useLoader('Loading release plan...');
      planLoader.start();
      // Must be the same plan `release:version` acted on — re-deriving it here
      // sees the versions that step just wrote as the new baseline and bumps a
      // second time, so the tag/commit message land one version ahead of the
      // package.json files being committed.
      //
      // `channel` must be threaded through for the same reason as in
      // version.ts: a resolvePlan() fallback to a fresh planRelease() call
      // silently defaults to 'stable' (dropping any -canary.<sha> suffix)
      // unless the caller's own channel is passed along explicitly.
      const { plan, source, reason } = await resolvePlan({
        repoRoot,
        config,
        scope: flags.scope,
        flow: flags.flow,
        bumpOverride: flags.bump as VersionBump | undefined,
        channel: config.channel,
        stage: 'post-bump',
      });
      ctx.platform?.logger?.debug?.('Release plan resolved', { source, reason });
      planLoader.succeed(
        `${source === 'artifact' ? 'Loaded plan' : 'Recomputed plan'}: ${plan.packages.length} package(s)`,
      );

      if (plan.packages.length === 0) {
        const msg = `No packages found${flags.scope ? ` matching scope: ${flags.scope}` : ''}`;
        if (flags.json) { return { committed: false, tagged: [], pushed: false, message: msg }; }
        else { ctx.ui?.write?.(msg); }
        return { committed: false, tagged: [], pushed: false };
      }

      const scopePath = await resolveScopePath(repoRoot, flags.scope ?? 'root');

      const gitLoader = useLoader('Committing, tagging, pushing...');
      gitLoader.start();

      const result = await commitAndTagRelease({
        cwd: scopePath,
        plan,
        dryRun: false,
        noVerify,
        // Without repoRoot the consolidated root changelog is never staged
        // (see the `root === repoRoot` branch in publisher.ts) — it stays
        // dirty in the working tree after every release.
        repoRoot,
        changelogOutputPath: config.changelog?.outputPath,
        flowName: flags.flow,
        tagPattern: flags.flow ? config.flows?.[flags.flow]?.tagPattern : undefined,
      });

      if (result.pushed) {
        gitLoader.succeed(`Committed, tagged (${result.tagged.length}), pushed`);
      } else {
        gitLoader.succeed(`Committed, tagged (${result.tagged.length})`);
      }

      if (flags.json) {
        return result;
      }

      ctx.ui?.sideBox?.({
        title: 'Git Operations',
        sections: buildGitSections(result, false, ctx.ui.symbols),
        status: 'success',
      });

      return result;
    },
  },
});
