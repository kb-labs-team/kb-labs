import {
  defineCommand,
  useConfig,
  type CLIInput,
  type PluginCommandContextV3,
  type CommandResult,
} from '@kb-labs/sdk';
import { runKnip } from '../../core/index.js';
import { defaultQualityConfig, type QualityPluginConfig } from '../../contracts/index.js';
import type { DeadCodeFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<DeadCodeFlags>, unknown>({
  id: 'quality:dead-code',
  description: 'Detect unused files, exports, and deps via knip',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<DeadCodeFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QualityPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();
      const cfg = config ?? defaultQualityConfig;

      if (!cfg.knip.enabled) {
        ctx.ui?.success?.('knip is disabled in config (knip.enabled = false)');
        return {  };
      }

      const report = await runKnip({ shell: ctx.api.shell, rootDir: cwd });

      if (report.totalIssues === 0) {
        if (!flags.json) { ctx.ui?.success?.('No dead code detected'); }
        return flags.json ? report : {};
      }

      return {
        ok: false,
        error: {
          code: 'KB_RUNTIME_COMMAND_FAILED',
          message: `${report.totalIssues} dead code issue(s) found.`,
          hint: 'Review the reported unused files and dependencies, then rerun `kb quality dead-code`.',
          diagnostics: report.unusedFiles.map((file) => ({ code: 'KB_QUALITY_UNUSED_FILE', severity: 'warning' as const, path: file, message: 'File is unused.' }))
            .concat(report.unusedExports.map((entry) => ({ code: 'KB_QUALITY_UNUSED_EXPORT', severity: 'warning' as const, path: entry.file, message: `Unused export: ${entry.symbol}` }))),
        },
      };
    },
  },
});
