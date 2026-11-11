import {
  defineCommand,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import { calculateStats } from '../../core/index.js';
import type { StatsFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<StatsFlags>, unknown>({
  id: 'quality:stats',
  description: 'Monorepo statistics: packages, lines of code, size',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<StatsFlags>): Promise<CommandResult> {
      const { flags } = input;
      const cwd = ctx.cwd ?? process.cwd();

      const stats = await calculateStats(cwd);

      if (flags.json) {
        return stats;
      }

      ctx.ui?.success?.('Monorepo statistics', {
        sections: [{
          header: 'Overview',
          items: [
            `Packages: ${stats.packages}`,
            `Lines of code: ${stats.loc.toLocaleString()}`,
            `Size: ${stats.sizeFormatted}`,
          ],
        }],
      });

      return {  };
    },
  },
});
