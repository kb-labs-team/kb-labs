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
  buildRunReport,
  buildRunJsonReport,
} from '../../core/index.js';
import { DEFAULT_TASKS, type QAPluginConfig } from '../../contracts/index.js';
import type { QaRunFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaRunFlags>, unknown>({
  id: 'qa:run',
  description: 'Run devkit tasks and record results',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaRunFlags>): Promise<CommandResult> {
      const { flags } = input;
      const config = await useConfig<QAPluginConfig>();
      const cwd = ctx.cwd ?? process.cwd();

      const binaryPath = resolveDevkitBin(cwd, config?.devkitPath);
      const adapter = new DevkitAdapter({ binaryPath, cwd, shell: ctx.api.shell });
      const store = new SnapshotStore(cwd, config?.historyMaxEntries);

      const tasks: string[] = flags.tasks
        ? flags.tasks.split(',').map(s => s.trim()).filter(Boolean)
        : config?.defaultTasks?.slice() ?? [...DEFAULT_TASKS];
      const save = flags.save !== false;

      const git = await captureGit(ctx.api.shell, cwd);

      const start = Date.now();
      const raw = await adapter.run(tasks);
      const durationMs = Date.now() - start;

      const snap = save ? store.saveRun(raw, tasks, durationMs, git) : null;
      const effective: import('../../contracts/index.js').RunSnapshot = snap ?? {
        kind: 'run', id: '', timestamp: new Date().toISOString(), durationMs, tasks, raw,
      };

      const result = raw.ok ? raw : {
        ok: false as const,
        error: {
          code: 'KB_RUNTIME_COMMAND_FAILED',
          message: 'QA run failed',
          hint: 'Review failed task output, then rerun `kb qa run`.',
          diagnostics: raw.results.filter((task) => !task.OK).map((task) => ({
            code: 'KB_QA_TASK_FAILED',
            severity: 'error',
            path: task.Package,
            message: task.Error || task.Stderr || `Task ${task.Task} exited ${task.ExitCode}.`,
          })),
        },
      };

      if (flags.json) {
        return raw.ok ? buildRunJsonReport(effective) : result;
      } else {
        for (const section of buildRunReport(effective)) {
          ctx.ui?.success?.(`${section.header}`, { sections: [{ items: section.lines }] });
        }
      }

      return result;
    },
  },
});
