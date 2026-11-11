import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, deleteSpace } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type SpaceDeleteFlags = {
  force?: boolean;
  json?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:space.delete',
  description: 'Delete a space',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<SpaceDeleteFlags>) {
      const [spaceId] = input.argv;
      return {
        summary: `Delete space ${spaceId ?? '(unknown)'}`,
        operations: [{ type: 'delete' as const, resource: 'space', details: { spaceId } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<SpaceDeleteFlags>) {
      const spaceId = input.argv[0] as string | undefined;
      if (!spaceId) {
        return validationError('spaceId is required', 'Usage: kb clickup space delete <spaceId> --force');
      }
      if (!input.flags.force) {
        return validationError(`--force is required to delete space ${spaceId}`, 'Add --force to confirm deletion');
      }

      try {
        await deleteSpace(requireApiKey(), spaceId);

        if (input.flags.json) {
          return { deleted: true, spaceId };
        } else {
          ctx.ui?.success?.(`Deleted space ${spaceId}`);
        }

        return { deleted: true, spaceId };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
