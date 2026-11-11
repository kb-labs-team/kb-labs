/**
 * Release run command — thin adapter over core runReleasePipeline().
 * Mirror of rest/handlers/run-handler.ts for CLI context.
 *
 * Flow:
 *   1. Load config
 *   2. Plan (discover packages, compute versions)
 *   3. Show plan table + confirm [y/N]  (skipped with --yes or --dry-run)
 *   4. Execute pipeline with elapsed-time progress
 */

import * as readline from 'node:readline/promises';
import {
  defineCommand,
  type CLIInput,
  type CommandResult,
  type PluginCommandContextV3,
  useLLM,
  useLoader,
  useConfig,
  useEnv,
} from '@kb-labs/sdk';
import {
  runReleasePipeline,
  planRelease,
  resolveScopePath,
  resolvePublishRegistry,
  type ReleaseConfig,
  type ReleaseChannel,
  type ReleaseReport,
  type CheckResult,
  type PublishablePackage,
  type PublishResult,
} from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';
import { createChangelogGenerator } from '../../shared/changelog-factory';
import { publishPackagesProgrammatic } from '../../shared/publish-programmatic';
import { publishPackagesWithOTP } from '../../shared/publish-with-otp';

interface RunFlags {
  scope?: string;
  flow?: string;
  bump?: 'patch' | 'minor' | 'major' | 'auto';
  strict?: boolean;
  channel?: ReleaseChannel;
  'dry-run'?: boolean;
  'skip-checks'?: boolean;
  'skip-build'?: boolean;
  'skip-verify'?: boolean;
  'skip-publish'?: boolean;
  'no-verify'?: boolean;
  yes?: boolean;
  json?: boolean;
}

type ReleaseRunResult = CommandResult<unknown>;

const BUMP_SYMBOL: Record<string, string> = {
  major: '!!',
  minor: '+',
  patch: '·',
  auto: '?',
};

// ── helpers ────────────────────────────────────────────────────────────────

function buildPlanRows(packages: Array<{ bump?: string; name: string; currentVersion: string; nextVersion: string }>): string[] {
  return packages.map(pkg => {
    const bump = pkg.bump ?? 'auto';
    const sym = BUMP_SYMBOL[bump] ?? '?';
    return `  ${sym}  ${pkg.name.padEnd(40)} ${pkg.currentVersion.padStart(8)}  →  ${pkg.nextVersion}`;
  });
}

function createPublisher(
  config: ReleaseConfig,
  token: string | undefined,
  ctx: PluginCommandContextV3,
): { publish(packages: PublishablePackage[], opts: { dryRun?: boolean; access?: string; tag?: string; registry?: string }): Promise<PublishResult> } {
  const packageManager = config.workspace?.type ?? config.publish?.packageManager ?? 'pnpm';
  return {
    async publish(packages: PublishablePackage[], opts: { dryRun?: boolean; access?: string; tag?: string; registry?: string }): Promise<PublishResult> {
      // registry/tag come from pipeline.ts, resolved per-channel from config
      // (config.registry for stable, config.publish.npmRegistry for canary).
      const registry = opts.registry ?? config.registry;
      if (token) {
        const r = await publishPackagesProgrammatic({
          packages,
          packageManager,
          dryRun: opts.dryRun,
          access: (opts.access as 'public' | 'restricted') ?? 'public',
          tag: opts.tag,
          registry,
          token,
        });
        return { published: r.published, alreadyPublished: r.alreadyPublished, failed: r.failed, skipped: r.skipped, errors: r.errors };
      }
      // PublishWithOTPResult is structurally compatible with core PublishResult
      // (both have published/alreadyPublished/failed/skipped). Double-cast to satisfy
      // the return type without widening to any.
      return publishPackagesWithOTP({
        packages,
        packageManager,
        dryRun: opts.dryRun,
        access: opts.access ?? 'public',
        tag: opts.tag,
        registry,
        ui: ctx.ui,
        logger: ctx.platform?.logger,
      }) as unknown as Promise<PublishResult>;
    },
  };
}

function appendCheckDetails(c: CheckResult, checkItems: string[]): void {
  if (c.details?.packagePath) { checkItems.push(`     package: ${c.details.packagePath}`); }
  if (c.details?.error) { checkItems.push(`     reason:  ${c.details.error}`); }
  const output = (c.details?.stderr || c.details?.stdout || '').trim();
  if (output) {
    checkItems.push(`     output:`);
    for (const line of output.split('\n').slice(0, 8)) { checkItems.push(`       ${line}`); }
  }
  const failedPkgs = (c.packages ?? []).filter(p => !p.ok);
  if (failedPkgs.length) {
    checkItems.push(`     failed in ${failedPkgs.length}/${c.packages!.length} package(s):`);
    for (const pkg of failedPkgs.slice(0, 10)) {
      checkItems.push(`       - ${pkg.path}${pkg.details?.error ? `: ${pkg.details.error}` : ''}`);
    }
  }
}

