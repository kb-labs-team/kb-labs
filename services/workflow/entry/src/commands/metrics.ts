/**
 * workflow:metrics command - Get workflow metrics
 */

import { defineCommand, handleError, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { type MetricsFlags } from '@kb-labs/workflow-contracts';
import { WorkflowDaemonClient } from '../http-client.js';

type MetricsInput = MetricsFlags & { argv?: string[]; flags?: MetricsFlags };

export default defineCommand<unknown, MetricsInput, unknown>({
  id: 'workflow:metrics',
  description: 'Get workflow daemon metrics',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: MetricsInput): Promise<CommandResult> {
      const flags = input.flags ?? input;
      const outputJson = flags.json ?? false;

      try {
        const client = new WorkflowDaemonClient();
        const metrics = await client.getMetrics();

        if (outputJson) {
          return metrics;
        } else {
          const runsItems = [
            `Total: ${metrics.runs.total}`,
            `Queued: ${metrics.runs.queued}`,
            `Running: ${metrics.runs.running}`,
            `Success: ${metrics.runs.success}`,
            `Failed: ${metrics.runs.failed}`,
            `Cancelled: ${metrics.runs.cancelled}`,
          ];

          const jobsItems = [
            `Total: ${metrics.jobs.total}`,
            `Queued: ${metrics.jobs.queued}`,
            `Running: ${metrics.jobs.running}`,
            `Success: ${metrics.jobs.success}`,
            `Failed: ${metrics.jobs.failed}`,
          ];

          ctx.ui?.success?.('Workflow Metrics', {
            title: 'Workflow Daemon',
            sections: [
              { header: 'Runs', items: runsItems },
              { header: 'Jobs', items: jobsItems },
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
