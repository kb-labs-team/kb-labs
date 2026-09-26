/**
 * Unified release pipeline — single orchestrator for CLI and REST.
 *
 * Flow: plan → snapshot → checks → build → verify → version bump → changelog → publish → git → report
 *
 * IMPORTANT — publish BEFORE git:
 *   We commit and tag AFTER a successful publish, not before.
 *   This prevents the "git tag exists but npm is empty" state that breaks installs.
 *   If publish fails (even partially), no git commit or tag is created.
 */

import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { useEnv } from '@kb-labs/sdk';
import { planRelease } from './planner';
import { saveSnapshot, restoreSnapshot } from './rollback';
import { updatePackageVersions } from './publisher';
import { copyChangelogToPackages, commitAndTagRelease, mergeRootChangelog } from './publisher';
import { buildPackages } from './build';
import { runReleaseChecks } from './checks';
import { verifyPackages } from './verifier';
import { verifyAgainstRegistry } from './verdaccio-verify';
import { acquireLock } from './lock';
import { resolvePublishTag, resolvePublishRegistry } from './channel';
import {
  loadCheckpoint,
  writeCheckpoint,
  deleteCheckpoint,
  isCheckpointResumable,
} from './checkpoint';
import type {
  PipelineOptions,
  PipelineResult,
  ReleaseReport,
  ReleaseResult,
  ReleasePlan,
  ReleaseStage,
  VersionBump,
} from './types';

/**
 * Run the complete release pipeline.
 * Both CLI and REST call this with different injected publishers/changelog generators.
 */
export async function runReleasePipeline(options: PipelineOptions): Promise<PipelineResult> {
  const {
    cwd: _cwd, repoRoot, scopeCwd, scope, config, dryRun = false,
    skipChecks = false, skipBuild = false, skipVerify = false,
    skipPublish = false,
    noVerify = false,
    checks: checkConfigs, publisher, changelog: changelogGen,
    logger, onProgress,
  } = options;

  const flow = options.flow;

  const startTime = Date.now();
  const progress = (stage: ReleaseStage, msg: string) => {
    logger?.info?.(msg);
    onProgress?.(stage, msg);
  };

  // 0a. Acquire exclusive lock — prevents concurrent release runs.
  const releaseLock = acquireLock(repoRoot, flow);

  try {
  return await _runPipeline({
    repoRoot, scopeCwd, scope, flow, config, dryRun, skipChecks, skipBuild, skipVerify,
    skipPublish, noVerify, checkConfigs, publisher, changelogGen, logger, startTime, progress,
    options,
  });
  } finally {
    releaseLock();
  }
}

