/**
 * workflow:runs-cancel <runId> command — cancel an active workflow run
 */

import { defineCommand, validationError, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';
import type { RunsCancelFlags } from '@kb-labs/workflow-contracts';

export default defineCommand<unknown, CLIInput<RunsCancelFlags>, unknown>({
  id: 'workflow:runs-cancel',
  description: 'Cancel a workflow run',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<RunsCancelFlags>) {
      const runId = input.flags?.['run-id'] ?? input.argv[0];
      return {
        summary: `Cancel workflow run ${runId ?? '(unknown)'}`,
        operations: [{ type: 'delete' as const, resource: 'workflow-run', details: { runId } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsCancelFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const outputJson = flags?.json ?? false;
      const runId = flags?.['run-id'] ?? argv[0];

      if (!runId) {
        return validationError('Missing run ID', 'Usage: kb workflow runs cancel <runId> [--run-id=<id>]');
      }

      try {
        const client = new WorkflowDaemonClient();
        await client.cancelRun(runId);

        if (outputJson) {
          return { runId, cancelled: true };
        } else {
          ctx.ui?.success?.('Cancellation Requested', {
            title: runId,
            sections: [
              {
                header: 'Details',
                items: [
                  `Run ID: ${runId}`,
                  `Status: cancellation requested`,
                  ``,
                  `View: kb workflow runs view ${runId}`,
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
