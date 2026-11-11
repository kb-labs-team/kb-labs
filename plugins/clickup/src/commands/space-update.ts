import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, updateSpace } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type SpaceUpdateFlags = {
  name?: string;
  color?: string;
  json?: boolean;
  full?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:space.update',
  description: 'Update a space',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<SpaceUpdateFlags>) {
      const [spaceId] = input.argv;
      const skipKeys = new Set(['json', 'full', 'dry-run']);
      const changes = Object.entries(input.flags)
        .filter(([k, v]) => !skipKeys.has(k) && v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      return {
        summary: `Update space ${spaceId ?? '(unknown)'}`,
        operations: [{ type: 'update' as const, resource: 'space', details: { spaceId, changes } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<SpaceUpdateFlags>) {
      const spaceId = input.argv[0] as string | undefined;
      if (!spaceId) {
        return validationError('spaceId is required', 'Usage: kb clickup space update <spaceId> --name "new name"');
      }

      const { name, color, json, full } = input.flags;

      try {
        const space = await updateSpace(requireApiKey(), spaceId, { name, color });

        if (json) {
          return full ? space : { id: space.id, name: space.name };
        } else {
          ctx.ui?.success?.('Space updated', {
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
