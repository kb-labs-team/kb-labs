/**
 * Stage a release plan's PLANNED package versions to a local registry
 * (Verdaccio), so the `pack-install` release gate can verify internal
 * cross-package dependencies against the version this release is about to
 * ship instead of whatever is already live on npm.
 *
 * Not to be confused with `release stage` (stage.ts): that command packs
 * already-committed, already-bumped versions for CI delivery AFTER human
 * approval — this one runs BEFORE Bump versions, off the in-memory plan
 * `Preview` already computed, and publishes to a throwaway local registry
 * instead of producing artifacts for a real release.
 *
 * Internal dependencies are rewritten to `^nextVersion` regardless of the
 * workspace's configured package manager: `rewriteWorkspaceDeps` only
 * rewrites `workspace:*` for non-pnpm managers (pnpm materializes
 * `workspace:*` itself, but only to the CURRENT on-disk version — the exact
 * thing this command exists to work around), so packages are always
 * packed/published here with the 'npm' package manager.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand, type CLIInput, type PluginContextV3, useLoader, useConfig, type CommandResult } from '@kb-labs/sdk';
import {
  discoverCurrentPackages,
  type ReleaseConfig,
  STAGED_TARBALLS_REL_DIR,
  type ReleasePlan,
} from '@kb-labs/release-manager-core';
import { findRepoRoot } from '../../shared/utils';
import { rewriteWorkspaceDeps } from '../../shared/dep-rewrite';
import { publishPackagesProgrammatic, type PackageToPublish } from '../../shared/publish-programmatic';

/** `npm pack --json` prints a JSON array; we only ever pack one package at a time. */
function filenameFromNpmPack(stdout: string): string | undefined {
  const parsed = JSON.parse(stdout) as Array<{ filename: string }>;
  return parsed[0]?.filename;
}

/**
 * Pack one plan package at its PLANNED nextVersion, with internal sibling
 * deps rewritten to the full-workspace versionMap (plan packages → their
 * nextVersion, everything else → current). Always uses `npm pack`, never
 * pnpm — see file header for why.
 */
function packPlanPackage(
  pkg: { name: string; path: string; nextVersion: string },
  outDir: string,
  versionMap: Map<string, string>,
): string {
  const restore = rewriteWorkspaceDeps({ path: pkg.path, version: pkg.nextVersion }, versionMap, 'npm');
  try {
    const packResult = spawnSync('npm', ['pack', '--pack-destination', outDir, '--json'], { cwd: pkg.path, stdio: 'pipe' });
    if (packResult.status !== 0) {
      const stderr = packResult.stderr?.toString().trim() || packResult.stdout?.toString().trim();
      throw new Error(`npm pack failed for ${pkg.name}@${pkg.nextVersion}${stderr ? `: ${stderr}` : ''}`);
    }
    const filename = filenameFromNpmPack(packResult.stdout.toString());
    if (!filename) {
      throw new Error(`npm pack produced no tarball for ${pkg.name}@${pkg.nextVersion}`);
    }
    return join(outDir, filename);
  } finally {
    restore();
  }
}

interface StagePlanFlags {
  'plan-path'?: string;
  registry?: string;
  token?: string;
  tag?: string;
  json?: boolean;
}

interface StagePlanPayload {
  registry: string;
  published: string[];
  alreadyPublished: string[];
  failed: string[];
}

