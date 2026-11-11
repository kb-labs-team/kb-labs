import { defineCommand, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';

export default defineCommand<unknown, { flags?: { json?: boolean } }, unknown>({
  id: 'workflow:crons-list',
  description: 'List project and plugin workflow schedules',
  handler: {
    async execute(ctx: PluginCommandContextV3, input): Promise<CommandResult> {
      const outputJson = input.flags?.json ?? false;
      try {
        const result = await new WorkflowDaemonClient().getCronJobs();
        if (outputJson) {
          return result;
        } else if (result.crons.length === 0) {
          ctx.ui?.warn?.('No workflow crons found. Create one in .kb/crons/<id>.yml, then run: kb workflow crons list');
        } else {
          ctx.ui?.table?.(result.crons.map((cron) => ({
            id: cron.id,
            source: cron.source,
            schedule: cron.schedule,
            target: 'workflow' in cron.target ? cron.target.workflow : cron.target.handler,
            enabled: cron.enabled ? 'yes' : 'no',
            lastRun: cron.lastRun?.status ?? '-',
            nextFire: cron.nextFireAt ?? '-',
          })), [
            { header: 'ID', key: 'id' }, { header: 'Source', key: 'source' },
            { header: 'Schedule', key: 'schedule' }, { header: 'Target', key: 'target' },
            { header: 'Enabled', key: 'enabled' }, { header: 'Last run', key: 'lastRun' },
            { header: 'Next fire', key: 'nextFire' },
          ]);
        }
        if (!outputJson) {
          for (const error of result.errors) { ctx.ui?.warn?.(`${error.file}: ${error.reason}`); }
        }
        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
