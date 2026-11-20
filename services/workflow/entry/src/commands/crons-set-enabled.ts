import { defineCommand, handleError, type PluginCommandContextV3, type CLIInput, type CommandResult } from '@kb-labs/sdk';
import { normalizeServiceCommandInput, setWorkflowCronEnabled, WorkflowServiceOperationError } from '@kb-labs/workflow-runtime';
import { workflowServiceCommands } from '@kb-labs/workflow-contracts/service-commands';
import { isErrorCode } from '@kb-labs/core-platform';
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
        const declaration = enabled ? workflowServiceCommands.commands.cronsEnable : workflowServiceCommands.commands.cronsDisable;
        const normalized = normalizeServiceCommandInput(declaration.invocation!, { argv: input.argv, flags: input.flags });
        if (!normalized.ok) {
          return workflowCommandError('KB_RUNTIME_INPUT_INVALID', normalized.message, `Run kb workflow crons ${action} --help to see the required arguments.`, { details: { field: normalized.field } });
        }
        try {
          const client = new WorkflowDaemonClient();
          const result = await setWorkflowCronEnabled(normalized.value, (request) => client.requestServiceOperation(request));
          if (!outputJson) {ctx.ui?.success?.(`Cron ${id} ${enabled ? 'enabled' : 'disabled'}`);}
          return result;
        } catch (error) {
          if (error instanceof WorkflowServiceOperationError && isErrorCode(error.code)) {
            if (error.code === 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY' && error.hint) {
              return workflowCommandError(
                'KB_RUNTIME_CRON_PLUGIN_READ_ONLY',
                error.message,
                error.hint,
                {},
              );
            }
            return handleError(new WorkflowDaemonError(error.code, error.message, error.hint));
          }
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
