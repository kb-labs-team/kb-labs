import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, deleteFolder } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type FolderDeleteFlags = {
  force?: boolean;
  json?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:folder.delete',
  description: 'Delete a folder',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<FolderDeleteFlags>) {
      const [folderId] = input.argv;
      return {
        summary: `Delete folder ${folderId ?? '(unknown)'}`,
        operations: [{ type: 'delete' as const, resource: 'folder', details: { folderId } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<FolderDeleteFlags>) {
      const folderId = input.argv[0] as string | undefined;
      if (!folderId) {
        return validationError('folderId is required', 'Usage: kb clickup folder delete <folderId> --force');
      }
      if (!input.flags.force) {
        return validationError(`--force is required to delete folder ${folderId}`, 'Add --force to confirm deletion');
      }

      try {
        await deleteFolder(requireApiKey(), folderId);

        if (input.flags.json) {
          return { deleted: true, folderId };
        } else {
          ctx.ui?.success?.(`Deleted folder ${folderId}`);
        }

        return { deleted: true, folderId };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
