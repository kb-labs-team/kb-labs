import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, updateFolder } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type FolderUpdateFlags = {
  name: string;
  json?: boolean;
  full?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:folder.update',
  description: 'Rename a folder',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<FolderUpdateFlags>) {
      const [folderId] = input.argv;
      return {
        summary: `Rename folder ${folderId ?? '(unknown)'} to "${input.flags.name ?? '(unnamed)'}"`,
        operations: [{ type: 'update' as const, resource: 'folder', details: { folderId, name: input.flags.name } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<FolderUpdateFlags>) {
      const folderId = input.argv[0] as string | undefined;
      if (!folderId) {
        return validationError('folderId is required', 'Usage: kb clickup folder update <folderId> --name "new name"');
      }
      if (!input.flags.name) {
        return validationError('--name is required');
      }

      try {
        const folder = await updateFolder(requireApiKey(), folderId, { name: input.flags.name });

        if (input.flags.json) {
          return input.flags.full ? folder : { id: folder.id, name: folder.name };
        } else {
          ctx.ui?.success?.('Folder updated', {
            sections: [{ items: [`id: ${folder.id}`, `name: ${folder.name}`] }],
          });
        }

        return folder;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
