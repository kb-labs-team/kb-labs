import { defineHandler, rethrowForRest, useCache, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { calculateStats } from '../../core/stats/index.js';

const CACHE_KEY = 'quality:stats';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface StatsResult {
  packages: number;
  loc: number;
  size: string;
}

export default defineHandler({
  async execute(ctx: PluginContextV3, _input: RestInput<unknown, unknown>) {
    try {
      const cache = useCache();

      if (cache) {
        const cached = await cache.get<StatsResult>(CACHE_KEY);
        if (cached) return cached;
      }

      const stats = await calculateStats(ctx.cwd);
      const result: StatsResult = {
        packages: stats.packages,
        loc: stats.loc,
        size: stats.sizeFormatted,
      };

      if (cache) {
        await cache.set(CACHE_KEY, result, CACHE_TTL_MS);
      }

      return result;
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
