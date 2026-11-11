import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineCommand, useConfig, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { GithubActionsProvider } from '../../core/index.js';
import type { QAPluginConfig } from '../../contracts/index.js';
import type { QaCiEvidenceCaptureFlags } from './flags.js';

export default defineCommand<unknown, CLIInput<QaCiEvidenceCaptureFlags>, unknown>({
  id: 'qa:ci-evidence-capture',
  description: 'Capture a compact GitHub Actions run dossier for later QA analysis',
  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCiEvidenceCaptureFlags>): Promise<CommandResult> {
      const config = await useConfig<QAPluginConfig>();
      const repository = input.flags.repository ?? config?.ci?.repository ?? process.env.GITHUB_REPOSITORY;
      const runId = input.flags['run-id'] ?? process.env.GITHUB_RUN_ID;
      if (!repository || !runId) {

        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'GitHub repository and run ID are required', hint: 'Run `kb qa --help` to review the command inputs, then rerun the command.' } };
      }
      try {
        const cwd = ctx.cwd ?? process.cwd();
        const provider = new GithubActionsProvider(ctx.api.shell, cwd);
        const excludeJobNames = input.flags['exclude-job']
          ?.split(',')
          .map(name => name.trim())
          .filter(Boolean);
        const dossier = await provider.captureRun({
          repository,
          runId,
          workflowPath: process.env.GITHUB_WORKFLOW_REF?.split('@')[0],
          workflowSha: process.env.GITHUB_SHA,
          excludeJobNames,
        });
        const output = resolve(cwd, input.flags.output);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(dossier, null, 2)}\n`);
        if (input.flags.json) {
          return dossier;
        } else {
          ctx.ui?.success?.(`Captured CI evidence for run ${dossier.run.id}`, {
            sections: [
              { header: 'Evidence', items: [
                `workflow: ${dossier.workflow.name}`,
                `jobs: ${dossier.jobs.length}`,
                `collection: ${dossier.collectionStatus}`,
                `saved: ${output}`,
              ] },
            ],
          });
        }
        return {  };
      } catch (error) {

        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), hint: 'Run `kb qa --help` to review the command inputs, then rerun the command.' } };
      }
    },
  },
});
