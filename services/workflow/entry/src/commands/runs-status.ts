/**
 * workflow:runs-status <runId> command — show status summary for a workflow run
 */

import { defineCommand, validationError, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';
import type { RunsStatusFlags } from '@kb-labs/workflow-contracts';

const STEP_ICON: Record<string, string> = {
  success: '✓',
  failed: '✗',
  running: '◆',
  queued: '○',
  cancelled: '⊘',
  waiting_approval: '…',
  waiting_child: '…',
  interrupted: '‖',
  skipped: '⊙',
};

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) { return 'N/A'; }
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export default defineCommand<unknown, CLIInput<RunsStatusFlags>, unknown>({
  id: 'workflow:runs-status',
  description: 'Show status summary for a workflow run',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsStatusFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const outputJson = flags?.json ?? false;
      const runId = flags?.['run-id'] ?? argv[0];

      if (!runId) {
        return validationError('Missing run ID', 'Usage: kb workflow runs status <runId>');
      }

      try {
        const client = new WorkflowDaemonClient();
        const run = await client.getRun(runId);

        if (outputJson) {
          return run;
        }

        const trigger = run.trigger
          ? `${run.trigger.type} by ${run.trigger.actor ?? 'unknown'}`
          : 'manual';

        const summaryItems = [
          `ID:       ${run.id}`,
          `Status:   ${run.status.toUpperCase()}`,
          `Workflow: ${run.name}`,
          `Trigger:  ${trigger}`,
          `Started:  ${run.startedAt ?? 'N/A'}`,
          `Finished: ${run.finishedAt ?? 'N/A'}`,
          `Duration: ${formatDuration(run.durationMs)}`,
        ];

        if (run.result?.error) {
          summaryItems.push(`Error:    ${run.result.error.message}`);
        }

        const sections: Array<{ header: string; items: string[] }> = [
          { header: 'Run', items: summaryItems },
        ];

        if (run.jobs && run.jobs.length > 0) {
          for (const job of run.jobs) {
            const icon = STEP_ICON[job.status] ?? '?';
            const jobItems = [
              `Status:   ${icon} ${job.status}`,
              `Duration: ${formatDuration(job.durationMs)}`,
            ];

            const jobError = typeof job.error === 'string' ? job.error : job.error?.message;
            if (jobError) { jobItems.push(`Error:    ${jobError}`); }

            if (job.steps && job.steps.length > 0) {
              for (const step of job.steps) {
                const stepIcon = STEP_ICON[step.status] ?? '?';
                const dur = step.durationMs !== undefined ? ` (${formatDuration(step.durationMs)})` : '';
                jobItems.push(`  ${stepIcon} ${step.name ?? step.id}: ${step.status}${dur}`);
              }
            }

            sections.push({ header: `Job: ${job.jobName ?? job.id}`, items: jobItems });
          }
        }

        ctx.ui?.success?.('Run Status', { title: run.name, sections });
        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
