import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import {
  SnapshotStore,
  captureGit,
  analyzeFlakyCases,
  buildCaseTimeline,
} from '../../core/index.js';
import { PATHS, TRENDS_WINDOW, type QAPluginConfig, type E2eCaseResult } from '../../contracts/index.js';
import type { QaE2eFlakyFlags } from './flags.js';

async function runIngest(
  ctx: PluginCommandContextV3,
  cwd: string,
  store: SnapshotStore,
  dir: string,
): Promise<CommandResult> {
  const cases: E2eCaseResult[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = entry.isDirectory()
        ? join(dir, entry.name, 'flaky-report.json')
        : entry.name === 'flaky-report.json' ? join(dir, entry.name) : null;
      if (!file || !existsSync(file)) {continue;}
      try {
        cases.push(...(JSON.parse(readFileSync(file, 'utf-8')) as E2eCaseResult[]));
      } catch {
        // A crashed/partial shard shouldn't block ingesting the rest.
      }
    }
  }

  if (cases.length === 0) {
    // No flaky-report.json files found under any shard — most likely every
    // shard failed before Playwright's reporter ever ran. Don't push an
    // empty snapshot into history; it would silently dilute the flip-rate
    // window with a run that carried no real signal.

    return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `No flaky-report.json files were found under ${dir}.`, hint: 'Create or locate a flaky report, then rerun `kb qa e2e flaky list --ingest --dir <dir>`.' } };
  }

  const git = await captureGit(ctx.api.shell, cwd);
  const snap = store.saveE2eFlaky(cases, 0, git);
  ctx.ui?.success?.(`Ingested ${cases.length} e2e case result(s) from ${dir} into flaky history`, {});
  return snap;
}

async function runSync(ctx: PluginCommandContextV3, cwd: string): Promise<boolean> {
  const fetch = await ctx.api.shell.exec('git', ['fetch', 'origin', 'ci-data'], { cwd, throwOnError: false });
  if (!fetch.ok) {

    return false;
  }
  const show = await ctx.api.shell.exec(
    'git',
    ['show', `origin/ci-data:${PATHS.SNAPSHOTS_E2E_FLAKY}`],
    { cwd, throwOnError: false },
  );
  if (!show.ok) {

    return false;
  }
  const target = join(cwd, PATHS.SNAPSHOTS_E2E_FLAKY);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, show.stdout);
  return true;
}

export default defineCommand<unknown, CLIInput<QaE2eFlakyFlags>, unknown>({
  id: 'qa:e2e-flaky',
  description: 'Track flaky e2e cases across CI runs — compact overview by default, per-case drill-down on request',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaE2eFlakyFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);
      const json = flags.agent || flags.json;

      // --sync runs first so --ingest (if also passed) builds on the synced
      // history instead of silently ignoring --sync — the two compose rather
      // than one implicitly winning.
      if (flags.sync) {
        const synced = await runSync(ctx, cwd);
        if (!synced) {return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Flaky report sync failed.', hint: 'Check the configured CI repository and credentials, then rerun `kb qa e2e flaky list --sync`.' } };}
      }

      if (flags.ingest) {
        return runIngest(ctx, cwd, store, flags.ingest);
      }

      const history = store.loadE2eFlakyHistory();
      const window = flags.window ?? TRENDS_WINDOW;

      if (flags.case) {
        const timeline = buildCaseTimeline(history.slice(-window), flags.case);
        if (!timeline) {

          return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `No history was found for case "${flags.case}".`, hint: 'Run `kb qa e2e flaky list --agent` to list known cases, then rerun with a valid --case.' } };
        }
        if (json) {
          return timeline;
        } else {
          ctx.ui?.success?.(`Case timeline: ${timeline.caseKey}`, {
            sections: [
              { header: 'Summary', items: [
                `flakyScore: ${timeline.flakyScore}`,
                `streak: ${timeline.currentStreak.status} x${timeline.currentStreak.count}`,
                `firstFailure: ${timeline.firstFailure ?? 'none'}`,
              ] },
              { header: 'History', items: timeline.history.map(
                h => `${h.timestamp} [${h.gitCommit}] ${h.status}${h.errorCategory ? ` (${h.errorCategory}: ${h.errorMessage ?? ''})` : ''}`,
              ) },
            ],
          });
        }
        return {  };
      }

      const overview = analyzeFlakyCases(history, window);
      if (json) {
        return overview;
      } else {
        ctx.ui?.success?.(`E2E flaky overview (last ${overview.runsAnalyzed} runs)`, {
          sections: [
            { header: 'Summary', items: [
              `totalCases: ${overview.totalCases}, flakyCases: ${overview.flakyCases}`,
              `delta: +${overview.delta.new.length} new, -${overview.delta.fixed.length} fixed, ${overview.delta.unchanged.length} unchanged`,
            ] },
            { header: 'Top flaky cases', items: overview.top.map(
              t => `${t.case} — score ${t.flakyScore}, ${t.streak}, ${t.category}`,
            ) },
          ],
        });
      }
      return {  };
    },
  },
});
