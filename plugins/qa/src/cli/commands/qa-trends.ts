import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import {
  SnapshotStore,
  analyzeTrends,
  buildTrendsReport,
} from '../../core/index.js';
import { TRENDS_WINDOW, type QAPluginConfig } from '../../contracts/index.js';
import type { QaTrendsFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaTrendsFlags>, unknown>({
  id: 'qa:trends',
  description: 'Show QA quality trends over time',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaTrendsFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const store = new SnapshotStore(cwd, config?.historyMaxEntries);
      const window = flags.window ?? TRENDS_WINDOW;
      const history = store.loadRunHistory();
      const analysis = analyzeTrends(history, window);

      if (flags.json) {
        return analysis;
      } else {
        for (const section of buildTrendsReport(analysis)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return {  };
    },
  },
});
