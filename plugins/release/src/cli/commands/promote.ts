/**
 * Standalone promote command — publishes already-released package versions
 * (currently on disk, already committed/tagged by a prior `release run
 * --channel stable`) to npm under the stable dist-tag.
 *
 * Deliberately does NOT call planRelease() — versions are already fixed by
 * the stable release that already ran (typically targeting Verdaccio, per
 * `config.registry`). Recomputing bumps from git history here would be
 * wrong: this command's whole job is "publish what's already released,
 * unchanged" — no re-bump, no rebuild. Content is identical to what was
 * verified in the stable run (same committed package.json, same resolved
 * deps); only the target registry/tag differ.
 */

import { defineCommand, type CLIInput, type PluginCommandContextV3, useLoader, useConfig, useEnv, type CommandResult } from '@kb-labs/sdk';
import {
  discoverCurrentPackages,
  resolvePublishTag,
  resolvePublishRegistry,
  mergeConfigWithFlow,
  type ReleaseConfig,
} from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';
import { publishPackagesProgrammatic, type ProgrammaticPublishResult } from '../../shared/publish-programmatic';
import { publishPackagesWithOTP, type PublishWithOTPResult } from '../../shared/publish-with-otp';

interface PromoteFlags {
  scope?: string;
  /** Named flow — selects packages the same way `release run --flow` does (e.g. excludes sdk from platform). */
  flow?: string;
  tag?: string;
  registry?: string;
  otp?: string;
  'dry-run'?: boolean;
  access?: string;
  token?: string;
  json?: boolean;
}

type PromoteResult = CommandResult<unknown>;

type PromoteResultItem = { success: boolean; name: string; version: string; error?: string };
type PromoteSummary = {
  success: boolean;
  published?: Array<{ name: string; version: string }>;
  failed?: Array<{ name: string; version: string; error: string }>;
  summary?: { total: number; successful: number; failed: number; tag: string; registry: string };
};

// ── helpers ────────────────────────────────────────────────────────────────

function buildPromoteSections(
  results: PromoteResultItem[],
  tag: string,
  registry: string,
  symbols: { success: string; error: string },
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];

  sections.push({ header: 'Promoting to', items: [`registry: ${registry}`, `tag: ${tag}`] });

  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    sections.push({
      header: 'Promoted',
      items: successful.map(r => `${symbols.success} ${r.name}@${r.version}`),
    });
  }

  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    sections.push({
      header: 'Failed',
      items: failed.map(r => `${symbols.error} ${r.name}@${r.version} - ${r.error}`),
    });
  }

  return sections;
}

function toPromoteResult(results: PromoteResultItem[], tag: string, registry: string): PromoteSummary {
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  return {
    success: failed === 0,
    published: results.filter(r => r.success).map(r => ({ name: r.name, version: r.version })),
    failed: results.filter(r => !r.success).map(r => ({
      name: r.name,
      version: r.version,
      error: r.error || 'Unknown error',
    })),
    summary: { total: results.length, successful, failed, tag, registry },
  };
}

// ── command ────────────────────────────────────────────────────────────────

export default defineCommand({
  id: 'release:promote',
  description: 'Promote already-released package versions to npm (no re-bump, no rebuild)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<PromoteFlags>): Promise<PromoteResult> {
      const { flags } = input;
      const { scope, otp: initialOtp, access, json } = flags;
      const dryRun = flags['dry-run'];
      const token = flags.token ?? useEnv('NPM_TOKEN') ?? useEnv('NODE_AUTH_TOKEN');

      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const fileConfig = await useConfig<ReleaseConfig>();
      const baseConfig: ReleaseConfig = fileConfig ?? {};
      const config: ReleaseConfig = flags.flow ? mergeConfigWithFlow(baseConfig, flags.flow) : baseConfig;

      const tag = flags.tag ?? resolvePublishTag(config, 'stable');
      const registry = flags.registry ?? resolvePublishRegistry(config, 'stable');

      const discoveryLoader = useLoader('Discovering already-released packages...');
      discoveryLoader.start();

      const discovered = await discoverCurrentPackages(repoRoot, scope, config);
      const packages = discovered.map(pkg => ({
        name: pkg.name,
        version: pkg.currentVersion,
        path: pkg.path,
      }));
      discoveryLoader.succeed(`Found ${packages.length} package(s) to promote`);

      if (packages.length === 0) {
        const msg = `No packages found to promote${scope ? ` matching scope: ${scope}` : ''}`;
        if (json) {
          return { error: msg };
        } else {
          ctx.ui?.write?.(msg);
        }
        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Command failed', hint: "Run `kb release stable publish --help` to review its inputs and recovery steps, then retry." } };
      }

      let rawResult: ProgrammaticPublishResult | PublishWithOTPResult;
      if (token) {
        rawResult = await publishPackagesProgrammatic({
          packages,
          dryRun,
          otp: initialOtp,
          tag,
          registry,
          access: (access as 'public' | 'restricted' | undefined) ?? config.publish?.access,
          token,
        });
      } else {
        rawResult = await publishPackagesWithOTP({
          packages,
          dryRun,
          otp: initialOtp,
          tag,
          registry,
          access: access ?? config.publish?.access ?? 'public',
          ui: ctx.ui,
          logger: ctx.platform?.logger,
        });
      }

      const promoteResult = toPromoteResult(rawResult.results, tag, registry);

      const response = promoteResult.success
        ? promoteResult
        : { ok: false as const, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Promotion failed', hint: 'Inspect the failed package details, resolve registry errors, then rerun `kb release stable publish`.' } };

      if (json) {
        return response;
      }

      ctx.ui?.sideBox?.({
        title: dryRun ? 'Promote Dry-Run' : 'Promote Summary',
        sections: buildPromoteSections(rawResult.results, tag, registry, ctx.ui.symbols),
        status: promoteResult.success ? 'success' : 'error',
      });

      return response;
    },
  },
});
