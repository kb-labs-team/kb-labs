import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { DevkitAdapter, SnapshotStore, resolveDevkitBin, captureGit } from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput) {
    try {
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd;

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const git = await captureGit(ctx.api.shell, cwd);
      const [check, stats] = await Promise.all([adapter.check(), adapter.stats()]);
      const baseline = store.saveBaseline(check, stats, git);

      return { baseline, ok: true };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
