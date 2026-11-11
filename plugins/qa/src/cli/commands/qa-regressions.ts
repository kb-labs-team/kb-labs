import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import {
  SnapshotStore,
  detectRegressions,
  buildRegressionsReport,
} from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';
import type { QaRegressionsFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaRegressionsFlags>, unknown>({
  id: 'qa:regressions',
  description: 'Detect regressions since last run',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaRegressionsFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const store = new SnapshotStore(cwd, config?.historyMaxEntries);
      const history = store.loadRunHistory();
      const detection = detectRegressions(history);
      const result = detection.hasRegressions
        ? { ok: false as const, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Regressions found', hint: 'Review the regression report, then rerun `kb qa regressions list`.' } }
        : detection;

      if (!flags.json) {
        for (const section of buildRegressionsReport(detection)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return result;
    },
  },
});
