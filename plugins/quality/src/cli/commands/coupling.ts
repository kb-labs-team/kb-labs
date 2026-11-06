import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import { analyzeCoupling } from '../../core/index.js';
import { type QualityPluginConfig } from '../../contracts/index.js';
import type { CouplingFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<CouplingFlags>, unknown>({
  id: 'quality:coupling',
  description: 'Show coupling metrics per package (afferent/efferent/instability)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<CouplingFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QualityPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const report = analyzeCoupling({ rootDir: cwd, layerMap: config?.layers, topN: flags.top });

      if (flags.json) {
        return report;
      }

      const sorted =
        flags.sort === 'coupled'
          ? [...report.packages].sort((a, b) => b.afferent + b.efferent - (a.afferent + a.efferent))
          : [...report.packages].sort((a, b) => b.instability - a.instability);

      const top = sorted.slice(0, flags.top ?? 10);
      const threshold = config?.thresholds?.instability ?? 0.85;

      const items = top.map(p => {
        const warn = p.instability > threshold ? ' ⚠ unstable' : '';
        return `${p.name}  Ca: ${p.afferent}  Ce: ${p.efferent}  I: ${p.instability.toFixed(2)}${warn}`;
      });

      ctx.ui?.success?.(`Coupling — avg instability: ${report.avgInstability.toFixed(2)}`, {
        sections: [{ header: `Top ${top.length} by instability`, items }],
      });

      return {  };
    },
  },
});
