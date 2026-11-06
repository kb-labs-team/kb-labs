import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { listTopics } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:topic.list',
  description: 'List the topic dictionary',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { json } = input.flags;
      try {
        const topics = await listTopics();
        if (json) {return topics;}
        else if (topics.length === 0) {ctx.ui?.info?.('No topics registered yet.');}
        else {ctx.ui?.chain?.(topics.map((t) => ({ title: t.name, sections: [{ items: [t.aliases.join(', ') || '(no aliases)'] }] })));}
        return topics;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:topic.list failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
