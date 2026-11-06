import { defineCommand, handleError, type PluginCommandContextV3, type CLIInput, type CommandResult } from '@kb-labs/sdk';
import { WorkflowDaemonClient, WorkflowDaemonError } from '../http-client.js';
import { workflowCommandError } from './errors.js';

export interface CronEnabledFlags { json?: boolean }

export function createCronEnabledCommand(enabled: boolean) {
  const action = enabled ? 'enable' : 'disable';
  return defineCommand<unknown, CLIInput<CronEnabledFlags>, unknown>({
    id: `workflow:crons-${action}`,
    description: `${enabled ? 'Enable' : 'Disable'} a project workflow cron`,
    handler: {
      async execute(ctx: PluginCommandContextV3, input): Promise<CommandResult<{ id: string; enabled: boolean }>> {
        const id = input.argv?.[0];
        const outputJson = input.flags?.json ?? false;
        if (!id) {
          return workflowCommandError('KB_RUNTIME_INPUT_INVALID', 'Missing cron ID.', `Run kb workflow crons ${action} --help to see the required arguments.`, { details: { field: 'id' } });
        }
        try {
          const result = await new WorkflowDaemonClient().setCronEnabled(id, enabled);
          if (!outputJson) ctx.ui?.success?.(`Cron ${id} ${enabled ? 'enabled' : 'disabled'}`);
          return { id, ...result };
        } catch (error) {
          if (error instanceof WorkflowDaemonError && error.code === 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY' && error.hint) {
            return workflowCommandError(
              'KB_RUNTIME_CRON_PLUGIN_READ_ONLY',
              error.message,
              error.hint,
              {},
            );
          }
          return handleError(error);
        }
      },
    },
  });
}
