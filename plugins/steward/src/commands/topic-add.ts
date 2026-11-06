import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addTopic } from '../core/index.js';
import { parseList } from '../utils/flags.js';

type Flags = { name?: string; aliases?: string; json?: boolean };

export default defineCommand({
  id: 'steward:topic.add',
  description: 'Register a topic with aliases in the routing dictionary — do this deliberately, not automatically',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { name, aliases, json } = input.flags;
      if (!name?.trim()) {
        return validationError('--name is required');
      }

      try {
        const topic = await addTopic({ name, aliases: parseList(aliases) ?? [] });
        if (json) {return topic;}
        else {ctx.ui?.info?.(`Registered topic "${topic.name}" (aliases: ${topic.aliases.join(', ') || 'none'})`);}
        return topic;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:topic.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
