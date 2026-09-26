/**
 * Release preflight — seconds-fast environment gate before the long checks
 * stage (09 §3.1, R1.1). Read-only: never starts Docker/Verdaccio, only
 * reports and prints the exact command to fix the environment.
 *
 * Probes run through createExecaShellAdapter (like `release status`) because
 * docker/gh are outside the plugin's governed shell allow-list.
 */
import {
  defineCommand,
  type CLIInput,
  type CommandResult,
  type PluginContextV3,
  useConfig,
} from '@kb-labs/sdk';
import {
  buildReleaseRunReport,
  renderFailureLines,
  type PreflightResult,
  type ReleaseConfig,
} from '@kb-labs/release-manager-core';
import { findRepoRoot } from '../../shared/utils';
import { runPreflightFor } from '../../shared/run-preflight';

interface PreflightFlags {
  flow?: string;
  branch?: string;
  'net-offset'?: number | string;
  'staging-registry'?: string;
  json?: boolean;
}

function sections(
  result: PreflightResult,
  failureLines: string[],
  symbols: { success: string; error: string; warning: string },
): Array<{ header?: string; items: string[] }> {
  const out: Array<{ header?: string; items: string[] }> = [{
    header: 'Checks',
    items: result.checks.map(c => {
      const icon = c.status === 'passed' ? symbols.success : c.status === 'failed' ? symbols.error : symbols.warning;
      return `${icon} ${c.id}: ${c.message} (${c.durationMs}ms)`;
    }),
  }];
  if (failureLines.length > 0) { out.push({ header: 'Failed', items: failureLines }); }
  return out;
}

export default defineCommand({
  id: 'release:preflight',
  description: 'Check the release environment (branch, tree, Docker, registries, GitHub auth, baseline drift) before running checks',

  handler: {
    async execute(ctx: PluginContextV3, input: CLIInput<PreflightFlags>): Promise<CommandResult<unknown>> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);
      const config: ReleaseConfig = { ...(await useConfig<ReleaseConfig>()) };
      const startedAt = Date.now();
      const result = await runPreflightFor({
        repoRoot,
        config,
        flow: flags.flow,
        branch: flags.branch,
        netOffset: flags['net-offset'],
        stagingRegistry: flags['staging-registry'],
      });

      const report = buildReleaseRunReport({
        results: [],
        preflight: result,
        flow: flags.flow,
        checksDurationMs: Date.now() - startedAt,
      });

      ctx.platform?.logger?.info?.('Release preflight finished', {
        ok: result.ok,
        failed: result.checks.filter(c => c.status === 'failed').map(c => c.id),
      });

      const payload = { ok: result.ok, preflight: result, report };
      if (flags.json) {
        ctx.ui?.json?.(payload);
      } else {
        ctx.ui?.sideBox?.({
          title: 'Release preflight',
          sections: sections(result, renderFailureLines(report.failures), ctx.ui.symbols),
          status: result.ok ? 'success' : 'error',
        });
      }

      return result.ok
        ? { ok: true, result: payload }
        : { ok: false, error: 'Preflight failed', result: payload };
    },
  },
});
