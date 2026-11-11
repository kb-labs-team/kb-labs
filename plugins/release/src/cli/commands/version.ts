/**
 * Release version command — bump versions in package.json files.
 * Atomic step: reads plan, updates package.json versions, emits output marker for workflow.
 */

import { defineCommand, type CLIInput, type CommandResult, type PluginCommandContextV3, useLoader, useConfig } from '@kb-labs/sdk';
import {
  planRelease,
  updatePackageVersions,
  type ReleaseConfig,
  type ReleaseChannel,
  type VersionBump,
} from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';
import { resolvePlan } from '../../shared/resolve-plan';

interface VersionFlags {
  scope?: string;
  flow?: string;
  bump?: 'patch' | 'minor' | 'major' | 'auto';
  channel?: ReleaseChannel;
  'dry-run'?: boolean;
  json?: boolean;
}

type ReleaseVersionResult = CommandResult<unknown>;

function buildVersionSections(
  updates: Array<{ package: string; from: string; to: string; updated: boolean }>,
  dryRun: boolean,
  symbols: { success: string; error: string },
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];

  if (dryRun) {
    sections.push({
      header: 'Would update (dry-run)',
      items: updates.map(u => `${symbols.success} ${u.package}: ${u.from} → ${u.to}`),
    });
    return sections;
  }

  const succeeded = updates.filter(u => u.updated);
  const failed = updates.filter(u => !u.updated);

  if (succeeded.length > 0) {
    sections.push({
      header: 'Updated',
      items: succeeded.map(u => `${symbols.success} ${u.package}: ${u.from} → ${u.to}`),
    });
  }

  if (failed.length > 0) {
    sections.push({
      header: 'Failed',
      items: failed.map(u => `${symbols.error} ${u.package}: ${u.from} → ${u.to}`),
    });
  }

  return sections;
}

export default defineCommand({
  id: 'release:version',
  description: 'Bump package.json versions according to release plan',

  handler: {
    async intent(ctx: PluginCommandContextV3, input: CLIInput<VersionFlags>) {
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
        summary: `Bump versions for ${plan.packages.length} package(s)`,
        operations: plan.packages.map(p => ({
          type: 'update' as const,
          resource: 'package-version',
          details: { package: p.name, from: p.currentVersion ?? 'unknown', to: p.nextVersion ?? 'unknown' },
        })),
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<VersionFlags>): Promise<ReleaseVersionResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = {
        ...fileConfig,
        ...(flags.bump && { bump: flags.bump }),
        ...(flags.channel && { channel: flags.channel }),
      };

      const planLoader = useLoader('Planning version bumps...');
      planLoader.start();
      // `flow` is mandatory here: without it planRelease() falls back to the
      // global package set, and a lockstep strategy then levels EVERY package
      // in the repo — including other flows' — onto this flow's version.
      //
      // `channel` must ALSO be threaded through explicitly (not left to
      // resolvePlan/planRelease's 'stable' default): a per-run artifact can be
      // stale relative to the working tree, so resolvePlan() correctly rejects
      // it and recomputes fresh via planRelease(). Without an explicit channel here,
      // that recompute silently defaults to 'stable' and drops the
      // -canary.<sha> suffix from EVERY package's nextVersion — not just one —
      // producing a plain version that only gets caught downstream if
      // something happens to compare that one package's sealed version
      // against the expected canary version (see prepare-release-index.mjs /
      // "Verify sealed platform version").
      const { plan, source, reason } = await resolvePlan({
        repoRoot,
        config,
        scope: flags.scope,
        flow: flags.flow,
        bumpOverride: flags.bump as VersionBump | undefined,
        channel: config.channel,
        stage: 'pre-bump',
      });
      ctx.platform?.logger?.debug?.('Release plan resolved', { source, reason });
      planLoader.succeed(
        `${source === 'artifact' ? 'Loaded' : 'Planned'} ${plan.packages.length} package(s)`,
      );

      if (plan.packages.length === 0) {
        const msg = `No packages found${flags.scope ? ` matching scope: ${flags.scope}` : ''}`;
        if (flags.json) { return { updated: 0, updates: [], message: msg }; }
        else { ctx.ui?.write?.(msg); }
        return { ok: true, updated: 0, updates: [] };
      }

      const versionLoader = useLoader(`Bumping ${plan.packages.length} package version(s)...`);
      versionLoader.start();

      const updates = await updatePackageVersions(plan);
      const updated = updates.filter(u => u.updated).length;
      const ok = updates.every(u => u.updated);

      if (ok) {
        versionLoader.succeed(`Bumped ${updated} package version(s)`);
      } else {
        versionLoader.fail(`${updates.filter(u => !u.updated).length} update(s) failed`);
      }

      const failedUpdates = updates.filter((update) => !update.updated);
      const outcome = ok
        ? { ok: true, updated, updates }
        : {
            ok: false as const,
            error: {
              code: 'KB_RUNTIME_COMMAND_FAILED',
              message: `Failed to update ${failedUpdates.length} package version(s).`,
              hint: 'Review the failed package updates, resolve the reported issues, then rerun `kb release version update`.',
              diagnostics: failedUpdates.map((update) => ({
                code: 'RELEASE_PACKAGE_VERSION_UPDATE_FAILED',
                severity: 'error' as const,
                path: update.package,
                message: `Could not update ${update.package} from ${update.from} to ${update.to}.`,
              })),
            },
          };

      if (flags.json) {
        return outcome;
      }

      ctx.ui?.sideBox?.({
        title: 'Version Bump',
        sections: buildVersionSections(updates, false, ctx.ui.symbols),
        status: ok ? 'success' : 'error',
      });

      return outcome;
    },
  },
});