function buildCheckItems(checkEntries: CheckResult[], symbols: { success: string; warning: string; error: string }): string[] {
  const checkItems: string[] = [];
  for (const c of checkEntries) {
    const sym = c.ok ? symbols.success : (c.hint === 'optional' ? symbols.warning : symbols.error);
    const timing = c.timingMs ? ` (${(c.timingMs / 1000).toFixed(1)}s)` : '';
    checkItems.push(`${sym} ${c.id}${timing}`);
    if (!c.ok && c.hint !== 'optional') { appendCheckDetails(c, checkItems); }
  }
  return checkItems;
}

function buildReleaseSections(
  report: ReleaseReport,
  dryRun: boolean,
  skipPublish: boolean,
  ctx: PluginCommandContextV3,
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];

  if (!dryRun && report.result.published?.length) {
    sections.push({
      header: 'Published',
      items: report.result.published.map(p => `${ctx.ui.symbols.success} ${p}`),
    });
  }

  if (!dryRun && report.result.alreadyPublished?.length) {
    sections.push({
      header: 'Already published (skipped)',
      items: report.result.alreadyPublished.map(p => `${ctx.ui.symbols.info} ${p}`),
    });
  }

  if (dryRun && report.result.skipped?.length) {
    sections.push({
      header: 'Would publish (dry-run)',
      items: report.result.skipped.map(p => `${ctx.ui.symbols.info} ${p.replace(' (dry-run)', '')}`),
    });
  }

  if (!dryRun && skipPublish && report.result.skipped?.length) {
    sections.push({
      header: 'Prepared — not published (git tag pushed, CI publishes on tag)',
      items: report.result.skipped.map(p => `${ctx.ui.symbols.info} ${p}`),
    });
  }

  if (report.result.checks) {
    const checkEntries = (Object.values(report.result.checks) as CheckResult[]).filter(Boolean);
    const passed = checkEntries.filter(c => c.ok);
    const failed = checkEntries.filter(c => !c.ok && c.hint !== 'optional');
    const skipped = checkEntries.filter(c => !c.ok && c.hint === 'optional');

    if (checkEntries.length > 0) {
      sections.push({
        header: `Checks — ${passed.length} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`,
        items: buildCheckItems(checkEntries, ctx.ui.symbols),
      });
    }
  }

  if (report.result.errors?.length && !report.result.checks) {
    sections.push({
      header: 'Errors',
      items: report.result.errors.map(e => `${ctx.ui.symbols.error} ${e}`),
    });
  }

  if (report.result.git) {
    const g = report.result.git;
    sections.push({
      header: 'Git',
      items: [
        `Committed: ${g.committed}`,
        `Tags: ${g.tagged?.join(', ') || 'none'}`,
        `Pushed: ${g.pushed}`,
      ],
    });
  }

  return sections;
}

function resolveChecks(flags: RunFlags, config: ReleaseConfig): NonNullable<ReleaseConfig['checks']> {
  const flowChecks = flags.flow ? config.flows?.[flags.flow]?.checks : undefined;
  const scopeChecks = flags.scope ? config.scopes?.[flags.scope]?.checks : undefined;
  const selectedChecks = flowChecks ?? scopeChecks ?? [];
  const checksById = new Map<string, NonNullable<ReleaseConfig['checks']>[number]>();

  // Flow/scope checks are additions to the global release contract. A flow may
  // replace a check with a stricter command, but it may not silently drop a
  // global gate (the old behavior made platform releases skip typecheck,
  // lint, tests and pack-install).
  for (const check of config.checks ?? []) { checksById.set(check.id, check); }
  for (const check of selectedChecks) { checksById.set(check.id, check); }

  const channel = flags.channel ?? config.channel ?? 'stable';
  return [...checksById.values()].map(check =>
    channel === 'stable' && check.optional ? { ...check, optional: false } : check,
  );
}

async function confirmRelease(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question('\nProceed with release? [y/N] ');
  } finally {
    rl.close();
  }
  return answer.trim().toLowerCase() === 'y';
}

function showPlanBox(
  ctx: PluginCommandContextV3,
  flags: RunFlags,
  plan: { packages: Array<{ bump?: string; name: string; currentVersion: string; nextVersion: string }> },
  config: ReleaseConfig,
  dryRun: boolean,
): void {
  if (flags.json) { return; }
  ctx.ui?.sideBox?.({
    title: dryRun ? 'Release Plan (dry-run)' : 'Release Plan',
    sections: [
      {
        header: `${plan.packages.length} package(s) · strategy: ${config.versioningStrategy ?? 'independent'}${flags.flow ? ` · flow: ${flags.flow}` : ''}`,
        items: buildPlanRows(plan.packages),
      },
    ],
    status: 'info',
  });
  if (flags['no-verify']) {
    ctx.ui.write?.(`  ⚠️  --no-verify: git pre-push hooks will be skipped\n`);
  }
}

function reportPipelineResult(
  ctx: PluginCommandContextV3,
  flags: RunFlags,
  result: { success: boolean; report: ReleaseReport },
  dryRun: boolean,
  skipPublish: boolean,
): void {
  if (flags.json) return;
  ctx.ui?.sideBox?.({
    title: 'Release',
    sections: buildReleaseSections(result.report, dryRun, skipPublish, ctx),
    status: result.success ? 'success' : 'error',
    timing: result.report.result.timingMs,
  });
}

