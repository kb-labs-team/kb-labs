import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, createFolder } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type FolderCreateFlags = {
  space: string;
  name: string;
  json?: boolean;
  full?: boolean;
};

export default defineCommand({
  id: 'clickup:folder.create',
  description: 'Create a new folder in a space',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<FolderCreateFlags>) {
      const { space, name } = input.flags;
      return {
        summary: `Create folder "${name ?? '(unnamed)'}" in space ${space ?? '(unknown)'}`,
        operations: [{ type: 'create' as const, resource: 'folder', details: { space, name } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<FolderCreateFlags>) {
      const { space, name, json, full } = input.flags;
      if (!space) {
        return validationError('--space is required', 'Use `kb clickup workspace show` to find the space ID');
      }
      if (!name) {
        return validationError('--name is required');
      }

      try {
        const folder = await createFolder(requireApiKey(), space, { name });

        if (json) {
          return full ? folder : { id: folder.id, name: folder.name };
        } else {
          ctx.ui?.success?.('Folder created', {
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
