import { defineHandler, rethrowForRest, useConfig, type PluginContextV3, type RestInput, type ShellAPI } from '@kb-labs/sdk';
import {
  analyzeLayering,
  analyzeCoupling,
  runKnip,
  analyzeTypes,
  calculateHealth,
  QualitySnapshotStore,
} from '../../core/index.js';
import { defaultQualityConfig, type QualityPluginConfig, type KnipReport } from '../../contracts/index.js';

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

export default defineHandler({
  async execute(ctx: PluginContextV3, _input: RestInput<unknown, unknown>) {
    try {
      const config = await useConfig<QualityPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();
      const cfg = config ?? defaultQualityConfig;

      const [layering, types, git] = await Promise.all([
        analyzeLayering({ rootDir: cwd, layerMap: cfg.layers }),
        analyzeTypes(cwd),
        captureGit(ctx.api.shell, cwd),
      ]);

      const coupling = analyzeCoupling({ rootDir: cwd, layerMap: cfg.layers });

      let knip: KnipReport = { unusedFiles: [], unusedExports: [], unusedDependencies: [], unlistedDependencies: [], totalIssues: 0 };
      if (cfg.knip.enabled) {
        knip = await runKnip({ shell: ctx.api.shell, rootDir: cwd });
      }

      const health = calculateHealth({
        layering, coupling, types, knip,
        totalPackages: coupling.packages.length,
        avgTestCoverage: null,
        thresholds: cfg.thresholds,
      });

      const store = new QualitySnapshotStore(cwd, cfg.maxSnapshots);
      return store.save({
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
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
