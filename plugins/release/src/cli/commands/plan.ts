/**
 * Release plan command
 */

import {
  defineCommand,
  type CLIInput,
  type CommandResult,
  type PluginCommandContextV3,
  useLoader,
  displayArtifacts,
  type ArtifactInfo,
  useConfig,
} from '@kb-labs/sdk';
import { planRelease, type VersionBump, type ReleaseConfig, type ReleaseChannel } from '../../core/index.js';
import { findRepoRoot, scopeToDir } from '../../shared/utils';

interface PlanFlags {
  scope?: string;
  flow?: string;
  bump?: 'patch' | 'minor' | 'major' | 'auto';
  strict?: boolean;
  channel?: ReleaseChannel;
  json?: boolean;
}

type ReleasePlanResult = CommandResult<unknown>;

// ── helpers ────────────────────────────────────────────────────────────────

function formatVersionInfo(pkg: { currentVersion?: string; nextVersion?: string }): string {
  if (pkg.currentVersion && pkg.nextVersion) { return `${pkg.currentVersion} → ${pkg.nextVersion}`; }
  return pkg.nextVersion || 'new';
}

function buildPlanSections(
  plan: { strategy: string; registry: string; packages: Array<{ name: string; currentVersion?: string; nextVersion?: string }> },
  artifacts: ArtifactInfo[],
  symbols: { success: string },
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];

  sections.push({
    header: 'Summary',
    items: [
      `Strategy: ${plan.strategy}`,
      `Registry: ${plan.registry}`,
      `Packages: ${plan.packages.length}`,
    ],
  });

  if (plan.packages.length > 0) {
    sections.push({
      header: 'Packages to release',
      items: plan.packages.map(pkg => `${symbols.success} ${pkg.name}: ${formatVersionInfo(pkg)}`),
    });
  } else {
    sections.push({ items: ['No packages to release'] });
  }

  if (artifacts.length > 0) {
    sections.push({
      header: 'Artifacts',
      items: displayArtifacts(artifacts, { showSize: true, showTime: true, showDescription: true, maxItems: 10, title: '' }),
    });
  }

  return sections;
}

// ── command ────────────────────────────────────────────────────────────────

export default defineCommand({
  id: 'release:plan',
  description: 'Analyze changes and prepare release plan',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<PlanFlags>): Promise<ReleasePlanResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const configLoader = useLoader('Loading release configuration...');
      configLoader.start();

      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = {
        ...fileConfig,
        ...(flags.bump && { bump: flags.bump }),
        ...(flags.strict !== undefined && { strict: flags.strict }),
        ...(flags.channel && { channel: flags.channel }),
      };
      configLoader.succeed('Configuration loaded');

      const planLoader = useLoader('Discovering packages and planning release...');
      planLoader.start();

      const plan = await planRelease({
        cwd: repoRoot,
        config,
        scope: flags.scope,
        flow: flags.flow,
        bumpOverride: flags.bump as VersionBump | undefined,
        channel: config.channel,
      });

      if (plan.packages.length === 0) {
        planLoader.fail(`No packages found matching scope: ${flags.scope || 'all'}`);
      } else {
        planLoader.succeed(`Found ${plan.packages.length} package(s) to release`);
      }

      const scopeDir = scopeToDir(flags.scope ?? 'root');
      const planDir = ctx.runtime.fs.join(repoRoot, '.kb', 'release', 'plans', scopeDir, 'current');
      const planPath = ctx.runtime.fs.join(planDir, 'plan.json');
      const artifacts: ArtifactInfo[] = [];

      // Always persist: later steps (`release:version`, `release:git`) consume
      // this artifact as the single source of truth for the run, so it must
      // exist regardless of how this invocation chose to render itself.
      await ctx.runtime.fs.mkdir(planDir, { recursive: true });
      await ctx.runtime.fs.writeFile(planPath, JSON.stringify(plan, null, 2), { encoding: 'utf-8' });

      if (!flags.json) {
        const stats = await ctx.runtime.fs.stat(planPath);
        artifacts.push({
          name: 'Release Plan',
          path: planPath,
          size: stats.size,
          modified: new Date(stats.mtime),
          description: 'Detailed release plan (JSON)',
        });
      }

      ctx.platform?.logger?.info?.('Release plan completed', {
        packagesCount: plan.packages.length,
        strategy: plan.strategy,
        registry: plan.registry,
      });

      const firstPkg = plan.packages[0];

      if (flags.json) {
        return plan;
      } else {
        ctx.ui?.sideBox?.({
          title: 'Release Plan',
          sections: buildPlanSections(plan, artifacts, ctx.ui.symbols),
          status: 'success',
        });
      }

      return { plan };
    },
  },
});
