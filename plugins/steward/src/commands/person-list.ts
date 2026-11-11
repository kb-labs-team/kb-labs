import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { listPeople } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:person.list',
  description: 'List every known contact',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { json } = input.flags;
      try {
        const people = await listPeople();
        if (json) {return people;}
        else if (people.length === 0) {ctx.ui?.info?.('No contacts yet.');}
        else {ctx.ui?.chain?.(people.map((p) => ({ title: p.name, sections: [{ items: [p.globalTopics.join(', ') || '(no topics)'] }] })));}
        return people;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:person.list failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
