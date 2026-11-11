import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { whoToContact } from '../core/index.js';

type Flags = { project?: string; json?: boolean };

export default defineCommand({
  id: 'steward:who',
  description: 'Find who to contact about a topic, with project-scoped priority and a global fallback',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [topic] = input.argv;
      const { project, json } = input.flags;
      if (!topic?.trim()) {
        return validationError('topic is required', 'Usage: kb steward person search <topic> [--project=]');
      }

      try {
        const candidates = await whoToContact({ topic, projectId: project });
        if (json) {
          return candidates;
        } else if (candidates.length === 0) {
          ctx.ui?.info?.(`Nobody found for "${topic}".`);
        } else {
          ctx.ui?.chain?.(
            candidates.map((c, i) => ({
              title: `${i + 1}. ${c.person.name} (${c.source}${c.priority !== undefined ? `, priority ${c.priority}` : ''})`,
              sections: [{ items: [c.person.contacts.map((ct) => `${ct.channel}:${ct.value}`).join(', ') || '(no contacts)'] }],
            })),
          );
        }
        return candidates;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:who failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
