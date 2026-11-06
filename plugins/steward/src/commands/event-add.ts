import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addEvent } from '../core/index.js';

type Flags = { 'subject-type'?: string; 'subject-id'?: string; text?: string; kind?: string; json?: boolean };

const SUBJECT_TYPES = ['project', 'person', 'commitment', 'company', 'resource'] as const;

export default defineCommand({
  id: 'steward:event.add',
  description: 'Record a manual note against a project, person, or commitment — the primary tool for backfill import',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const subjectType = input.flags['subject-type'];
      const subjectId = input.flags['subject-id'];
      const { text, kind, json } = input.flags;

      if (!subjectType || !SUBJECT_TYPES.includes(subjectType as (typeof SUBJECT_TYPES)[number])) {
        return validationError(`--subject-type must be one of: ${SUBJECT_TYPES.join(', ')}`);
      }
      if (!subjectId) {
        return validationError('--subject-id is required');
      }

      try {
        const event = await addEvent({
          subjectType: subjectType as (typeof SUBJECT_TYPES)[number],
          subjectId,
          text,
          kind: kind ?? 'note',
        });
        if (json) {return event;}
        else {ctx.ui?.info?.(`Recorded event "${event.kind}" on ${subjectType}:${subjectId}`);}
        return event;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:event.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
