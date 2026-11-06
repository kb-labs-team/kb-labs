import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addCommitment } from '../core/index.js';
import { parseDate } from '../utils/flags.js';

type Flags = {
  text?: string;
  person?: string;
  project?: string;
  'remind-at'?: string;
  'stale-after-days'?: number;
  json?: boolean;
};

export default defineCommand({
  id: 'steward:commitment.add',
  description: 'Record a promise made to a person, with an optional soft reminder date',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { text, person, project, json } = input.flags;
      const remindAtRaw = input.flags['remind-at'];
      const staleAfterDays = input.flags['stale-after-days'];
      if (!text?.trim()) {
        return validationError('--text is required');
      }

      try {
        const commitment = await addCommitment({
          text,
          personId: person,
          projectId: project,
          remindAt: remindAtRaw ? parseDate(remindAtRaw) : undefined,
          staleAfterDays: staleAfterDays !== undefined ? Number(staleAfterDays) : 14,
        });
        if (json) {return commitment;}
        else {ctx.ui?.info?.(`Recorded commitment "${commitment.text}" (${commitment.id})`);}
        return commitment;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:commitment.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
