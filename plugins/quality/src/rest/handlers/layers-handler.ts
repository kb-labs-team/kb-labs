import { defineHandler, rethrowForRest, useConfig, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { analyzeLayering } from '../../core/index.js';
import { CACHE_KEYS, CACHE_TTLS, defaultQualityConfig, type QualityPluginConfig } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ refresh?: boolean }, unknown>) {
    try {
      const config = await useConfig<QualityPluginConfig>();
      const cfg = config ?? defaultQualityConfig;
      const cwd = ctx.cwd ?? process.cwd();
      const refresh = input.query?.refresh;

      if (!refresh) {
        const cached = await ctx.platform.cache.get(CACHE_KEYS.LAYERS);
        if (cached) return cached;
      }

      const report = await analyzeLayering({ rootDir: cwd, layerMap: cfg.layers });
      await ctx.platform.cache.set(CACHE_KEYS.LAYERS, report, CACHE_TTLS.FAST);
      return report;
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
