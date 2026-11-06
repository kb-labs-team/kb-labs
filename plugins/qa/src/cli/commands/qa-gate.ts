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
} from '../../core/index.js';
import { type QAPluginConfig } from '../../contracts/index.js';
import type { QaGateFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaGateFlags>, unknown>({
  id: 'qa:gate',
  description: 'Run pre-commit gate check (exits 1 if violations found)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaGateFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const git = await captureGit(ctx.api.shell, cwd);

      const start = Date.now();
      const raw = await adapter.gate();
      const durationMs = Date.now() - start;

      if (flags.save) store.saveGate(raw, durationMs, git);

      const result = raw.ok ? raw : {
        ok: false as const,
        error: {
          code: 'KB_RUNTIME_COMMAND_FAILED',
          message: 'QA gate failed',
          hint: 'Review the reported gate violations, then rerun `kb qa gate run`.',
          diagnostics: raw.violations.map((violation) => ({
            code: 'KB_QA_GATE_VIOLATION',
            severity: violation.severity,
            path: violation.package,
            message: `${violation.check}: ${violation.message}`,
          })),
        },
      };

      if (!flags.json && raw.ok) {
        ctx.ui?.success?.(`Gate passed. ${raw.staged_files} staged file(s), no violations.`);
      }

      return result;
    },
  },
});
