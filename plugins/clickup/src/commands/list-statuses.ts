import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, getListStatuses } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type ListStatusesFlags = { json?: boolean; full?: boolean };

export default defineCommand({
  id: 'clickup:list.statuses',
  description: 'List available statuses for a list',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ListStatusesFlags>) {
      const [listId] = input.argv;
      if (!listId) {
        return validationError('List ID is required', 'Usage: kb clickup status list <listId>  (get IDs via `kb clickup workspace show`)');
      }

      try {
        const statuses = await getListStatuses(requireApiKey(), listId);

        if (input.flags.json) {
          return input.flags.full ? statuses : statuses.map(s => ({ status: s.status, type: s.type, color: s.color }));
        }

        ctx.ui?.table?.(
          statuses.map(s => ({ Status: s.status, Type: s.type, Color: s.color })),
          [
            { header: 'Status', key: 'Status' },
            { header: 'Type',   key: 'Type' },
            { header: 'Color',  key: 'Color' },
          ],
        );

        return statuses;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
