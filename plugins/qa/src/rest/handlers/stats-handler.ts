import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SnapshotStore } from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput) {
    try {
      const config = await useConfig<QAPluginConfig>();
      const store = new SnapshotStore(ctx.cwd, config?.historyMaxEntries);
      const snap = store.latestStats();

      if (!snap) return { snapshot: null };
      return { snapshot: snap };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
