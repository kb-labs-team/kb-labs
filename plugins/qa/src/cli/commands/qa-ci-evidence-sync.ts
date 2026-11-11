import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand, useConfig, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { GithubActionsProvider } from '../../core/index.js';
import type { QAPluginConfig } from '../../contracts/index.js';
import type { QaCiEvidenceSyncFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaCiEvidenceSyncFlags>, unknown>({
  id: 'qa:ci-evidence-sync',
  description: 'Download new CI evidence artifacts into the local QA cache',
  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCiEvidenceSyncFlags>): Promise<CommandResult> {
      const config = await useConfig<QAPluginConfig>();
      const repository = input.flags.repository ?? config?.ci?.repository ?? process.env.GITHUB_REPOSITORY;
      if (!repository) {

        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'GitHub repository and run ID are required', hint: 'Run `kb qa --help` to review the command inputs, then rerun the command.' } };
      }
      const cwd = ctx.cwd ?? process.cwd();
      const output = resolve(cwd, input.flags.output);
      mkdirSync(output, { recursive: true });
      try {
        const result = await new GithubActionsProvider(ctx.api.shell, cwd).syncDossiers({
          repository, workflow: input.flags.workflow, limit: input.flags.limit, outputDir: output,
        });
        if (input.flags.json) {
          return result;
        } else {
          ctx.ui?.success?.('Synced CI evidence', {
            sections: [{ header: 'Runs', items: [
              `downloaded: ${result.downloadedRunIds.length}`,
              `cached: ${result.cachedRunIds.length}`,
              `unavailable: ${result.unavailableRunIds.length}`,
              `cache: ${output}`,
            ] }],
          });
        }
        return {  };
      } catch (error) {

        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), hint: 'Run `kb qa --help` to review the command inputs, then rerun the command.' } };
      }
    },
  },
});
