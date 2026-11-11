import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { DevkitAdapter, SnapshotStore, resolveDevkitBin, captureGit } from '../../core/index.js';
import { DEFAULT_TASKS, type QAPluginConfig } from '../../contracts/index.js';

interface RunBody {
  tasks?: string[];
  save?: boolean;
  runContext?: Record<string, unknown>;
}

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, RunBody>) {
    try {
      const { tasks, save = true, runContext } = input.body ?? {};
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd;

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const effectiveTasks = tasks ?? config?.defaultTasks ?? [...DEFAULT_TASKS];
      const git = await captureGit(ctx.api.shell, cwd);

      const start = Date.now();
      const raw = await adapter.run(effectiveTasks);
      const durationMs = Date.now() - start;

      const snap = save ? store.saveRun(raw, effectiveTasks, durationMs, git, runContext) : null;
      return { snapshot: snap, raw, ok: raw.ok };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
