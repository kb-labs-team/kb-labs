import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import {
  SnapshotStore,
  buildHistoryTable,
} from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';
import type { QaHistoryFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaHistoryFlags>, unknown>({
  id: 'qa:history',
  description: 'Show QA run history',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaHistoryFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const store = new SnapshotStore(cwd, config?.historyMaxEntries);
      const limit = flags.limit ?? 20;
      const history = store.loadRunHistory();

      if (flags.json) {
        return [...history].reverse().slice(0, limit);
      } else {
        for (const section of buildHistoryTable(history, limit)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return {  };
    },
  },
});
