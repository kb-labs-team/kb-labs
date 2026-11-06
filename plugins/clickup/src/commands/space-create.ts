import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, requireTeamId, createSpace } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type SpaceCreateFlags = {
  name: string;
  color?: string;
  private?: boolean;
  json?: boolean;
  full?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:space.create',
  description: 'Create a new space',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<SpaceCreateFlags>) {
      const { name } = input.flags;
      return {
        summary: `Create space "${name ?? '(unnamed)'}"`,
        operations: [{ type: 'create' as const, resource: 'space', details: { name } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<SpaceCreateFlags>) {
      const { name, color, json, full } = input.flags;
      if (!name) {
        return validationError('--name is required');
      }

      try {
        const space = await createSpace(requireApiKey(), requireTeamId(), {
          name,
          color,
          private: input.flags.private ?? false,
        });

        if (json) {
          return full ? space : { id: space.id, name: space.name };
        } else {
          ctx.ui?.success?.('Space created', {
            sections: [{ items: [`id: ${space.id}`, `name: ${space.name}`] }],
          });
        }

        return space;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
