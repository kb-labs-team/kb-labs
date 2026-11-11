/**
 * Release status command — one receipt-style view answering "what is
 * actually stable, what is candidate, and why" without reading raw Actions
 * logs or comparing npm/git by hand.
 *
 * Deliberately reads only surfaces that already exist (git tags, real npm
 * dist-tags, recent candidate CI runs) — no new storage, no CAS, no receipt
 * store. See docs/plans/2026-08-13-release-operating-system-audit.md §Wave 0.
 */
import {
  defineCommand,
  type CLIInput,
  type CommandResult,
  type PluginCommandContextV3,
  useLoader,
  useConfig,
} from '@kb-labs/sdk';
import {
  computeFlowReleaseStatus,
  createExecaShellAdapter,
  type ReleaseConfig,
  type FlowReleaseStatus,
} from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';

interface StatusFlags {
  flow: string;
  json?: boolean;
  ci?: boolean;
}

type ReleaseStatusResult = CommandResult<unknown>;

interface CandidateRun {
  workflow: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

const CANDIDATE_WORKFLOWS = ['release-build-candidate.yml', 'release-deliver-candidate.yml'];

async function fetchRecentCandidateRuns(
  shell: ReturnType<typeof createExecaShellAdapter>,
  cwd: string,
  limit: number,
): Promise<{ runs: CandidateRun[]; error?: string }> {
  const runs: CandidateRun[] = [];
  for (const workflow of CANDIDATE_WORKFLOWS) {
    const res = await shell.exec(
      'gh',
      [
        'run', 'list',
        `--workflow=${workflow}`,
        '--limit', String(limit),
        '--json', 'headSha,status,conclusion,createdAt',
      ],
      { cwd, timeout: 15000 },
    );
    if (!res.ok) {
      return { runs, error: res.stderr.trim() || `gh run list failed for ${workflow}` };
    }
    try {
      const parsed = JSON.parse(res.stdout) as Array<{ headSha: string; status: string; conclusion: string | null; createdAt: string }>;
      runs.push(...parsed.map(r => ({ workflow, ...r })));
    } catch {
      return { runs, error: `Could not parse gh output for ${workflow}` };
    }
  }
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { runs };
}

// ── rendering ──────────────────────────────────────────────────────────────

function buildStatusSections(
  status: FlowReleaseStatus,
  ci: { runs: CandidateRun[]; error?: string } | undefined,
  symbols: { success: string; error: string; warning: string },
): Array<{ header?: string; items: string[] }> {
  const sections: Array<{ header?: string; items: string[] }> = [];

  sections.push({
    header: 'Stable (git)',
    items: status.git.tag
      ? [
          `Tag: ${status.git.tag} (${status.git.version})`,
          `Commit: ${status.git.commit?.slice(0, 12) ?? 'unknown'}`,
          `Tagged at: ${status.git.committedAt ?? 'unknown'}`,
        ]
      : ['No stable tag found for this flow'],
  });

  sections.push({
    header: `npm (${status.npm.registry})`,
    items: [
      `"${status.npm.stableDistTag}": ${status.npm.stableVersion ?? (status.npm.stableDrift ? 'DRIFT — packages disagree' : 'unresolved')}`,
      `"${status.npm.canaryDistTag}": ${status.npm.canaryVersion ?? (status.npm.canaryDrift ? 'DRIFT — packages disagree' : 'unresolved')}`,
      `Sampled: ${status.npm.perPackage.map(p => p.name).join(', ')}`,
    ],
  });

  if (ci) {
    if (ci.error) {
      sections.push({ header: 'Recent candidate CI', items: [`${symbols.warning} ${ci.error}`] });
    } else if (ci.runs.length === 0) {
      sections.push({ header: 'Recent candidate CI', items: ['No recent runs found'] });
    } else {
      sections.push({
        header: 'Recent candidate CI',
        items: ci.runs.slice(0, 8).map(r => {
          const icon = r.conclusion === 'success' ? symbols.success : r.conclusion ? symbols.error : symbols.warning;
          return `${icon} ${r.workflow.replace('.yml', '')} — ${r.headSha.slice(0, 12)} — ${r.conclusion ?? r.status} (${r.createdAt})`;
        }),
      });
    }
  }

  if (status.verdict.warnings.length > 0) {
    sections.push({
      header: 'Warnings',
      items: status.verdict.warnings.map(w => `${symbols.warning} ${w}`),
    });
  } else {
    sections.push({ items: [`${symbols.success} Stable tag and npm agree; no drift detected`] });
  }

  return sections;
}

// ── command ────────────────────────────────────────────────────────────────

export default defineCommand({
  id: 'release:status',
  description: 'Show what is actually stable vs. candidate for a release flow (git tag, npm dist-tags, recent candidate CI)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<StatusFlags>): Promise<ReleaseStatusResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      if (!flags.flow) {

        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: '--flow is required', hint: "Run `kb release status --help` to review its inputs and recovery steps, then retry." } };
      }

      const loader = useLoader(`Checking release status for "${flags.flow}"...`);
      loader.start();

      const config: ReleaseConfig = { ...(await useConfig<ReleaseConfig>()) };
      const shell = createExecaShellAdapter();

      let status: FlowReleaseStatus;
      try {
        status = await computeFlowReleaseStatus({ cwd: repoRoot, config, flow: flags.flow, shell });
      } catch (err) {
        loader.fail('Failed to compute release status');
        const message = err instanceof Error ? err.message : String(err);

        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: message, hint: "Run `kb release status --help` to review its inputs and recovery steps, then retry." } };
      }

      const ci = flags.ci === false ? undefined : await fetchRecentCandidateRuns(shell, repoRoot, 5);

      loader.succeed(
        status.verdict.ok
          ? `"${flags.flow}" is clean — stable tag and npm agree`
          : `"${flags.flow}" has ${status.verdict.warnings.length} warning(s)`,
      );

      ctx.platform?.logger?.info?.('Release status computed', {
        flow: flags.flow,
        ok: status.verdict.ok,
        warnings: status.verdict.warnings.length,
      });

      if (flags.json) {
        return { ...status, ci };
      } else {
        ctx.ui?.sideBox?.({
          title: `Release status — ${flags.flow}`,
          sections: buildStatusSections(status, ci, ctx.ui!.symbols),
          status: status.verdict.ok ? 'success' : 'warning',
        });
      }

      return { ...status, ci };
    },
  },
});
