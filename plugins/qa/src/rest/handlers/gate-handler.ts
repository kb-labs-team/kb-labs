import { defineHandler, useConfig, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { DevkitAdapter, SnapshotStore, resolveDevkitBin, captureGit } from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';

interface GateBody {
  save?: boolean;
}

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, GateBody>) {
    try {
      const { save = false } = input.body ?? {};
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd;

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const git = await captureGit(ctx.api.shell, cwd);

      const start = Date.now();
      const raw = await adapter.gate();
      const durationMs = Date.now() - start;

      if (save) store.saveGate(raw, durationMs, git);
      return { raw, ok: raw.ok };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
