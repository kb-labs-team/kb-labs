import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SnapshotStore, compareWithBaseline } from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput) {
    try {
      const config = await useConfig<QAPluginConfig>();
      const store = new SnapshotStore(ctx.cwd, config?.historyMaxEntries);

      const baseline = store.loadBaseline();
      if (!baseline) return { error: 'no-baseline' as const };

      const latestCheck = store.latestCheck();
      if (!latestCheck) return { error: 'no-check' as const };

      const latestStats = store.latestStats();
      if (!latestStats) return { error: 'no-stats' as const };

      return compareWithBaseline(latestCheck.raw, latestStats.raw, baseline);
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
