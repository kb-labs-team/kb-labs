/**
 * workflow:runs-rerun <runId> command — like `gh run rerun`
 *
 * Reruns a workflow by re-submitting it with the same inputs and trigger.
 * With --failed-only, only jobs that failed or were interrupted are requeued.
 */

import { defineCommand, validationError, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';

export interface RunsRerunFlags {
  'run-id'?: string;
  json?: boolean;
  'failed-only'?: boolean;
  'dry-run'?: boolean;
}

export default defineCommand<unknown, CLIInput<RunsRerunFlags>, unknown>({
  id: 'workflow:runs-rerun',
  description: 'Rerun a workflow run',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<RunsRerunFlags>) {
      const runId = input.flags?.['run-id'] ?? input.argv[0];
      const failedOnly = input.flags?.['failed-only'];
      return {
        summary: `Rerun workflow run ${runId ?? '(unknown)'}${failedOnly ? ' (failed jobs only)' : ''}`,
        operations: [{ type: 'create' as const, resource: 'workflow-run', details: { sourceRunId: runId, failedOnly } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsRerunFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const outputJson = flags?.json ?? false;
      const runId = flags?.['run-id'] ?? argv[0];

      if (!runId) {
        return validationError('Missing run ID', 'Usage: kb workflow runs-rerun <runId> [--run-id=<id>] [--failed-only]');
      }
      const failedOnly = flags?.['failed-only'] ?? false;

      try {
        const client = new WorkflowDaemonClient();

        const result = await client.rerunWorkflow(runId, { failedOnly });

        if (outputJson) {
          return result;
        } else {
          ctx.ui?.success?.('Workflow Rerun Triggered', {
            title: runId,
            sections: [
              {
                header: 'Details',
                items: [
                  `New run ID: ${result.runId}`,
                  `Status: ${result.status}`,
                  `Original run: ${runId}`,
                  ...(failedOnly ? ['Mode: failed jobs only'] : []),
                  ``,
                  `Watch: kb workflow runs-watch ${result.runId}`,
                  `View:  kb workflow runs-view ${result.runId}`,
                ],
              },
            ],
          });
        }

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
