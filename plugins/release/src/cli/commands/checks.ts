/**
 * Release checks command — run pre-release checks from config.
 * Atomic step: reads plan, runs checks, emits output marker for workflow.
 */

import { defineCommand, type CLIInput, type CommandResult, type PluginCommandContextV3, useLoader, useConfig } from '@kb-labs/sdk';
import {
  planRelease,
  runReleaseChecks,
  resolveScopePath,
  buildReleaseRunReport,
  renderFailureLines,
  STAGED_TARBALLS_REL_DIR,
  type ReleaseConfig,
  type CheckResult,
  type ReleaseRunReport,
} from '../../core/index.js';
import { join } from 'node:path';
import { findRepoRoot } from '../../shared/utils';
import { runPreflightFor } from '../../shared/run-preflight';

interface ChecksFlags {
  scope?: string;
  flow?: string;
  json?: boolean;
  /** Opt-in: run the release preflight first and stop before checks if it fails. */
  preflight?: boolean;
  /** Comma-separated check ids to run exclusively (includes `disabled` ones). */
  only?: string;
  'net-offset'?: number | string;
}

type ReleaseChecksResult = CommandResult<unknown>;

function buildChecksSections(
  results: CheckResult[],
  report: ReleaseRunReport,
  symbols: { success: string; error: string; warning: string },
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];

  const passed = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  if (passed.length > 0) {
    sections.push({
      header: 'Passed',
      items: passed.map(r => `${symbols.success} ${r.id}${r.timingMs ? ` (${r.timingMs}ms)` : ''}`),
    });
  }

  if (failed.length > 0) {
    // Every failing check/package with classification, cause and hint,
    // instead of only the first failure's first 120 stderr chars.
    sections.push({
      header: 'Failed',
      items: [
        ...failed.map(r => `${symbols.error} ${r.id}`),
        ...renderFailureLines(report.failures),
      ],
    });
  }

  return sections;
}

export default defineCommand({
  id: 'release:checks',
  description: 'Run pre-release checks from release config',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ChecksFlags>): Promise<ReleaseChecksResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const fileConfig = await useConfig<ReleaseConfig>();
      const config: ReleaseConfig = fileConfig ?? {};
      // A flow owns its release checks. Falling back to the global checks is
      // important for callers without --flow, but using the global list when
      // a flow was explicitly requested runs unrelated checks (for example
      // the platform flow would also run the root typecheck/test suite).
      const checks = flags.flow
        ? (config.flows?.[flags.flow]?.checks ?? config.checks ?? [])
        : (config.checks ?? []);

      if (checks.length === 0) {
        const msg = 'No checks configured in release config';
        if (flags.json) {
          return { failed: [], results: [], message: msg };
        } else {
          ctx.ui?.write?.(msg);
        }
        return { ok: true, failed: [], results: [] };
      }

      // Opt-in preflight: default behaviour (flag absent) is unchanged.
      if (flags.preflight) {
        const pre = await runPreflightFor({
          repoRoot,
          config,
          flow: flags.flow,
          netOffset: flags['net-offset'],
        });
        if (!pre.ok) {
          const preReport = buildReleaseRunReport({ results: [], preflight: pre, flow: flags.flow, scope: flags.scope });
          const failure = preReport.failures[0]?.error;
          const diagnostics = preReport.failures.map((finding) => ({
            code: finding.error.code,
            message: `${finding.checkId} (${finding.package}): ${finding.rootCause} [${finding.classification}]`,
            severity: finding.optional ? 'warning' as const : 'error' as const,
            ...(finding.packagePath ? { path: finding.packagePath } : {}),
            hint: finding.hint,
          }));
          const outcome = failure
            ? { ok: false as const, error: { code: failure.code, message: failure.message, hint: failure.hint ?? 'Resolve the failed preflight check, then retry `kb release checks run`.', diagnostics } }
            : { ok: false as const, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Release preflight failed.', hint: "Run `kb release doctor` to see the failed preflight checks and exact recovery steps.", diagnostics } };
          if (flags.json) {
          }
          ctx.ui?.sideBox?.({
            title: 'Preflight failed - checks not run',
            sections: [{ header: 'Failed', items: renderFailureLines(preReport.failures) }],
            status: 'error',
          });
          return outcome;
        }
      }

      const planLoader = useLoader('Discovering packages...');
      planLoader.start();
      const plan = await planRelease({ cwd: repoRoot, config, scope: flags.scope, flow: flags.flow });
      planLoader.succeed(`Found ${plan.packages.length} package(s)`);

      const scopePath = await resolveScopePath(repoRoot, flags.scope ?? 'root');
      const packagePaths = plan.packages.map(p => p.path);

      // Tarballs come from the Stage step (`release candidate publish`), never re-packed here.
      const needsStaged = checks.some(c => c.builtin);
      const pack = needsStaged
        ? {
            plannedPackages: plan.packages.map(p => ({ name: p.name, version: p.nextVersion })),
            stagedDir: process.env.KB_RELEASE_STAGED_TARBALLS_DIR ?? join(repoRoot, STAGED_TARBALLS_REL_DIR),
            registry: process.env.KB_RELEASE_STAGING_REGISTRY || undefined,
            changedPackages: plan.packages.filter(p => p.bump !== 'none').map(p => p.name),
          }
        : undefined;
      const only = flags.only?.split(',').map(s => s.trim()).filter(Boolean);

      const checksLoader = useLoader(`Running ${checks.length} check(s)...`);
      checksLoader.start();

      const startedAt = Date.now();
      const results = await runReleaseChecks(checks, {
        repoRoot,
        packagePaths,
        scopePath,
        logger: ctx.platform?.logger,
        shell: ctx.api.shell,
        pack,
        only,
      });

      const runReport = buildReleaseRunReport({
        results,
        packages: plan.packages.map(p => ({ name: p.name, path: p.path })),
        flow: flags.flow,
        scope: flags.scope,
        checksDurationMs: Date.now() - startedAt,
      });

      // A failed optional check is reported (still listed in `failed`) but must not fail the run.
      const ok = results.every(r => r.ok || r.optional);
      const failed = results.filter(r => !r.ok).map(r => r.id);
      const diagnostics = runReport.failures.map((finding) => ({
        code: finding.error.code,
        message: `${finding.checkId} (${finding.package}): ${finding.rootCause} [${finding.classification}]`,
        severity: finding.optional ? 'warning' as const : 'error' as const,
        ...(finding.packagePath ? { path: finding.packagePath } : {}),
        hint: finding.hint,
      }));
      const outcome = ok
        ? { ok: true, failed, results, report: runReport }
        : { ok: false as const, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Release checks failed.', hint: "Run `kb release doctor` to verify the environment, then inspect the failed checks and rerun `kb release checks run`.", diagnostics } };

      if (ok) {
        checksLoader.succeed(`All ${results.length} check(s) passed`);
      } else {
        checksLoader.fail(`${failed.length} check(s) failed`);
      }

      if (flags.json) {
        return outcome;
      }

      ctx.ui?.sideBox?.({
        title: 'Pre-release Checks',
        sections: buildChecksSections(results, runReport, ctx.ui.symbols),
        status: ok ? 'success' : 'error',
      });

      return outcome;
    },
  },
});
