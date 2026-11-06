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
  buildCheckReport,
  buildCheckJsonReport,
} from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';
import type { QaCheckFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaCheckFlags>, unknown>({
  id: 'qa:check',
  description: 'Run devkit structural checks',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCheckFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const save = flags.save !== false;
      const git = await captureGit(ctx.api.shell, cwd);

      const start = Date.now();
      const raw = await adapter.check();
      const durationMs = Date.now() - start;

      const snap = save ? store.saveCheck(raw, durationMs, git) : null;
      const effective: import('../../contracts/index.js').CheckSnapshot = snap ?? {
        kind: 'check', id: '', timestamp: new Date().toISOString(), durationMs, raw,
      };

      const result = raw.ok ? raw : {
        ok: false as const,
        error: {
          code: 'KB_RUNTIME_COMMAND_FAILED',
          message: 'QA check failed',
          hint: 'Review the reported QA check issues, then rerun `kb qa check run`.',
          diagnostics: Object.entries(raw.packages).flatMap(([name, pkg]) => (pkg.issues ?? []).map((issue) => ({
            code: `KB_QA_${issue.check.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
            severity: issue.severity,
            path: issue.file ?? name,
            message: issue.message,
          }))),
        },
      };

      if (flags.json) {
        return raw.ok ? buildCheckJsonReport(effective) : result;
      } else {
        for (const section of buildCheckReport(effective)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return result;
    },
  },
});
