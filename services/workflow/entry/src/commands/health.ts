/**
 * workflow:health command - Check daemon health
 */

import { defineCommand, handleError, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { type HealthFlags } from '@kb-labs/workflow-contracts';
import { WorkflowDaemonClient } from '../http-client.js';

type HealthInput = HealthFlags & { argv?: string[]; flags?: HealthFlags };

export default defineCommand<unknown, HealthInput, unknown>({
  id: 'workflow:health',
  description: 'Check workflow daemon health status',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: HealthInput): Promise<CommandResult> {
      const flags = input.flags ?? input;
      const outputJson = flags.json ?? false;

      try {
        const client = new WorkflowDaemonClient();
        const health = await client.health();

        if (outputJson) {
          return health;
        } else if (health.status === 'ok') {
          ctx.ui?.success?.('Daemon is healthy', {
            title: 'Workflow Daemon',
            sections: [
              {
                header: 'Status',
                items: [`Service: ${health.service}`, 'Health: OK'],
              },
            ],
          });
        } else {
          ctx.ui?.warn?.('Workflow Daemon', {
            sections: [{
              header: 'Status',
              items: [`Service: ${health.service}`, `Health: ${health.status}`],
            }],
          });
        }

        return health;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
