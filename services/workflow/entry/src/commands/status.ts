/**
 * workflow job status command - Get raw job status
 */

import { defineCommand, validationError, handleError, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';

type StatusInput = { json?: boolean; argv?: string[]; flags?: { json?: boolean } };

export default defineCommand<unknown, StatusInput, unknown>({
  id: 'workflow:job-status',
  description: 'Get status of a workflow job',

  handler: {
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Job status display with deep run/job/step traversal, multiple output formats (JSON/human), timing calculations, status color coding, and error aggregation
    async execute(ctx: PluginCommandContextV3, input: StatusInput): Promise<CommandResult> {
      const flags = input.flags ?? input;
      const outputJson = flags.json ?? false;
      const jobId = input.argv?.[0];

      if (!jobId) {
        return validationError('Missing job ID', 'Usage: kb workflow job status <jobId>');
      }

      try {
        const client = new WorkflowDaemonClient();
        const status = await client.getJobStatus(jobId);

        if (outputJson) {
          return status;
        } else {
          const statusItems = [
            `ID: ${status.id}`,
            `Status: ${status.status}`,
            `Type: ${status.type || 'N/A'}`,
            `Started: ${status.startedAt || 'N/A'}`,
            `Finished: ${status.finishedAt || 'N/A'}`,
          ];

          // Add error if present
          if (status.error) {
            statusItems.push(`Error: ${status.error}`);
          }

          // Add result summary if present
          if (status.result?.summary) {
            statusItems.push(`Summary: ${status.result.summary}`);
          }

          const sections: Array<{ header: string; items: string[] }> = [
            { header: 'Details', items: statusItems },
          ];

          // Add jobs and steps details
          if (status.jobs && status.jobs.length > 0) {
            for (const job of status.jobs) {
              const jobItems = [
                `Status: ${job.status}`,
                `Duration: ${job.durationMs ? `${job.durationMs}ms` : 'N/A'}`,
              ];

              if (job.error) {
                jobItems.push(`Error: ${job.error}`);
              }

              sections.push({ header: `Job: ${job.name}`, items: jobItems });

              // Add steps for this job
              if (job.steps && job.steps.length > 0) {
                const stepItems: string[] = [];
                for (const step of job.steps) {
                  const statusIcon = step.status === 'success' ? '✓' : step.status === 'failed' ? '✗' : '○';
                  const duration = step.durationMs ? ` (${step.durationMs}ms)` : '';
                  stepItems.push(`${statusIcon} ${step.name}: ${step.status}${duration}`);

                  // Show outputs if present
                  if (step.outputs && Object.keys(step.outputs).length > 0) {
                    const outputStr = JSON.stringify(step.outputs, null, 2);
                    // Truncate long outputs
                    const truncated = outputStr.length > 500 ? outputStr.slice(0, 500) + '...' : outputStr;
                    stepItems.push(`  └─ Output: ${truncated}`);
                  }

                  // Show error if present
                  if (step.error) {
                    const errorMsg = typeof step.error === 'string' ? step.error : step.error?.message ?? String(step.error);
                    stepItems.push(`  └─ Error: ${errorMsg}`);
                  }
                }
                sections.push({ header: `  Steps (${job.steps.length})`, items: stepItems });
              }
            }
          }

          ctx.ui?.success?.('Job Status Retrieved', {
            title: 'Workflow Job',
            sections,
          });
        }

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
