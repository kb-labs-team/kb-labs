import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, deleteList } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type ListDeleteFlags = {
  force?: boolean;
  json?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:list.delete',
  description: 'Delete a list',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<ListDeleteFlags>) {
      const [listId] = input.argv;
      return {
        summary: `Delete list ${listId ?? '(unknown)'}`,
        operations: [{ type: 'delete' as const, resource: 'list', details: { listId } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<ListDeleteFlags>) {
      const listId = input.argv[0] as string | undefined;
      if (!listId) {
        return validationError('listId is required', 'Usage: kb clickup list delete <listId> --force');
      }
      if (!input.flags.force) {
        return validationError(`--force is required to delete list ${listId}`, 'Add --force to confirm deletion');
      }

      try {
        await deleteList(requireApiKey(), listId);

        if (input.flags.json) {
          return { deleted: true, listId };
        } else {
          ctx.ui?.success?.(`Deleted list ${listId}`);
        }

        return { deleted: true, listId };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
