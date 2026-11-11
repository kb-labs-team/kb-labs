import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { updatePerson } from '../core/index.js';
import { parseList } from '../utils/flags.js';

type Flags = { name?: string; topics?: string; company?: string; json?: boolean };

export default defineCommand({
  id: 'steward:person.update',
  description: "Update a contact's name, topics, or company",

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [id] = input.argv;
      const { name, topics, company, json } = input.flags;
      if (!id) {
        return validationError('id is required', 'Usage: kb steward person update <id> [--name] [--topics] [--company]');
      }

      try {
        const person = await updatePerson({ id, name, globalTopics: parseList(topics), companyId: company });
        if (!person) {
          return { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: `No person "${id}"`, hint: "Run `kb steward person update --help` to review the failure and next steps." } };
        }

        if (json) {return person;}
        else {ctx.ui?.info?.(`Updated "${person.name}"`);}
        return person;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:person.update failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
