import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { getProject } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:project.get',
  description: 'Get a project card: status, resources, and members',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [idOrName] = input.argv;
      const { json } = input.flags;
      if (!idOrName) {
        return validationError('idOrName is required', 'Usage: kb steward project get <idOrName>');
      }

      try {
        const card = await getProject(idOrName);
        if (!card) {
          return { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: `No project matching "${idOrName}"`, hint: "Run `kb steward project get --help` to review the failure and next steps." } };
        }

        if (json) {
          return card;
        } else {
          ctx.ui?.info?.(`${card.project.name} [${card.project.status}] — ${card.resources.length} resources, ${card.members.length} members`);
        }
        return card;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:project.get failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
