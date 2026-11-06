import { defineHandler, rethrowForRest, useConfig, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { runKnip } from '../../core/index.js';
import { CACHE_KEYS, CACHE_TTLS, defaultQualityConfig, type QualityPluginConfig } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ refresh?: boolean }, unknown>) {
    try {
      const config = await useConfig<QualityPluginConfig>();
      const cfg = config ?? defaultQualityConfig;
      const cwd = ctx.cwd ?? process.cwd();
      const refresh = input.query?.refresh;

      if (!refresh) {
        const cached = await ctx.platform.cache.get(CACHE_KEYS.KNIP);
        if (cached) return cached;
      }

      if (!cfg.knip.enabled) {
        return { unusedFiles: [], unusedExports: [], unusedDependencies: [], unlistedDependencies: [], totalIssues: 0 };
      }

      const report = await runKnip({ shell: ctx.api.shell, rootDir: cwd });
      await ctx.platform.cache.set(CACHE_KEYS.KNIP, report, CACHE_TTLS.SLOW);
      return report;
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
