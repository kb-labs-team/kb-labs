import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addCompany } from '../core/index.js';

type Flags = { name?: string; json?: boolean };

export default defineCommand({
  id: 'steward:company.add',
  description: 'Add a company (thin — just a name to link people to)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { name, json } = input.flags;
      if (!name?.trim()) {
        return validationError('--name is required');
      }

      try {
        const company = await addCompany({ name });
        if (json) {return company;}
        else {ctx.ui?.info?.(`Added company "${company.name}" (${company.id})`);}
        return company;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:company.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
