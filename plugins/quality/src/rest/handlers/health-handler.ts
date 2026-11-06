import { defineHandler, rethrowForRest, useConfig, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  analyzeLayering,
  analyzeCoupling,
  runKnip,
  analyzeTypes,
  calculateHealth,
} from '../../core/index.js';
import { CACHE_KEYS, CACHE_TTLS, defaultQualityConfig, type QualityPluginConfig, type KnipReport } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ refresh?: boolean }, unknown>) {
    try {
      const config = await useConfig<QualityPluginConfig>();
      const cfg = config ?? defaultQualityConfig;
      const cwd = ctx.cwd ?? process.cwd();
      const refresh = input.query?.refresh;

      if (!refresh) {
        const cached = await ctx.platform.cache.get(CACHE_KEYS.HEALTH);
        if (cached) return cached;
      }

      const [layering, types] = await Promise.all([
        analyzeLayering({ rootDir: cwd, layerMap: cfg.layers }),
        analyzeTypes(cwd),
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

      await ctx.platform.cache.set(CACHE_KEYS.HEALTH, health, CACHE_TTLS.FAST);
      return health;
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