export default defineCommand({
  id: 'release:stage-plan',
  description: 'Publish a release plan\'s planned package versions to a local staging registry (Verdaccio)',

  handler: {
    async execute(ctx: PluginContextV3, input: CLIInput<StagePlanFlags>): Promise<CommandResult<StagePlanPayload>> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const planPath = flags['plan-path'];
      const registry = flags.registry;

      if (!planPath || !registry) {
        const msg = 'release:stage-plan requires --plan-path <path> and --registry <url>';
        if (flags.json) { ctx.ui?.json?.({ error: msg }); } else { ctx.ui?.error?.(msg); }
        return { ok: false, error: 'Command failed' };
      }

      let plan: ReleasePlan;
      try {
        plan = JSON.parse(readFileSync(planPath, 'utf-8')) as ReleasePlan;
      } catch (err) {
        const msg = `release:stage-plan could not read plan at ${planPath}: ${err instanceof Error ? err.message : String(err)}`;
        if (flags.json) { ctx.ui?.json?.({ error: msg }); } else { ctx.ui?.error?.(msg); }
        return { ok: false, error: 'Command failed' };
      }

      if (plan.packages.length === 0) {
        const msg = 'No packages in release plan — nothing to stage';
        if (flags.json) { ctx.ui?.json?.({ ok: true, result: { registry, published: [], alreadyPublished: [], failed: [] } }); } else { ctx.ui?.write?.(msg); }
        return { ok: true, result: { registry, published: [], alreadyPublished: [], failed: [] } };
      }

      const fileConfig = await useConfig<ReleaseConfig>();
      const baseConfig: ReleaseConfig = fileConfig ?? {};

      // versionMap covers the WHOLE workspace (unfiltered baseConfig, not a
      // flow-merged one — a FlowConfig's `packages` filter COMPLETELY
      // REPLACES the global one, so merging here would silently drop
      // cross-flow siblings) so a plan package's dependency on a package
      // OUTSIDE this flow (not being released right now) still resolves —
      // to that sibling's current, already-published version, via the
      // staging registry's real-npm uplink. Plan packages then override
      // their own entry with the PLANNED nextVersion.
      const discoverLoader = useLoader('Resolving workspace package versions...');
      discoverLoader.start();
      const allWorkspacePackages = await discoverCurrentPackages(repoRoot, undefined, baseConfig);
      const versionMap = new Map(allWorkspacePackages.map(pkg => [pkg.name, pkg.currentVersion]));
      for (const pkg of plan.packages) {
        versionMap.set(pkg.name, pkg.nextVersion);
      }
      discoverLoader.succeed(`Resolved ${versionMap.size} workspace package version(s)`);

      // Pack each plan package ourselves (npm, deps pre-rewritten to
      // versionMap) rather than letting publishPackagesProgrammatic pack —
      // its own internal versionMap only covers the packages it's handed
      // (see publish-programmatic.ts), which would leave a plan package's
      // dependency on a package OUTSIDE this flow as a literal
      // unresolvable `workspace:*` in the published tarball.
      const packLoader = useLoader(`Packing ${plan.packages.length} planned package version(s)...`);
      packLoader.start();
      // Persistent, so the pack-static / pack-install checks verify these very
      // tarballs instead of packing every package again. Only stale .tgz files
      // and the manifest of a previous stage run are removed.
      const outDir = join(repoRoot, STAGED_TARBALLS_REL_DIR);
      mkdirSync(outDir, { recursive: true });
      for (const f of readdirSync(outDir)) {
        if (f.endsWith('.tgz') || f === 'manifest.json') { rmSync(join(outDir, f), { force: true }); }
      }
      const packagesToPublish: PackageToPublish[] = [];
      try {
        for (const pkg of plan.packages) {
          const tarballPath = packPlanPackage(pkg, outDir, versionMap);
          packagesToPublish.push({ name: pkg.name, version: pkg.nextVersion, path: pkg.path, tarballPath });
        }
      } catch (err) {
        packLoader.fail('Packing failed');
        const msg = err instanceof Error ? err.message : String(err);
        if (flags.json) { ctx.ui?.json?.({ error: msg }); } else { ctx.ui?.error?.(msg); }
        return { ok: false, error: 'Command failed' };
      }
      writeFileSync(
        join(outDir, 'manifest.json'),
        JSON.stringify(packagesToPublish.map(p => ({ name: p.name, version: p.version, tarball: (p.tarballPath ?? '').slice(outDir.length + 1) })), null, 2) + '\n',
      );
      packLoader.succeed(`Packed ${packagesToPublish.length} package(s)`);

      const stageLoader = useLoader(`Staging ${packagesToPublish.length} planned package version(s) to ${registry}...`);
      stageLoader.start();
      const result = await publishPackagesProgrammatic({
        packages: packagesToPublish,
        packageManager: 'npm',
        registry,
        tag: flags.tag ?? 'latest',
        access: 'public',
        token: flags.token ?? 'verdaccio-local',
      });

      if (result.failed.length > 0) {
        stageLoader.fail(`${result.failed.length}/${packagesToPublish.length} package(s) failed to stage`);
        if (flags.json) {
          ctx.ui?.json?.({ ok: false, result: { registry, ...result } });
        } else {
          ctx.ui?.error?.(result.errors.join('\n'));
        }
        return { ok: false, error: 'Command failed', result: { registry, published: result.published, alreadyPublished: result.alreadyPublished, failed: result.failed } };
      }

      stageLoader.succeed(`Staged ${result.published.length} package(s) (${result.alreadyPublished.length} already staged)`);

      const payload: StagePlanPayload = {
        registry,
        published: result.published,
        alreadyPublished: result.alreadyPublished,
        failed: result.failed,
      };

      console.log('::kb-output::' + JSON.stringify({ ok: true, registry, staged: payload.published.length + payload.alreadyPublished.length }));

      if (flags.json) {
        const response = { ok: true as const, result: payload };
        ctx.ui?.json?.(response);
        return response;
      }

      return { ok: true, result: payload };
    },
  },
});
