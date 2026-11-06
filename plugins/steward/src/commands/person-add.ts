import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addPerson } from '../core/index.js';
import { parseList } from '../utils/flags.js';

type Flags = { name?: string; topics?: string; company?: string; json?: boolean };

export default defineCommand({
  id: 'steward:person.add',
  description: 'Add a contact. Returns a possibleDuplicates warning, not an error, on a name match',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { name, topics, company, json } = input.flags;
      if (!name?.trim()) {
        return validationError('--name is required');
      }

      try {
        const { person, possibleDuplicates } = await addPerson({
          name,
          contacts: [],
          companyId: company,
          globalTopics: parseList(topics) ?? [],
        });

        if (json) {
          return { person, possibleDuplicates };
        } else {
          ctx.ui?.info?.(`Added "${person.name}" (${person.id})`);
          if (possibleDuplicates.length > 0) {
            ctx.ui?.warn?.(`Possible duplicate${possibleDuplicates.length > 1 ? 's' : ''}: ${possibleDuplicates.map((p) => p.id).join(', ')}`);
          }
        }
        return { person, possibleDuplicates };
      } catch (err) {
        ctx.platform.logger?.error?.('steward:person.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