async function _runPipeline(ctx: {
  repoRoot: string;
  scopeCwd: string;
  scope: string | undefined;
  flow: string | undefined;
  config: PipelineOptions['config'];
  dryRun: boolean;
  skipChecks: boolean;
  skipBuild: boolean;
  skipVerify: boolean;
  skipPublish: boolean;
  noVerify: boolean;
  checkConfigs: PipelineOptions['checks'];
  publisher: PipelineOptions['publisher'];
  changelogGen: PipelineOptions['changelog'];
  logger: PipelineOptions['logger'];
  startTime: number;
  progress: (stage: ReleaseStage, msg: string) => void;
  options: PipelineOptions;
}): Promise<PipelineResult> {
  const {
    repoRoot, scopeCwd, scope, flow, config, dryRun,
    skipChecks, skipBuild, skipVerify, skipPublish, noVerify,
    checkConfigs, publisher, changelogGen, logger, startTime, progress, options,
  } = ctx;

  // 0b. Pre-flight: verify npm credentials before doing any real work.
  // Skipped entirely in prepare-only mode — no npm access is needed to
  // build, version, changelog, and git-tag a release.
  const channel = config.channel ?? 'stable';
  const publishTag = resolvePublishTag(config, channel);
  const publishRegistry = resolvePublishRegistry(config, channel);

  if (!dryRun && !skipPublish) {
    const registry = publishRegistry;
    const authError = await verifyNpmAuth(registry);
    if (authError) {
      const emptyPlan: ReleasePlan = { packages: [], strategy: 'semver', registry, rollbackEnabled: false, channel };
      return {
        success: false,
        plan: emptyPlan,
        report: buildReport('planning', emptyPlan, repoRoot, dryRun, startTime, {
          ok: false,
          errors: [`npm auth check failed: ${authError}`],
          timingMs: Date.now() - startTime,
        }),
      };
    }
  }

  // 1. Plan — always discover from repoRoot with scope as a filter.
  // scopeCwd is used only for checks/git/changelog (physical path ops), not for discovery.
  progress('planning', 'Discovering packages and planning release...');
  const plan = await planRelease({
    cwd: repoRoot,
    config,
    scope,
    flow,                                     // already includes defaultFlow fallback
    bumpOverride: config.bump as VersionBump | undefined,
    channel,
  });

  if (plan.packages.length === 0) {
    return {
      success: false,
      plan,
      report: buildReport('planning', plan, repoRoot, dryRun, startTime, {
        ok: false, errors: [`No packages found for scope: ${scope || 'all'}`], timingMs: 0,
      }),
    };
  }

  progress('planning', `Found ${plan.packages.length} package(s) to release`);

  // 1b. Check for resumable checkpoint — publish already done, only git remains.
  // N/A in prepare-only mode: skipPublish never writes a checkpoint.
  if (!dryRun && !skipPublish) {
    const existingCheckpoint = loadCheckpoint(repoRoot);
    if (existingCheckpoint) {
      const uniqueVersions = new Set(plan.packages.map(p => p.nextVersion));
      const planVersion = uniqueVersions.size === 1 ? plan.packages[0]!.nextVersion : 'independent';
      if (isCheckpointResumable(existingCheckpoint, flow ?? 'default', planVersion)) {
        progress('publishing', 'Resuming from checkpoint — publish already done, running git step...');
        const resumeGit = await commitAndTagRelease({
          cwd: scopeCwd,
          plan,
          dryRun: false,
          noVerify,
          repoRoot,
          checkpointGitRoots: existingCheckpoint.gitRoots,
          changelogOutputPath: config.changelog?.outputPath,
          flowName: flow,
          tagPattern: flow ? config.flows?.[flow]?.tagPattern : undefined,
        });
        deleteCheckpoint(repoRoot);
        const resumeReport = buildReport('verifying', plan, repoRoot, dryRun, startTime, {
          ok: resumeGit.committed,
          published: existingCheckpoint.publishedPackages.map(p => `${p.name}@${p.version}`),
          git: resumeGit,
          timingMs: Date.now() - startTime,
        });
        const scopeDir = scope ? scope.replace(/[@/]/g, '-').replace(/^-/, '') : 'root';
        const historyDir = join(repoRoot, '.kb', 'release', 'history', scopeDir, new Date().toISOString().replace(/[:.]/g, '-'));
        await mkdir(historyDir, { recursive: true });
        await writeFile(join(historyDir, 'report.json'), JSON.stringify(resumeReport, null, 2), 'utf-8');
        return { success: resumeReport.result.ok, plan, report: resumeReport };
      }
    }
  }

  // 2. Snapshot (for rollback)
  await saveSnapshot({ cwd: repoRoot, plan });

  // 3. Checks
  if (!skipChecks && checkConfigs && checkConfigs.length > 0) {
    progress('checking', `Running ${checkConfigs.length} pre-release check(s)...`);

    const packagePaths = plan.packages.map(p => p.path);
    const checkResults = await runReleaseChecks(checkConfigs, {
      repoRoot,
      packagePaths,
      scopePath: scopeCwd,
      logger,
      shell: options.shell,
    });

    const failed = checkResults.filter(r => !r.ok && r.hint !== 'optional');
    if (failed.length > 0) {
      await restoreSnapshot(repoRoot);

      // Build rich per-check error messages for both human and agent consumption
      const errorLines = failed.flatMap(f => {
        if (f.skipped && !f.packages?.some(p => !p.ok && !p.skipped) && !f.details) {
          return [`check "${f.id}" skipped: ${f.skipReason ?? 'blocking dependency failed'}`];
        }
        const lines: string[] = [`check "${f.id}" failed`];
        if (f.details?.packagePath) { lines.push(`  package: ${f.details.packagePath}`); }
        if (f.details?.error) { lines.push(`  reason: ${f.details.error}`); }
        if (f.details?.stderr?.trim()) { lines.push(`  stderr: ${f.details.stderr.trim().split('\n').slice(0, 5).join('\n          ')}`); }
        if (f.details?.stdout?.trim() && !f.details?.stderr?.trim()) { lines.push(`  output: ${f.details.stdout.trim().split('\n').slice(0, 5).join('\n          ')}`); }
        if (f.packages?.filter(p => !p.ok).length) {
          const failedPkgs = f.packages.filter(p => !p.ok && !p.skipped);
          const skippedCount = f.packages.filter(p => p.skipped).length;
          if (skippedCount > 0) { lines.push(`  skipped in ${skippedCount} package(s): ${f.skipReason ?? 'blocking dependency failed'}`); }
          lines.push(`  failed in ${failedPkgs.length}/${f.packages.length} package(s):`);
          for (const pkg of failedPkgs.slice(0, 10)) {
            lines.push(`    - ${pkg.path}${pkg.details?.error ? `: ${pkg.details.error}` : ''}`);
          }
        }
        return lines;
      });

      return {
        success: false,
        plan,
        report: buildReport('checking', plan, repoRoot, dryRun, startTime, {
          ok: false,
          checks: Object.fromEntries(checkResults.map(r => [r.id, r])),
          errors: errorLines,
          timingMs: Date.now() - startTime,
        }),
      };
    }

    progress('checking', 'Pre-release checks passed');
  }

  // 4. Build
  if (!skipBuild && !dryRun) {
    progress('versioning', `Building ${plan.packages.length} package(s)...`);
    const buildResults = await buildPackages(plan.packages, { logger, shell: options.shell });
    const buildFailed = buildResults.filter(r => !r.success);

    if (buildFailed.length > 0) {
      await restoreSnapshot(repoRoot);
      return {
        success: false,
        plan,
        report: buildReport('versioning', plan, repoRoot, dryRun, startTime, {
          ok: false,
          errors: buildFailed.map(f => `Build failed: ${f.name} — ${f.error}`),
          timingMs: Date.now() - startTime,
        }),
      };
    }
  }

  // 5. Verify (pack + install check)
  if (!skipVerify && !dryRun) {
    progress('verifying', 'Verifying package artifacts...');
    // Must match what the real publish step packs with — pnpm resolves
    // workspace:/link: refs natively; verifying with a different tool than
    // what actually ships flags refs that will never make it to npm as-is.
    const packageManager = config.workspace?.type ?? config.publish?.packageManager ?? 'pnpm';
    const verifyResults = await verifyPackages(plan.packages, { logger, packageManager });
    const verifyFailed = verifyResults.filter(r => !r.success);

    if (verifyFailed.length > 0) {
      await restoreSnapshot(repoRoot);
      const allIssues = verifyFailed.flatMap(r => r.issues.map(i => `${r.name}: ${i}`));
      return {
        success: false,
        plan,
        report: buildReport('verifying', plan, repoRoot, dryRun, startTime, {
          ok: false,
          errors: [`Package verification failed:\n  ${allIssues.join('\n  ')}`],
          timingMs: Date.now() - startTime,
        }),
      };
    }

    progress('verifying', 'Package artifacts verified');
  }

  // 6. Version bump — canary never persists its computed version to
  // package.json/git; it publishes the in-memory nextVersion directly.
  if (channel === 'stable') {
    progress('versioning', 'Updating package versions...');
    if (!dryRun) {
      const versionUpdates = await updatePackageVersions(plan);
      const failedUpdates = versionUpdates.filter(u => !u.updated);
      if (failedUpdates.length > 0) {
        await restoreSnapshot(repoRoot);
        return {
          success: false,
          plan,
          report: buildReport('versioning', plan, repoRoot, dryRun, startTime, {
            ok: false,
            errors: failedUpdates.map(u => `Version update failed: ${u.package}`),
            versionUpdates,
            timingMs: Date.now() - startTime,
          }),
        };
      }
    }
  }

  // 7. Changelog — skipped for canary: there's nothing to changelog against a
  // registry-only prerelease, and writing CHANGELOG.md would leave dirty,
  // uncommitted files behind since canary never runs the git stage either.
  let changelogMd = '';
  if (changelogGen && channel === 'stable') {
    progress('versioning', 'Generating changelog...');
    try {
      changelogMd = await changelogGen.generate(plan, { repoRoot, gitCwd: scopeCwd, config, flow });
    } catch (err) {
      logger?.warn?.(`Changelog generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (changelogMd && !dryRun) {
    await copyChangelogToPackages({ cwd: repoRoot, plan, changelog: changelogMd });
    await mergeRootChangelog({ repoRoot, plan, changelog: changelogMd, outputPath: config.changelog?.outputPath });
  }

  // 8. Publish (before git — see module comment).
  // Prepare-only mode (skipPublish) never calls the publisher — it produces
  // a synthetic "nothing published yet" result and falls straight through to
  // git commit/tag. A separate CI job (`kb release promote`), triggered by
  // the tag this run pushes, does the actual npm publish. See
  // plugins/release/docs/adr/0001-*.
  progress('publishing', dryRun ? 'Simulating publish (dry-run)...' : skipPublish ? 'Skipping publish (prepare-only)...' : 'Publishing packages...');
  const packagesToPublish = plan.packages.map(pkg => ({
    name: pkg.name,
    version: pkg.nextVersion,
    path: pkg.path,
  }));

  const publishResult = skipPublish
    ? {
      published: [],
      alreadyPublished: [],
      failed: [],
      skipped: packagesToPublish.map(p => `${p.name}@${p.version} (prepared, not published)`),
      errors: [],
    }
    : await publisher.publish(packagesToPublish, {
      dryRun,
      access: config.publish?.access ?? 'public',
      tag: publishTag,
      registry: publishRegistry,
    });

  // If any package genuinely failed to publish, abort before touching git.
  // "alreadyPublished" entries are fine — they are counted as success.
  const publishFailed = publishResult.failed.length > 0;

  if (publishFailed) {
    return {
      success: false,
      plan,
      report: buildReport('publishing', plan, repoRoot, dryRun, startTime, {
        ok: false,
        published: publishResult.published,
        skipped: publishResult.skipped,
        errors: [
          `${publishResult.failed.length} package(s) failed to publish — git commit/tag skipped to prevent desync.`,
          ...(publishResult.errors ?? []),
        ],
        timingMs: Date.now() - startTime,
      }),
    };
  }

  // 8b. Write checkpoint after successful publish — enables git-only retry on failure.
  // Skipped for canary: there's no git step to resume into, and canary versions
  // are deterministic per (base version, shortSha) so retries are naturally
  // idempotent via the publisher's already-published handling. Skipped for
  // skipPublish: nothing was published, there's nothing to check-point.
  if (!dryRun && !skipPublish && channel === 'stable') {
    const uniqueVersions = new Set(plan.packages.map(p => p.nextVersion));
    const cpVersion = uniqueVersions.size === 1 ? plan.packages[0]!.nextVersion : 'independent';
    writeCheckpoint(repoRoot, {
      flow: flow ?? 'default',
      version: cpVersion,
      publishedPackages: plan.packages.map(p => ({
        name: p.name,
        version: p.nextVersion,
        path: p.path,
        gitRoot: p.gitRoot,
      })),
      gitRoots: {},
    });
  }

  // 8c. Verify the published artifact against the registry it was just
  // published to — a hard invariant for stable releases (not opt-in): confirms
  // each package actually landed and re-runs the same static checks against
  // what the registry served back, catching publish-time corruption distinct
  // from pre-publish source issues. Canary skips this — it never goes through
  // a Verdaccio pre-promote gate. skipPublish skips it too — nothing landed
  // on any registry this run; `kb release promote` verifies its own publish.
  if (!dryRun && !skipPublish && channel === 'stable') {
    progress('verifying', 'Verifying published artifacts against the registry...');
    const registryVerifyResults = await verifyAgainstRegistry(packagesToPublish, {
      registry: publishRegistry,
      timeout: config.publish?.verifyRegistryTimeoutMs,
      logger,
    });
    const registryVerifyFailed = registryVerifyResults.filter(r => !r.success);
    if (registryVerifyFailed.length > 0) {
      const allIssues = registryVerifyFailed.flatMap(r => r.issues.map(i => `${r.name}: ${i}`));
      return {
        success: false,
        plan,
        report: buildReport('verifying', plan, repoRoot, dryRun, startTime, {
          ok: false,
          published: publishResult.published,
          errors: [`Registry verification failed after publish — git commit/tag skipped:\n  ${allIssues.join('\n  ')}`],
          timingMs: Date.now() - startTime,
        }),
      };
    }
  }

  // 9. Git commit + tag — only after all packages are on npm.
  // Canary never runs this: its version is never persisted to package.json,
  // so there's nothing meaningful to commit or tag.
  let gitResult: { committed: boolean; tagged: string[]; pushed: boolean } | undefined;
  if (!dryRun && channel === 'stable') {
    progress('verifying', 'Committing and tagging release...');
    gitResult = await commitAndTagRelease({
      cwd: scopeCwd, plan, dryRun, noVerify, repoRoot,
      changelogOutputPath: config.changelog?.outputPath,
      flowName: flow,
      tagPattern: flow ? config.flows?.[flow]?.tagPattern : undefined,
    });
    deleteCheckpoint(repoRoot);
  }

  // 10. Report
  const report = buildReport('verifying', plan, repoRoot, dryRun, startTime, {
    ok: (!gitResult || gitResult.committed),
    published: publishResult.published,
    alreadyPublished: publishResult.alreadyPublished,
    skipped: publishResult.skipped,
    changelog: changelogMd || undefined,
    git: gitResult,
    timingMs: Date.now() - startTime,
  });

  // Save report
  const scopeDir = scope ? scope.replace(/[@/]/g, '-').replace(/^-/, '') : 'root';
  const historyDir = join(repoRoot, '.kb', 'release', 'history', scopeDir, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');

  return { success: report.result.ok, plan, report };
}

/**
 * Quick pre-flight check: verify npm credentials are valid.
 * Uses the registry HTTP API directly — works regardless of .npmrc config.
 * Returns an error string on failure, null on success.
 */
async function verifyNpmAuth(registry: string): Promise<string | null> {
  const token = useEnv('NPM_TOKEN') ?? useEnv('NODE_AUTH_TOKEN');
  if (!token) {
    return 'NPM_TOKEN or NODE_AUTH_TOKEN environment variable is not set';
  }
  try {
    const res = await fetch(`${registry}/-/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return `npm token invalid or expired (HTTP ${res.status} from ${registry})`;
    }
    return null;
  } catch (e) {
    return `npm registry unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function buildReport(
  stage: ReleaseStage,
  plan: ReleasePlan,
  repoRoot: string,
  dryRun: boolean,
  startTime: number,
  result: Partial<ReleaseResult> & { ok: boolean; timingMs: number },
): ReleaseReport {
  return {
    schemaVersion: '1.0',
    ts: new Date().toISOString(),
    context: { repo: repoRoot, cwd: repoRoot, branch: 'unknown', dryRun },
    stage,
    plan,
    result: { ...result, timingMs: result.timingMs ?? (Date.now() - startTime) },
  };
}
