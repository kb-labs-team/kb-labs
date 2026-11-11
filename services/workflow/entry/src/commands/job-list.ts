/**
 * workflow job list command — list active raw jobs
 */

import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';

export interface JobListFlags {
  json?: boolean;
  status?: string;
}

export default defineCommand<unknown, CLIInput<JobListFlags>, unknown>({
  id: 'workflow:job-list',
  description: 'List active raw jobs',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<JobListFlags>): Promise<CommandResult> {
      const outputJson = input.flags?.json ?? false;
      const statusFilter = input.flags?.status;

      try {
        const client = new WorkflowDaemonClient();
        const jobs = await client.getExecutions();
        const filteredJobs = statusFilter ? jobs.filter((job) => job.status === statusFilter) : jobs;

        if (outputJson) {
          return { jobs: filteredJobs };
        } else if (filteredJobs.length === 0) {
          ctx.ui?.warn?.('No active jobs found');
        } else {
          ctx.ui?.table?.(
            filteredJobs.map((job) => ({ id: job.id, status: job.status, started: job.startedAt ?? 'N/A' })),
            [
              { header: 'ID', key: 'id' },
              { header: 'Status', key: 'status' },
              { header: 'Started', key: 'started' },
            ],
          );
          ctx.ui?.success?.(`${filteredJobs.length} active job${filteredJobs.length === 1 ? '' : 's'}`);
        }

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
