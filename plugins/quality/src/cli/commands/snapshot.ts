import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import {
  analyzeLayering,
  analyzeCoupling,
  runKnip,
  analyzeTypes,
  QualitySnapshotStore,
} from '../../core/index.js';
import { calculateHealth } from '../../core/index.js';
import { defaultQualityConfig, type QualityPluginConfig, type KnipReport } from '../../contracts/index.js';
import type { SnapshotFlags } from './flags.js';
import type { ShellAPI } from '@kb-labs/sdk';

async function captureGit(shell: ShellAPI, cwd: string) {
  try {
    const [c, b, m] = await Promise.all([
      shell.exec('git', ['rev-parse', '--short', 'HEAD'], { cwd, throwOnError: false }),
      shell.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, throwOnError: false }),
      shell.exec('git', ['log', '-1', '--format=%s'], { cwd, throwOnError: false }),
    ]);
    if (!c.ok) return undefined;
    return { commit: c.stdout.trim(), branch: b.stdout.trim() || 'HEAD', message: m.stdout.trim() };
  } catch {
    return undefined;
  }
}

export default defineCommand<unknown, CLIInput<SnapshotFlags>, unknown>({
  id: 'quality:snapshot',
  description: 'Collect all quality metrics and save a snapshot for trend tracking',

  handler: {
    async intent(_ctx: PluginCommandContextV3, _input: CLIInput<SnapshotFlags>) {
      return {
        summary: 'Collect all quality metrics and save snapshot for trend tracking',
        operations: [
          { type: 'create' as const, resource: 'file', details: { path: '.kb/quality/snapshots/<timestamp>.json' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<SnapshotFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QualityPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();
      const cfg = config ?? defaultQualityConfig;

      ctx.ui?.success?.('Collecting quality metrics…');

      const [layering, coupling, types, git] = await Promise.all([
        analyzeLayering({ rootDir: cwd, layerMap: cfg.layers }),
        Promise.resolve(analyzeCoupling({ rootDir: cwd, layerMap: cfg.layers })),
        analyzeTypes(cwd),
        captureGit(ctx.api.shell, cwd),
      ]);

      let knip: KnipReport = { unusedFiles: [], unusedExports: [], unusedDependencies: [], unlistedDependencies: [], totalIssues: 0 };
      if (cfg.knip.enabled) {
        knip = await runKnip({ shell: ctx.api.shell, rootDir: cwd });
      }

      const totalPackages = coupling.packages.length;
      const health = calculateHealth({
        layering,
        coupling,
        types,
        knip,
        totalPackages,
        avgTestCoverage: null,
        thresholds: cfg.thresholds,
      });

      const store = new QualitySnapshotStore(cwd, cfg.maxSnapshots);
      const snap = store.save({
        score: health.score,
        grade: health.grade,
        dimensions: health.dimensions,
        counters: {
          layeringViolations: layering.totalViolations,
          avgInstability: coupling.avgInstability,
          anyCount: types.packages.reduce((s: number, p: { anyCount: number }) => s + p.anyCount, 0),
          tsIgnoreCount: types.packages.reduce((s: number, p: { tsIgnoreCount: number }) => s + p.tsIgnoreCount, 0),
          unusedFiles: knip.unusedFiles.length,
          unusedDeps: knip.unusedDependencies.length,
        },
        git: git ?? { commit: '', branch: '', message: '' },
      });

      if (!flags.json) {
        ctx.ui?.success?.(`Snapshot saved: score ${snap.score}/100 (${snap.grade})`, {
          sections: [{
            header: 'Dimensions',
            items: Object.entries(snap.dimensions).map(
              ([k, d]) => `${k}  ${d.score}/100 (${d.grade})`
            ),
          }],
        });
      }

      return snap;
    },
  },
});
