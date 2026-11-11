/**
 * workflow:runs-list command — like `gh run list`
 */

import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';

export interface RunsListFlags {
  json?: boolean;
  status?: string;
  limit?: number;
  workflow?: string;
}

const STATUS_ICON: Record<string, string> = {
  success: '✓',
  failed: '✗',
  running: '◆',
  queued: '○',
  cancelled: '⊘',
  waiting_approval: '…',
};

function relativeTime(isoStr?: string): string {
  if (!isoStr) { return 'N/A'; }
  const diffMs = Date.now() - new Date(isoStr).getTime();
  if (diffMs <= 0) { return 'just now'; }
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) { return `${sec}s ago`; }
  const min = Math.floor(sec / 60);
  if (min < 60) { return `${min}m ago`; }
  const hr = Math.floor(min / 60);
  if (hr < 24) { return `${hr}h ago`; }
  return `${Math.floor(hr / 24)}d ago`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) { return ''; }
  if (ms < 1000) { return `${ms}ms`; }
  if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export default defineCommand<unknown, CLIInput<RunsListFlags>, unknown>({
  id: 'workflow:runs-list',
  description: 'List workflow runs',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsListFlags>): Promise<CommandResult> {
      const flags = input.flags;
      const outputJson = flags?.json ?? false;
      const limit = flags?.limit ?? 20;

      try {
        const client = new WorkflowDaemonClient();
        const runs = await client.listRuns({
          status: flags?.status,
          limit: Number(limit) || 20,
          workflowId: flags?.workflow,
        });

        if (outputJson) {
          return runs;
        }

        if (runs.length === 0) {
          ctx.ui?.info?.('No runs found');
          return undefined;
        }

        ctx.ui?.table?.(
          runs.map(run => {
            const displayStatus = run.hasPendingApproval ? 'waiting_approval' : run.status;
            return {
              ' ': STATUS_ICON[displayStatus] ?? '?',
              'Workflow': run.name,
              'Trigger': run.trigger?.type ?? 'manual',
              'When': relativeTime(run.startedAt ?? run.createdAt),
              'Status': displayStatus.toUpperCase().replace(/_/g, ' '),
              'Step': run.status === 'running' && run.currentStepName ? run.currentStepName : '',
              'Dur': formatDuration(run.durationMs),
              'ID': run.id.slice(0, 8),
            };
          }),
          [
            { header: ' ', key: ' ', width: 1 },
            { header: 'Workflow', key: 'Workflow' },
            { header: 'Trigger', key: 'Trigger' },
            { header: 'When', key: 'When' },
            { header: 'Status', key: 'Status' },
            { header: 'Step', key: 'Step' },
            { header: 'Dur', key: 'Dur' },
            { header: 'ID', key: 'ID' },
          ],
        );
        ctx.ui?.success?.(`${runs.length} run(s)`);

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
