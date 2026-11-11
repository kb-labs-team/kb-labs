import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import {
  DevkitAdapter,
  SnapshotStore,
  resolveDevkitBin,
  captureGit,
  buildStatsReport,
  buildStatsJsonReport,
} from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';
import type { QaStatsFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaStatsFlags>, unknown>({
  id: 'qa:stats',
  description: 'Show devkit health score and category breakdown',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaStatsFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const save = flags.save !== false;
      const git = await captureGit(ctx.api.shell, cwd);

      const start = Date.now();
      const raw = await adapter.stats();
      const durationMs = Date.now() - start;

      const snap = save ? store.saveStats(raw, durationMs, git) : null;
      const effective: import('../../contracts/index.js').StatsSnapshot = snap ?? {
        kind: 'stats', id: '', timestamp: new Date().toISOString(), durationMs, raw,
      };

      if (flags.json) {
        return buildStatsJsonReport(effective);
      } else {
        for (const section of buildStatsReport(effective)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return {  };
    },
  },
});
