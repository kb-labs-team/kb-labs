import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SnapshotStore, buildPackageTimeline } from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, unknown, { name?: string }>) {
    try {
      const config = await useConfig<QAPluginConfig>();
      const store = new SnapshotStore(ctx.cwd, config?.historyMaxEntries);

      const packageName = input.params?.name;
      if (!packageName) return { error: 'Package name is required' };

      const history = store.loadRunHistory();
      return buildPackageTimeline(history, packageName);
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
