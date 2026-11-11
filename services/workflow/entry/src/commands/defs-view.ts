/**
 * workflow:defs-view <id> command — view a single workflow definition's details
 */

import { defineCommand, validationError, handleError, type CLIInput, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';
import type { DefsViewFlags } from '@kb-labs/workflow-contracts';

export default defineCommand<unknown, CLIInput<DefsViewFlags>, unknown>({
  id: 'workflow:defs-view',
  description: 'View workflow definition details',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<DefsViewFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const outputJson = flags?.json ?? false;
      const id = flags?.id ?? argv[0];

      if (!id) {
        return validationError('Missing workflow ID', 'Usage: kb workflow defs view <id> [--id=<id>]');
      }

      try {
        const client = new WorkflowDaemonClient();
        const workflow = await client.getWorkflow(id);

        if (outputJson) {
          return workflow;
        }

        const summary: string[] = [
          `Source:  ${workflow.source}`,
        ];
        if (workflow.status) { summary.push(`Status:  ${workflow.status}`); }
        if (workflow.description) { summary.push(`Description: ${workflow.description}`); }
        if (workflow.tags?.length) { summary.push(`Tags:    ${workflow.tags.join(', ')}`); }
        if (workflow.version) { summary.push(`Version: ${workflow.version}`); }
        if (workflow.pluginId) { summary.push(`Plugin:  ${workflow.pluginId}`); }
        if (workflow.updatedAt) { summary.push(`Updated: ${workflow.updatedAt}`); }

        const sections: Array<{ header: string; items: string[] }> = [
          { header: workflow.name, items: summary },
        ];

        const inputs = workflow.inputs;
        if (inputs && Object.keys(inputs).length > 0) {
          sections.push({
            header: 'Inputs',
            items: Object.entries(inputs).map(([name, spec]) => {
              const required = spec.required ? ' (required)' : '';
              const def = spec.default !== undefined ? ` [default: ${JSON.stringify(spec.default)}]` : '';
              const desc = spec.description ? ` — ${spec.description}` : '';
              return `${name}: ${spec.type}${required}${def}${desc}`;
            }),
          });
        }

        ctx.ui?.sideBox?.({
          title: id,
          status: 'success',
          sections,
        });

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
