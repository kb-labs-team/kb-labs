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
  buildBaselineReport,
} from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';
import type { BaselineUpdateFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<BaselineUpdateFlags>, unknown>({
  id: 'qa:baseline:update',
  description: 'Run check + stats and save as new baseline',

  handler: {
    async intent(_ctx: PluginCommandContextV3, _input: CLIInput<BaselineUpdateFlags>) {
      return {
        summary: 'Run QA check + stats and save as new baseline',
        operations: [
          { type: 'create' as const, resource: 'file', details: { path: '.kb/qa/baseline.json' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<BaselineUpdateFlags>): Promise<CommandResult> {
      const { flags } = input;
      if (flags['dry-run']) {
        const result = { dryRun: true, operations: [{ type: 'create', resource: 'file', path: '.kb/qa/baseline.json' }] };
        if (flags.json) return result;
        else ctx.ui?.info?.('Dry-run: would run QA check and stats, then save .kb/qa/baseline.json.');
        return result;
      }
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const git = await captureGit(ctx.api.shell, cwd);

      const [check, stats] = await Promise.all([adapter.check(), adapter.stats()]);
      const baseline = store.saveBaseline(check, stats, git);

      if (flags.json) {
        return baseline;
      } else {
        for (const section of buildBaselineReport(baseline)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return {  };
    },
  },
});
