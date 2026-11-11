import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, createListInFolder, createListInSpace } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type ListCreateFlags = {
  folder?: string;
  space?: string;
  name: string;
  json?: boolean;
  full?: boolean;
  'dry-run'?: boolean;
};

export default defineCommand({
  id: 'clickup:list.create',
  description: 'Create a new list in a folder or space',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<ListCreateFlags>) {
      const { folder, space, name } = input.flags;
      const parent = folder ? `folder ${folder}` : space ? `space ${space}` : '(unknown)';
      return {
        summary: `Create list "${name}" in ${parent}`,
        operations: [{ type: 'create' as const, resource: 'list', details: { folder, space, name } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<ListCreateFlags>) {
      const { folder, space, name, json, full } = input.flags;
      if (!name) {
        return validationError('--name is required');
      }
      if (!folder && !space) {
        return validationError('--folder or --space is required', 'Use `kb clickup workspace show` to find IDs');
      }

      try {
        const apiKey = requireApiKey();
        const list = folder
          ? await createListInFolder(apiKey, folder, { name })
          : await createListInSpace(apiKey, space!, { name });

        if (json) {
          return full ? list : { id: list.id, name: list.name };
        } else {
          ctx.ui?.success?.('List created', {
            sections: [{ items: [`id: ${list.id}`, `name: ${list.name}`] }],
          });
        }

        return list;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