export default defineCommand({
  id: 'release:run',
  description: 'Execute release process (plan, check, publish)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunFlags>): Promise<ReleaseRunResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);
      const dryRun = flags['dry-run'] === true;
      const skipYes = flags.yes === true || dryRun;

      // 1. Load config
      const configLoader = useLoader('Loading configuration...');
      configLoader.start();
      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = {
        ...fileConfig,
        ...(flags.bump && { bump: flags.bump }),
        ...(flags.strict !== undefined && { strict: flags.strict }),
        ...(flags.channel && { channel: flags.channel }),
      };
      configLoader.succeed('Configuration loaded');

      const channel: ReleaseChannel = config.channel ?? 'stable';
      const skipPublish = flags['skip-publish'] === true;
      const token = useEnv('NPM_TOKEN') ?? useEnv('NODE_AUTH_TOKEN');

      // 1b. Pre-flight — fail fast before planning (which is slow).
      // The npm-credentials check is skipped entirely in prepare-only mode:
      // no npm access is needed to build, version, changelog, and git-tag a
      // release. The separate `kb release stable publish` step (run by CI on the
      // tag this pushes) does its own npm pre-flight. Flow validity is
      // always checked, publish or not.
      if (!dryRun) {
        const preErrors: string[] = [];

        if (!skipPublish) {
          const registry = resolvePublishRegistry(config, channel);
          if (!token) {
            preErrors.push('NPM_TOKEN or NODE_AUTH_TOKEN is not set');
          } else {
            try {
              const res = await fetch(`${registry}/-/whoami`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(8000),
              });
              if (!res.ok) {
                preErrors.push(`npm token invalid or expired (HTTP ${res.status} from ${registry})`);
              }
            } catch (e) {
              preErrors.push(`npm registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        if (flags.flow && config.flows && !(flags.flow in config.flows)) {
          preErrors.push(`Flow "${flags.flow}" is not defined in release.flows config`);
        }

        if (preErrors.length > 0) {
          ctx.ui?.sideBox?.({
            title: 'Release — pre-flight failed',
            sections: [{ items: preErrors.map(e => `${ctx.ui.symbols.error} ${e}`) }],
            status: 'error',
          });
          return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Command failed', hint: "Run `kb release run --help` to review its inputs and recovery steps, then retry." } };
        }
      }

      const scopeCwd = await resolveScopePath(repoRoot, flags.scope || 'root');

      // 2. Plan — run separately so we can show it before asking for confirm
      const planLoader = useLoader('Discovering packages...');
      planLoader.start();
      const plan = await planRelease({
        cwd: repoRoot,
        config,
        scope: flags.scope,
        flow: flags.flow,
        // config.bump is already VersionBump | undefined — same type as bumpOverride
        bumpOverride: config.bump,
        channel,
      });
      planLoader.succeed(`Found ${plan.packages.length} package(s)`);

      if (plan.packages.length === 0) {
        ctx.ui?.sideBox?.({
          title: 'Release',
          sections: [{ items: [`${ctx.ui.symbols.warning} No packages to release`] }],
          status: 'info',
        });
        return {};
      }

      // 3. Show plan table
      showPlanBox(ctx, flags, plan, config, dryRun);

      // 4. Confirm (skip with --yes or --dry-run)
      if (!skipYes) {
        const confirmed = await confirmRelease();
        if (!confirmed) {
          ctx.ui?.sideBox?.({
            title: 'Release',
            sections: [{ items: [`${ctx.ui.symbols.info} Cancelled`] }],
            status: 'info',
          });
          return {};
        }
      }

      // 5. Execute pipeline
      const llm = useLLM();
      const changelog = createChangelogGenerator(config, llm ?? undefined);
      const publisher = createPublisher(config, token, ctx);

      const pipelineLoader = useLoader('Running release pipeline...');
      pipelineLoader.start();

      const pipelineStart = Date.now();

      const result = await runReleasePipeline({
        cwd,
        repoRoot,
        scopeCwd,
        scope: flags.scope,
        flow: flags.flow,
        config,
        dryRun,
        skipChecks: flags['skip-checks'],
        skipBuild: flags['skip-build'],
        skipVerify: flags['skip-verify'],
        skipPublish,
        noVerify: flags['no-verify'],
        checks: resolveChecks(flags, config),
        publisher,
        changelog,
        shell: ctx.api.shell,
        logger: ctx.platform?.logger,
        onProgress: (_stage, message) => {
          const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
          pipelineLoader.update({ text: `[${elapsed}s] ${message}` });
        },
      });

      pipelineLoader.succeed(result.success ? 'Release completed' : 'Release failed');

      reportPipelineResult(ctx, flags, result, dryRun, skipPublish);

      return result.success ? { report: result.report } : { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Command failed', hint: "Run `kb release run --help` to review its inputs and recovery steps, then retry." } };
    },
  },
});
