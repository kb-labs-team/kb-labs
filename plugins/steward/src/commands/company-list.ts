import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { listCompanies } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:company.list',
  description: 'List companies',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { json } = input.flags;
      try {
        const companies = await listCompanies();
        if (json) {return companies;}
        else if (companies.length === 0) {ctx.ui?.info?.('No companies yet.');}
        else {ctx.ui?.chain?.(companies.map((c) => ({ title: c.name, sections: [{ items: [c.id] }] })));}
        return companies;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:company.list failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
